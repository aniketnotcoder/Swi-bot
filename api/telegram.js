import { timingSafeEqual } from 'node:crypto';
import { createKv } from '../vercel-chat/kv.js';
import { readConfig } from '../vercel-chat/config.js';
import { createOrderBot } from '../vercel-chat/bot.js';
import { createTelegramClient } from '../vercel-chat/telegram-api.js';

const MAX_BODY_BYTES = 1024 * 1024;
const UPDATE_TTL_SECONDS = 60 * 60 * 24 * 7;
let runtime;

function getRuntime() {
  if (runtime) return runtime;
  const config = readConfig();
  if (!config.botToken || !config.webhookSecret || (config.orderFlowEnabled && !config.storelexKey)) {
    const error = new Error('Set BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET; STORELEX_USER_KEY is required only when VERCEL_ORDER_FLOW_ENABLED=true.');
    error.code = 'SERVICE_NOT_CONFIGURED';
    throw error;
  }
  const kv = createKv();
  if (!kv.configured) {
    const error = new Error('Persistent Vercel KV/Upstash REST credentials are missing.');
    error.code = 'PERSISTENCE_NOT_CONFIGURED';
    throw error;
  }
  const telegram = createTelegramClient({ token: config.botToken });
  const bot = createOrderBot({ config, kv, telegram });
  runtime = { config, kv, bot };
  return runtime;
}

function getHeader(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function constantTimeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
  res.setHeader?.('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function bodySize(req) {
  const length = Number(req.headers?.['content-length']);
  return Number.isFinite(length) && length > MAX_BODY_BYTES;
}

export default async function telegramWebhook(req, res) {
  if (req.method !== 'POST') {
    res.setHeader?.('Allow', 'POST');
    return send(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  if (bodySize(req)) return send(res, 413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });

  let services;
  try { services = getRuntime(); }
  catch (error) {
    const code = error?.code || 'SERVICE_NOT_CONFIGURED';
    console.error('[TelegramWebhook] unavailable:', code);
    return send(res, 503, { ok: false, error: code });
  }

  const supplied = getHeader(req, 'x-telegram-bot-api-secret-token');
  if (!constantTimeEqual(supplied, services.config.webhookSecret)) {
    return send(res, 401, { ok: false, error: 'UNAUTHORIZED' });
  }

  const update = req.body;
  if (update && typeof update === 'object' && Buffer.byteLength(JSON.stringify(update)) > MAX_BODY_BYTES) {
    return send(res, 413, { ok: false, error: 'PAYLOAD_TOO_LARGE' });
  }
  if (!update || typeof update !== 'object' || Array.isArray(update) || !Number.isSafeInteger(Number(update.update_id))) {
    return send(res, 400, { ok: false, error: 'INVALID_UPDATE' });
  }
  const updateId = String(update.update_id);
  try {
    await services.kv.initialize();
    const claimed = await services.kv.setJson(`telegram-update:${updateId}`, { receivedAt: Date.now() }, {
      nx: true,
      ttlSeconds: UPDATE_TTL_SECONDS
    });
    if (!claimed) return send(res, 200, { ok: true, duplicate: true });
    // Process before acknowledging Telegram. On infrastructure failure, delete
    // the claim so Telegram's retry can safely run; order placement has its own
    // durable per-draft lock and ambiguous results are never placed again.
    try {
      await services.bot.processUpdate(update);
    } catch (error) {
      await services.kv.del(`telegram-update:${updateId}`).catch(() => {});
      console.error('[TelegramWebhook] update processing failed:', String(error?.code || error?.name || 'PROCESSING_ERROR').slice(0, 80));
      return send(res, 503, { ok: false, error: 'UPDATE_PROCESSING_FAILED' });
    }
    return send(res, 200, { ok: true });
  } catch (error) {
    console.error('[TelegramWebhook] persistence failure:', String(error?.code || 'KV_UNAVAILABLE').slice(0, 80));
    return send(res, 503, { ok: false, error: 'PERSISTENCE_UNAVAILABLE' });
  }
}
