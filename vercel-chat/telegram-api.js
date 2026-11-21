export class TelegramApiError extends Error {
  constructor(code = 'TELEGRAM_API_ERROR', message = 'Telegram API request failed.') {
    super(message);
    this.name = 'TelegramApiError';
    this.code = code;
  }
}

export function createTelegramClient({ token = process.env.BOT_TOKEN || '', fetchImpl = globalThis.fetch } = {}) {
  const botToken = String(token || '').trim();
  if (!botToken) throw new TelegramApiError('BOT_NOT_CONFIGURED', 'Telegram bot token is not configured.');

  async function call(method, payload = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    timer.unref?.();
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok !== true) {
        const code = Number(data?.error_code || response.status) === 429 ? 'TELEGRAM_RATE_LIMIT' : 'TELEGRAM_API_ERROR';
        throw new TelegramApiError(code, 'Telegram could not process the request.');
      }
      return data.result;
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      throw new TelegramApiError(controller.signal.aborted ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_NETWORK_ERROR', 'Could not reach Telegram.');
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendMedia(method, chatId, fieldName, buffer, filename, options = {}) {
    if (!(buffer instanceof Uint8Array) || buffer.byteLength === 0) throw new TelegramApiError('EMPTY_MEDIA', 'No valid media was available.');
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set(fieldName, new Blob([buffer]), filename);
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || value === null) continue;
      form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref?.();
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST', body: form, signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok !== true) {
        const code = Number(data?.error_code || response.status) === 429 ? 'TELEGRAM_RATE_LIMIT' : 'TELEGRAM_MEDIA_ERROR';
        throw new TelegramApiError(code, 'Telegram could not deliver the voice or image.');
      }
      return data.result;
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      throw new TelegramApiError(controller.signal.aborted ? 'TELEGRAM_TIMEOUT' : 'TELEGRAM_NETWORK_ERROR', 'Could not deliver media through Telegram.');
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    call,
    getChatMember: (chatId, userId) => call('getChatMember', { chat_id: chatId, user_id: userId }),
    sendMessage: (chatId, text, options = {}) => call('sendMessage', {
      chat_id: chatId,
      text: String(text || '').slice(0, 4096),
      disable_web_page_preview: true,
      ...options
    }),
    answerCallbackQuery: (callbackQueryId, text = '') => call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text: String(text).slice(0, 180) } : {})
    }),
    sendVoice: (chatId, buffer, filename = 'voice.mp3', caption = '') => sendMedia('sendVoice', chatId, 'voice', buffer, filename, caption ? { caption: String(caption).slice(0, 900) } : {}),
    sendPhoto: (chatId, buffer, filename = 'payment-qr.png', caption = '', replyMarkup = null) => sendMedia('sendPhoto', chatId, 'photo', buffer, filename, {
      ...(caption ? { caption: String(caption).slice(0, 900), parse_mode: 'HTML' } : {}),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {})
    })
  });
}
