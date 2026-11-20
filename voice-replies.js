import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const AUDIO_DIR = new URL('./assets/voice/', import.meta.url);
const CLIP_FILES = Object.freeze({
  join: 'join-channel.mp3',
  start: 'start-links.mp3',
  address: 'address-needed.mp3',
  bill: 'bill-ready.mp3',
  qr: 'payment-qr.mp3',
  pending: 'payment-pending.mp3',
  tracking: 'tracking-ready.mp3',
  stern: 'voice-stern.mp3',
  generic: 'generic-update.mp3'
});

const voiceToneByChat = new Map();
const voiceClips = new Map();
for (const [name, file] of Object.entries(CLIP_FILES)) {
  try { voiceClips.set(name, readFileSync(fileURLToPath(new URL(file, AUDIO_DIR)))); }
  catch { /* voice is disabled safely if a packaged clip is absent */ }
}

function normalizeText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/https?:\/\/[^\s<>]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Return a pre-generated Hindi voice clip key for a message. */
export function selectVoiceClip(text, mood = 'normal') {
  const clean = normalizeText(text);
  if (/join.{0,30}channel|channel.{0,30}join|check joined|चैनल.{0,20}जॉइन/.test(clean)) return 'join';
  if (/assalamu|welcome.{0,30}(cart|address)|cart.{0,20}link.{0,30}address.{0,20}link|कार्ट का लिंक/.test(clean)) return 'start';
  if (/no tracking link|tracking link not|tracking unavailable/.test(clean)) return 'generic';
  if (/out for delivery|delivered|tracking link|payment verified.{0,30}tracking|ट्रैकिंग लिंक/.test(clean)) return 'tracking';
  if (/payment.{0,30}(pending|not verified|check|verify)|not paid|verify.{0,20}payment|पेमेंट अभी/.test(clean)) return 'pending';
  if (/\bqr\b.{0,30}(ready|chat|attached|generated)|scan.{0,20}qr|payment qr|पेमेंट क्यूआर/.test(clean)) return 'qr';
  if (/bill.{0,25}(ready|prepared|confirm|check)|to pay|total payable|bill amount|बिल.{0,20}(तैयार|चेक)/.test(clean)) {
    return mood === 'stern' ? 'stern' : 'bill';
  }
  if (/(send|paste|share|provide|need|required).{0,35}address.{0,25}link|address.{0,25}link.{0,25}(send|paste|share|bhejo|bhejein|needed|required)|एड्रेस.{0,25}लिंक.{0,20}(भेजो|भेजें)/.test(clean)) return 'address';
  return mood === 'stern' ? 'stern' : 'generic';
}

export function getVoiceTone(chatId) {
  return voiceToneByChat.get(String(chatId || '')) === 'stern' ? 'stern' : 'normal';
}

export function toggleVoiceTone(chatId) {
  const key = String(chatId || '');
  const next = getVoiceTone(key) === 'stern' ? 'normal' : 'stern';
  voiceToneByChat.set(key, next);
  return next;
}

function privateCustomerChat(chatId, isBoss) {
  const id = String(chatId ?? '');
  return /^\d{4,}$/.test(id) && !isBoss?.(id);
}

/**
 * Pair every private customer text/card/media-caption reply with a fixed,
 * prerecorded Hindi voice note. No message text, user data, or TTS key is sent
 * to an external speech service. Per-chat queues preserve the message order.
 */
export function installTelegramVoiceReplies(telegram, {
  isBoss = () => false,
  logger = console
} = {}) {
  if (!telegram || typeof telegram.sendMessage !== 'function' || voiceClips.size !== Object.keys(CLIP_FILES).length) {
    return { enabled: false, uninstall() {} };
  }
  const originals = new Map();
  for (const method of ['sendMessage', 'editMessageText', 'sendPhoto', 'sendDocument', 'sendVideo', 'sendAnimation', 'editMessageCaption']) {
    if (typeof telegram[method] === 'function') originals.set(method, telegram[method].bind(telegram));
  }
  const queues = new Map();
  let disposed = false;

  const scheduleVoice = (chatId, text) => {
    if (disposed || !privateCustomerChat(chatId, isBoss) || !String(text || '').trim()) return;
    const id = String(chatId);
    const clipKey = selectVoiceClip(text, getVoiceTone(id));
    const audio = voiceClips.get(clipKey) || voiceClips.get('generic');
    const previous = queues.get(id) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => {
        if (disposed) return;
        return telegram.sendVoice(id, { source: audio, filename: `${clipKey}.mp3` });
      })
      .catch(error => logger.warn?.('[VoiceReply] Voice note skipped:', error?.code || 'TELEGRAM_VOICE_ERROR'));
    queues.set(id, next);
    void next.finally(() => { if (queues.get(id) === next) queues.delete(id); });
  };

  telegram.sendMessage = async (...args) => {
    const result = await originals.get('sendMessage')(...args);
    scheduleVoice(args[0], args[1]);
    return result;
  };
  if (originals.has('editMessageText')) {
    telegram.editMessageText = async (...args) => {
      const result = await originals.get('editMessageText')(...args);
      scheduleVoice(args[0], args.length >= 4 ? args[3] : '');
      return result;
    };
  }
  for (const method of ['sendPhoto', 'sendDocument', 'sendVideo', 'sendAnimation', 'editMessageCaption']) {
    if (!originals.has(method)) continue;
    telegram[method] = async (...args) => {
      const result = await originals.get(method)(...args);
      const extra = args[2] && typeof args[2] === 'object' ? args[2] : {};
      const caption = method === 'editMessageCaption'
        ? (args.length >= 4 ? args[3] : '')
        : String(extra.caption || '');
      scheduleVoice(args[0], caption);
      return result;
    };
  }

  logger.info?.('[VoiceReply] Fixed Hindi voice notes enabled.');
  return {
    enabled: true,
    uninstall() {
      disposed = true;
      for (const [method, original] of originals) telegram[method] = original;
      queues.clear();
    }
  };
}
