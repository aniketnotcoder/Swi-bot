import { timingSafeEqual } from 'node:crypto';
import { createKv } from '../vercel-chat/kv.js';
import { readConfig } from '../vercel-chat/config.js';
import { createOrderBot } from '../vercel-chat/bot.js';
import { createTelegramClient } from '../vercel-chat/telegram-api.js';

function equalSecret(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}
function respond(res, status, body) {
  res.statusCode = status;
  res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
  res.setHeader?.('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export default async function paymentPoll(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader?.('Allow', 'GET, POST');
    return respond(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  let config;
  try { config = readConfig(); }
  catch { return respond(res, 503, { ok: false, error: 'SERVICE_NOT_CONFIGURED' }); }
  const authorization = String(req.headers?.authorization || '');
  if (!config.cronSecret || !equalSecret(authorization.replace(/^Bearer\s+/i, ''), config.cronSecret)) {
    return respond(res, 401, { ok: false, error: 'UNAUTHORIZED' });
  }
  try {
    const kv = createKv();
    await kv.initialize();
    const telegram = createTelegramClient({ token: config.botToken });
    const bot = createOrderBot({ config, kv, telegram });
    const orderId = String(req.body?.order_id || req.query?.order_id || '').trim();
    const report = await bot.pollPendingPayments({ limit: orderId ? 1 : 10, orderId });
    return respond(res, 200, { ok: true, ...report });
  } catch (error) {
    console.error('[PaymentPoll] failed:', String(error?.code || error?.name || 'POLL_ERROR').slice(0, 80));
    return respond(res, 503, { ok: false, error: 'POLL_UNAVAILABLE' });
  }
}
