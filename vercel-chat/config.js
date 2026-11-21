export class ConfigurationError extends Error {
  constructor(message) { super(message); this.name = 'ConfigurationError'; this.code = 'CONFIG_ERROR'; }
}

function parseJsonEnv(name, raw, fallback = {}) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); }
  catch { throw new ConfigurationError(`${name} must be valid JSON.`); }
}

export function readConfig(env = process.env) {
  const botToken = String(env.BOT_TOKEN || '').trim();
  const webhookSecret = String(env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  const storelexKey = String(env.STORELEX_USER_KEY || env.STORELEX_KEY || '').trim();
  const adminIds = String(env.ADMIN_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(x => /^\d+$/.test(x));
  const accountMap = parseJsonEnv('TELEGRAM_ACCOUNT_MAP', env.TELEGRAM_ACCOUNT_MAP, {});
  if (!accountMap || Array.isArray(accountMap) || typeof accountMap !== 'object') {
    throw new ConfigurationError('TELEGRAM_ACCOUNT_MAP must be a JSON object keyed by Telegram user ID.');
  }
  const normalizedAccounts = {};
  for (const [userId, accounts] of Object.entries(accountMap)) {
    if (!/^\d+$/.test(String(userId)) || !Array.isArray(accounts)) {
      throw new ConfigurationError('TELEGRAM_ACCOUNT_MAP entries must map numeric Telegram IDs to arrays of mobile numbers.');
    }
    const phones = [...new Set(accounts.map(value => String(value || '').replace(/\D/g, '').slice(-10)).filter(value => /^[6-9]\d{9}$/.test(value)))];
    if (phones.length !== accounts.length) throw new ConfigurationError('TELEGRAM_ACCOUNT_MAP contains an invalid mobile number.');
    normalizedAccounts[String(userId)] = phones;
  }
  return Object.freeze({
    botToken,
    webhookSecret,
    storelexKey,
    adminIds: [...new Set(adminIds)],
    accountMap: normalizedAccounts,
    requiredChannel: String(env.REQUIRED_CHANNEL || '@its_NoooB').trim(),
    requiredChannelUrl: String(env.REQUIRED_CHANNEL_URL || 'https://t.me/its_NoooB').trim(),
    googleTtsApiKey: String(env.GOOGLE_TTS_API_KEY || '').trim(),
    googleTtsVoice: String(env.GOOGLE_TTS_VOICE || 'hi-IN-Neural2-A').trim(),
    cronSecret: String(env.CRON_SECRET || '').trim(),
    orderFlowEnabled: String(env.VERCEL_ORDER_FLOW_ENABLED || '').toLowerCase() === 'true',
    addressLinkEnabled: String(env.STORELEX_ADDRESS_LINK_ENABLED || '').toLowerCase() === 'true',
    qstashToken: String(env.QSTASH_TOKEN || '').trim(),
    publicAppUrl: String(env.VERCEL_URL || env.VERCEL_PROJECT_PRODUCTION_URL || '').trim(),
    freeCreditAdminGrantLimit: Math.max(0, Number(env.FREE_CREDIT_ADMIN_GRANT_LIMIT) || 0)
  });
}

export function userCanOrder(config, telegramUserId) {
  return (config.accountMap[String(telegramUserId)] || []).length > 0;
}

export function authorizedMobiles(config, telegramUserId) {
  return [...(config.accountMap[String(telegramUserId)] || [])];
}

export function isAdmin(config, telegramUserId) {
  return config.adminIds.includes(String(telegramUserId));
}
