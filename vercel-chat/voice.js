import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ASSET_DIR = resolve(process.cwd(), 'assets/voice');
const CLIP_BY_KIND = Object.freeze({
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

function amountWords(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? `₹${n.toFixed(2).replace(/\.00$/, '')}` : '';
}

export function buildHinglishVoiceScript(kind, data = {}) {
  switch (kind) {
    case 'join': return 'Pehle hamara channel join kar lo. Join ke baad check joined button dabana.';
    case 'start': return 'Swiggy cart ka link aur delivery address ka link bhej do. Dono milte hi bill check karke chat me dunga.';
    case 'address': return 'Address link mil gaya. Ab cart ka Swiggy share link bhej do.';
    case 'bill': return `Tumhara bill ready hai. Final amount ${amountWords(data.amount)} hai. Items aur hisaab chat me check karo; sab sahi ho tabhi confirm dabana.`;
    case 'confirm': return `Bill ${amountWords(data.amount)} ke liye confirm hua. Ab payment setup check kar raha hoon.`;
    case 'qr': return `Authentic payment QR chat me hai. UPI se ${amountWords(data.amount)} pay karo, phir payment check button dabana.`;
    case 'pending': return 'Payment abhi verify nahi hua. Status pending hai; thodi der baad payment check karo. Bina Swiggy confirmation ke paid nahi bolunga.';
    case 'paid': return 'Payment Swiggy se verify ho gaya. Ab order status aur tracking link check kar raha hoon.';
    case 'tracking': return 'Swiggy ka asli tracking link chat me bhej diya hai. Wahi link khol kar order dekho.';
    case 'cancel': return 'Checkout cancel kar diya. Abhi order place nahi hua aur cart phir se try kar sakte ho.';
    case 'wallet': return `Wallet free hai. Abhi complimentary balance ${amountWords(data.balance || 0)} hai. Koi deposit ya payment nahi chahiye.`;
    case 'error': return `Abhi ${String(data.reason || 'request')}. Chat me diya hua error dekh lo; zaroorat hui to wahi input dobara bhejna.`;
    case 'leaderboard': return 'Leaderboard chat me hai. Sirf payment-confirmed orders count hote hain.';
    case 'profile': return 'Tumhari ID aur order stats chat me dikh rahe hain. Private details kisi aur ko nahi dikhengi.';
    case 'orders': return 'Tumhare orders chat me hain. Kisi aur user ke orders yahan nahi aayenge.';
    case 'stern': return 'Arre, pehle bill dhyan se check karo. Sab sahi ho tabhi confirm dabana. Amount badla ho to naya bill dekho.';
    default: return 'Naya update chat me bheja hai. Message dekh kar sahi button dabao.';
  }
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function synthesizeWithGoogle(text, { apiKey, voiceName, fetchImpl }) {
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  timer.unref?.();
  try {
    const response = await fetchImpl(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        input: { ssml: `<speak>${escapeXml(text)}</speak>` },
        voice: { languageCode: 'hi-IN', name: voiceName },
        audioConfig: { audioEncoding: 'OGG_OPUS', speakingRate: 1 }
      }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    return typeof payload?.audioContent === 'string' ? Buffer.from(payload.audioContent, 'base64') : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export function createVoiceService({
  telegram,
  apiKey = process.env.GOOGLE_TTS_API_KEY || '',
  voiceName = process.env.GOOGLE_TTS_VOICE || 'hi-IN-Neural2-A',
  fetchImpl = globalThis.fetch,
  logger = console
} = {}) {
  const clipCache = new Map();
  async function fallbackClip(kind) {
    const file = CLIP_BY_KIND[kind] || CLIP_BY_KIND.generic;
    if (!clipCache.has(file)) {
      clipCache.set(file, readFile(resolve(ASSET_DIR, file)).catch(() => null));
    }
    return clipCache.get(file);
  }

  return async function sendVoice(chatId, kind, data = {}) {
    const script = buildHinglishVoiceScript(kind, data);
    let audio = await synthesizeWithGoogle(script, { apiKey, voiceName, fetchImpl });
    let filename = 'reply.ogg';
    if (!audio?.length) {
      audio = await fallbackClip(kind);
      filename = CLIP_BY_KIND[kind] || CLIP_BY_KIND.generic;
    }
    if (!audio?.length) {
      logger.warn?.('[VercelVoice] No voice asset available:', kind);
      return false;
    }
    try {
      await telegram.sendVoice(chatId, audio, filename);
      return true;
    } catch {
      // Written text has already been delivered; speech failure never retries an order.
      logger.warn?.('[VercelVoice] Telegram voice delivery failed:', kind);
      return false;
    }
  };
}
