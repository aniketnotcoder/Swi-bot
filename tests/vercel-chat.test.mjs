import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, ConfigurationError } from '../vercel-chat/config.js';
import { createKv } from '../vercel-chat/kv.js';
import { apiFailureKind, extractSharedCartId, normalizeAddressResponse, normalizeCreatedAddress, normalizeGroupCartResponse, validateSwiggyLink } from '../vercel-chat/links.js';
import { buildBillCard, extractPayablePaise } from '../vercel-chat/render.js';
import { createOrderBot } from '../vercel-chat/bot.js';

function makeMemoryKv() {
  const values = new Map();
  const sorted = new Map();
  return {
    values,
    async setJson(key, value, { nx = false } = {}) {
      if (nx && values.has(key)) return false;
      values.set(key, structuredClone(value));
      return true;
    },
    async getJson(key) { return structuredClone(values.get(key) ?? null); },
    async del(key) { return values.delete(key); },
    async incrBy(key, amount) { const next = Number(values.get(key) || 0) + amount; values.set(key, next); return next; },
    async expire() { return true; },
    async zAdd(key, score, member) {
      const set = sorted.get(key) || new Map(); set.set(String(member), Number(score)); sorted.set(key, set);
    },
    async zRem(key, member) { sorted.get(key)?.delete(String(member)); },
    async zRevRange(key, start, stop, withScores = false) {
      const rows = [...(sorted.get(key) || new Map())].sort((a, b) => b[1] - a[1]).slice(start, stop + 1);
      return withScores ? rows.flatMap(([member, score]) => [member, String(score)]) : rows.map(([member]) => member);
    },
    async zRangeByScore(key, min, max, limit) {
      return [...(sorted.get(key) || new Map())].filter(([, score]) => score >= Number(min) && score <= Number(max)).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([member]) => member);
    }
  };
}

const accountMap = { '1001': ['9876543210'] };
const baseConfig = {
  botToken: 'test-token', webhookSecret: 'test-secret', storelexKey: 'test-key',
  accountMap, adminIds: [], requiredChannel: '@test', requiredChannelUrl: 'https://t.me/test',
  googleTtsApiKey: '', googleTtsVoice: 'hi-IN-Neural2-A', cronSecret: 'cron-secret',
  freeCreditAdminGrantLimit: 0
};

function makeTelegram() {
  const sent = [];
  return {
    sent,
    async getChatMember() { return { status: 'member' }; },
    async sendMessage(chatId, text, options) { sent.push({ chatId, text, options }); return { message_id: sent.length }; },
    async sendVoice() { return { message_id: 100 }; },
    async sendPhoto() { return { message_id: 101 }; },
    async answerCallbackQuery() { return true; }
  };
}

test('configuration rejects malformed authorization maps and normalizes valid phone numbers', () => {
  assert.throws(() => readConfig({ TELEGRAM_ACCOUNT_MAP: '{bad' }), ConfigurationError);
  assert.throws(() => readConfig({ TELEGRAM_ACCOUNT_MAP: '{"abc":["9876543210"]}' }), ConfigurationError);
  const config = readConfig({ TELEGRAM_ACCOUNT_MAP: '{"1001":["+91 98765 43210"]}', ADMIN_TELEGRAM_IDS: '1001, nope' });
  assert.deepEqual(config.accountMap, { '1001': ['9876543210'] });
  assert.deepEqual(config.adminIds, ['1001']);
  assert.equal(readConfig({}).orderFlowEnabled, false);
  assert.equal(readConfig({ VERCEL_ORDER_FLOW_ENABLED: 'true' }).orderFlowEnabled, true);
  assert.equal(readConfig({}).addressLinkEnabled, false);
  assert.equal(readConfig({ STORELEX_ADDRESS_LINK_ENABLED: 'true' }).addressLinkEnabled, true);
  assert.equal(readConfig({ STORELEX_KEY: 'test-key' }).storelexKey, 'test-key');
});

test('link validation rejects HTTP, foreign hosts, credentials, wrong share type, and non-Swiggy SSRF', () => {
  assert.equal(validateSwiggyLink('http://www.swiggy.com/ofo/address/abc', 'address').ok, false);
  assert.equal(validateSwiggyLink('https://attacker.example/gc/2', 'cart').ok, false);
  assert.equal(validateSwiggyLink('https://user:pw@www.swiggy.com/gc/2', 'cart').ok, false);
  assert.equal(validateSwiggyLink('https://www.swiggy.com/gc/2', 'address').ok, false);
  assert.equal(validateSwiggyLink('https://www.swiggy.com/ofo/address/abc', 'address').ok, true);
  assert.equal(validateSwiggyLink('https://www.swiggy.com/gc/1/restaurant-789', 'cart').ok, true);
});

test('cart ID extractor handles documented-looking shared-link forms without network calls', () => {
  assert.equal(extractSharedCartId('https://www.swiggy.com/gc/1/restaurant-789'), '789');
  assert.equal(extractSharedCartId('https://www.swiggy.com/gc/789'), '789');
  assert.equal(extractSharedCartId('https://www.swiggy.com/gc?sharedCartId=789'), '789');
  assert.equal(extractSharedCartId('https://attacker.example/gc/1/restaurant-789'), '789'); // extraction is not authorization; validator gates before use
  assert.equal(extractSharedCartId('not a cart'), '');
});

test('address link honors address.id, saved contact data, coordinate fallback, existing and gone flags', () => {
  const linked = normalizeAddressResponse({ success: true, existing: true, address: { id: 42, lat: 26.8, lng: 80.9, name: 'request echo', mobile: '9000000000' }, saved: { name: 'Saved Receiver', receiver_mobile: '9876543210', lat: 26.7, lng: 80.8 } });
  assert.equal(linked.ok, true);
  assert.equal(linked.existing, true);
  assert.equal(linked.address.id, '42');
  assert.equal(linked.address.address_id, '42');
  assert.equal(linked.address.name, 'Saved Receiver');
  assert.equal(linked.address.receiverMobile, '9876543210');
  assert.equal(linked.address.lat, '26.8');
  assert.deepEqual(normalizeAddressResponse({ gone: true }), { ok: false, reason: 'GONE', dropStoredSelection: true });
  assert.equal(normalizeCreatedAddress({ success: true, address: { id: 'saved-1' } }, { lat: '26.8', lng: '80.9' }).address.id, 'saved-1');
});

test('incomplete API response is rejected instead of becoming a guessed address/cart', () => {
  assert.deepEqual(normalizeAddressResponse({ success: true, address: { area: 'Lucknow' } }), { ok: false, reason: 'ADDRESS_FIELDS_MISSING' });
  assert.deepEqual(normalizeGroupCartResponse({ success: true, items: [] }), { ok: false, reason: 'CART_RESPONSE_INCOMPLETE' });
  assert.equal(apiFailureKind({ status: 401, message: 'no' }), 'SERVICE');
  assert.equal(apiFailureKind({ status: 422, message: 'expired link' }), 'USER_INPUT');
});

test('bill rendering requires a positive API-supplied paise total and does not invent offers', () => {
  assert.equal(extractPayablePaise({ success: true, bill: { to_pay: 12345 } }), 12345);
  assert.equal(extractPayablePaise({ success: true, bill: {} }), null);
  assert.throws(() => buildBillCard({ restaurant: {}, items: [], quote: { success: true } }), /confirmed payable total/);
  const card = buildBillCard({ restaurant: { name: 'Cafe' }, items: [{ name: 'Meal', price: 5000, quantity: 2 }], quote: { bill: { to_pay: 12345 }, bill_lines: [{ label: 'Total', value: '₹123.45' }] } });
  assert.equal(card.totalPaise, 12345);
  assert.match(card.text, /Total: ₹123\.45/);
  assert.match(card.text, /Final To Pay: ₹123\.45/);
  assert.match(card.text, /Meal × 2/);
  assert.doesNotMatch(card.text, /₹100/);
  assert.doesNotMatch(card.text, /Coupon:/);
});

test('KV wrapper keeps persistence fail-closed and uses NX atomic claim semantics', async () => {
  const responses = [];
  const kv = createKv({ url: 'https://kv.example', token: 'secret', fetchImpl: async (_url, init) => {
    const command = JSON.parse(init.body);
    responses.push(command);
    return new Response(JSON.stringify({ result: command[0] === 'SET' ? 'OK' : '1' }), { status: 200 });
  } });
  assert.equal(await kv.setJson('update:1', { ok: true }, { nx: true, ttlSeconds: 60 }), true);
  assert.deepEqual(responses[0], ['SET', 'storelexbot:v1:update:1', '{"ok":true}', 'NX', 'EX', '60']);
  const schemaData = new Map();
  const schemaKv = createKv({ url: 'https://kv.example', token: 'secret', fetchImpl: async (_url, init) => {
    const [op, key, value, ...flags] = JSON.parse(init.body);
    if (op === 'GET') return new Response(JSON.stringify({ result: schemaData.get(key) ?? null }), { status: 200 });
    if (op === 'SET') {
      if (flags.includes('NX') && schemaData.has(key)) return new Response(JSON.stringify({ result: null }), { status: 200 });
      schemaData.set(key, value);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    throw new Error('Unexpected KV command');
  } });
  assert.equal((await schemaKv.initialize()).schemaVersion, 1);
  assert.equal((await schemaKv.initialize()).schemaVersion, 1);
  schemaData.set('storelexbot:v1:meta:schema', JSON.stringify({ schemaVersion: 9 }));
  await assert.rejects(() => schemaKv.initialize(), error => error.code === 'KV_UNAVAILABLE');
  await assert.rejects(() => createKv({}).getJson('x'), error => error.code === 'KV_UNAVAILABLE');
});

test('chat handlers keep private data isolated and cancellation clears only an unplaced draft', async () => {
  const kv = makeMemoryKv();
  const telegram = makeTelegram();
  const voiceService = async () => true;
  let storelexCalls = 0;
  const bot = createOrderBot({ config: baseConfig, kv, telegram, voiceService, storelexFactory: () => ({ sessions: async () => { storelexCalls += 1; return { sessions: [] }; } }) });
  const user = { id: 1001, first_name: 'Customer' };
  await bot.processUpdate({ message: { from: user, chat: { id: 1001, type: 'private' }, text: '/start' } });
  assert.ok(telegram.sent.some(message => message.text.includes('Assalamu alaikum')));
  await bot.processUpdate({ message: { from: user, chat: { id: 1001, type: 'private' }, text: '🛒 Naya order' } });
  assert.equal(storelexCalls, 0, 'unverified order endpoints are never called');
  assert.ok(telegram.sent.some(message => message.text.includes('VERCEL_ORDER_FLOW_ENABLED')));

  await kv.setJson('user:1001:state', { phase: 'REVIEW', draftId: 'draft', userId: '1001', totalPaise: 5000 });
  await bot.processUpdate({ message: { from: user, chat: { id: 1001, type: 'private' }, text: '/cancel' } });
  assert.equal(await kv.getJson('user:1001:state'), null);
  assert.ok(telegram.sent.some(message => message.text.includes('Order place nahi hua')));

  await bot.processUpdate({ message: { from: user, chat: { id: -100, type: 'group' }, text: '/start' } });
  assert.equal(telegram.sent.length, 3, 'group message is ignored without disclosing user data');
});

test('Telegram webhook rejects bad secrets and processes a duplicate update only once', async () => {
  const env = {
    BOT_TOKEN: 'local-test-token',
    TELEGRAM_WEBHOOK_SECRET: 'local-secret',
    STORELEX_USER_KEY: 'local-storelex-key',
    KV_REST_API_URL: 'https://kv.test.invalid',
    KV_REST_API_TOKEN: 'kv-test-token',
    TELEGRAM_ACCOUNT_MAP: '{"2002":[]}',
    REQUIRED_CHANNEL: '@test',
    REQUIRED_CHANNEL_URL: 'https://t.me/test'
  };
  const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const redis = new Map();
  const sentMethods = [];
  Object.assign(process.env, env);
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.startsWith('https://kv.test.invalid')) {
      const args = JSON.parse(init.body);
      let result = null;
      if (args[0] === 'SET') {
        const key = args[1];
        if (args.includes('NX') && redis.has(key)) result = null;
        else { redis.set(key, args[2]); result = 'OK'; }
      } else if (args[0] === 'GET') result = redis.get(args[1]) ?? null;
      else if (args[0] === 'INCRBY') {
        const next = Number(redis.get(args[1]) || 0) + Number(args[2]);
        redis.set(args[1], String(next)); result = next;
      } else if (args[0] === 'EXPIRE') result = 1;
      return new Response(JSON.stringify({ result }), { status: 200 });
    }
    if (href.startsWith('https://api.telegram.org/')) {
      const method = href.split('/').at(-1);
      sentMethods.push(method);
      const result = method === 'getChatMember' ? { status: 'member' } : { message_id: sentMethods.length };
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }
    throw new Error('Unexpected network request in webhook unit test.');
  };
  try {
    const { default: handler } = await import(`../api/telegram.js?test=${Date.now()}`);
    const invoke = async secret => {
      const res = {
        headers: {},
        setHeader(name, value) { this.headers[name] = value; },
        end(body) { this.body = JSON.parse(body); }
      };
      await handler({
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': secret, 'content-length': '100' },
        body: { update_id: 9001, message: { from: { id: 2002, first_name: 'Test' }, chat: { id: 2002, type: 'private' }, text: '/start' } }
      }, res);
      return res;
    };
    const rejected = await invoke('wrong');
    assert.equal(rejected.statusCode, 401);
    assert.equal(sentMethods.length, 0);

    const accepted = await invoke('local-secret');
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.body.ok, true);
    const callsAfterFirst = sentMethods.length;
    const duplicate = await invoke('local-secret');
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(sentMethods.length, callsAfterFirst);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('optional address-link mode sends only mobile/link and honors existing/saved/gone response semantics', async () => {
  const kv = makeMemoryKv(); const telegram = makeTelegram();
  const user = { id: 1001, first_name: 'Customer' };
  const config = { ...baseConfig, orderFlowEnabled: true, addressLinkEnabled: true };
  const calls = [];
  const api = {
    async sessions() { return { success: true, sessions: [{ mobile: '9876543210', is_expired: false }] }; },
    async resolveAddressByLink(body, options) {
      calls.push({ body: structuredClone(body), options });
      return { success: true, existing: true, address: { id: 777, lat: 26.85, lng: 80.95, name: 'echo' }, saved: { name: 'Saved Name', receiver_mobile: '9123456789', address: 'Saved location' } };
    },
    async addAddressToAccount() { assert.fail('address_by_link already persists; do not double-add'); }
  };
  const bot = createOrderBot({ config, kv, telegram, voiceService: async () => true, storelexFactory: () => api });
  const message = text => bot.processUpdate({ message: { from: user, chat: { id: user.id, type: 'private' }, text } });
  await message('/order');
  await message('/addresslink');
  await message('https://www.swiggy.com/ofo/address/share');
  const state = await kv.getJson('user:1001:state');
  assert.equal(state.phase, 'CART');
  assert.equal(state.address.id, '777');
  assert.equal(state.address.address_id, '777');
  assert.equal(state.address.name, 'Saved Name');
  assert.equal(state.address.receiverMobile, '9123456789');
  assert.deepEqual(calls[0].body, { mobile: '9876543210', link: 'https://www.swiggy.com/ofo/address/share' });
  assert.equal(calls[0].options.timeoutMs, 45_000);
});

test('enabled flow maps the supplied Storelex contract and keeps /search/cart as the sole bill source', async () => {
  const kv = makeMemoryKv();
  const telegram = makeTelegram();
  const user = { id: 1001, first_name: 'Customer' };
  const config = { ...baseConfig, orderFlowEnabled: true, qstashToken: 'qstash-test-token', publicAppUrl: 'sample.vercel.app' };
  const calls = { addresses: [], imports: [], reprices: [], places: [], paymentChecks: [], qstash: [], confirms: 0, couponCalls: 0 };
  const paymentResponses = [
    { success: true, paid: false, inconclusive: true, unknown: false, order_failed: false, is_expired: false },
    { success: true, paid: false, failed: false, inconclusive: false, unknown: false, order_failed: false, is_expired: false },
    { success: true, paid: false, failed: false, inconclusive: false, unknown: false, order_failed: false, is_expired: false },
    { success: true, paid: false, failed: false, inconclusive: false, unknown: false, order_failed: false, is_expired: false },
    { success: true, paid: true, failed: false, inconclusive: false, unknown: false, order_failed: false, confirmed: false, how: 'provider', is_expired: false }
  ];
  const quote = {
    success: true,
    cart_id: 'storelex-cart-77',
    cart_value: 10000,
    bill: { item_total: 10000, discount: 0, delivery: 0, packing: 0, charges: 0, to_pay: 12345 },
    bill_lines: [
      { key: 'items', label: 'Items', value: '₹100.00', negative: false, total: false, strike: '', note: '' },
      { key: 'fees', label: 'Fees', value: '₹23.45', negative: false, total: false, strike: '', note: '' }
    ],
    coupon: { code: 'SAMPLE', valid: false, discount: 0 },
    swiggy_one: false,
    items: [{ id: 'item-1', in_stock: true, free: false }]
  };
  const api = {
    async sessions() { return { success: true, sessions: [{ mobile: '9876543210', name: 'Permitted account', is_expired: false }] }; },
    async addAddress(body, options) {
      calls.addresses.push({ body: structuredClone(body), options });
      return { success: true, address: { id: 'address-1' } };
    },
    async importGroupCart(body, options) {
      calls.imports.push({ body: structuredClone(body), options });
      if (body.leave_old === false) return { success: false, already_in_group: true };
      return {
        success: true,
        restaurant: { id: 'restaurant-1', parent_id: 'parent-1', name: 'Cafe', image: 'img', area: 'Lucknow', sla: '30 min', request_contexts: [] },
        items: [{ id: 'item-1', name: 'Meal', image_id: 'img1', price: 10000, is_veg: true, addons: [], variants: [], quantity: 1 }],
        skipped: [],
        left_old: true
      };
    },
    async repriceCart(body) { calls.reprices.push(structuredClone(body)); return structuredClone(quote); },
    async bestCoupon() { calls.couponCalls += 1; throw new Error('must not call a second pricing endpoint'); },
    async placeOrder(body) {
      calls.places.push(structuredClone(body));
      return {
        success: true,
        order_id: 'order-900',
        method: 'upi',
        upi_url: 'upi://pay?pa=merchant%40bank&am=123.45&cu=INR&tr=txn-900',
        upi_pkg: 'com.example.upi',
        txn_id: 'txn-900',
        finalized: { tracking_link: 'https://www.swiggy.com/orders/track/order-900', address_deleted: false, address_deleting: false }
      };
    },
    async paymentStatus(body) { calls.paymentChecks.push(structuredClone(body)); return paymentResponses.shift(); },
    async confirmPayment(body) { calls.confirms += 1; assert.equal(body.order_id, 'order-900'); return { success: true, confirmed: true, how: 'provider', order_failed: false, inconclusive: false, post_status: 'placed', is_expired: false }; },
    async orderStatus(body) { assert.deepEqual(body, { order_id: 'order-900' }); return { success: true, status: 'Preparing', eta: '20 min', de_name: '', de_phone: '', tracking_link: 'https://www.swiggy.com/orders/track/order-900', final: false }; }
  };
  const bot = createOrderBot({ config, kv, telegram, voiceService: async () => true, storelexFactory: () => api, qrCode: { toBuffer: async () => Buffer.from('qr') }, fetchImpl: async (url, init) => { calls.qstash.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); } });
  const message = text => bot.processUpdate({ message: { from: user, chat: { id: user.id, type: 'private' }, text } });
  await message('/start');
  await message('🛒 Naya order');
  await bot.processUpdate({ message: { from: user, chat: { id: user.id, type: 'private' }, location: { latitude: 26.85, longitude: 80.95 } } });
  await message('Flat 1 | Lucknow | - | Receiver | 9876543210');
  await message('https://www.swiggy.com/gc?sharedCartId=55123');

  const draft = await kv.getJson('user:1001:state');
  assert.equal(draft.phase, 'REVIEW');
  assert.equal(draft.totalPaise, 12345);
  assert.equal(calls.addresses.length, 1, 'manual map-pin path uses /addresses/add without enabling the link-import subflag');
  assert.equal(calls.addresses[0].body.mobile, '9876543210');
  assert.equal(calls.addresses[0].body.lat, '26.85');
  assert.equal(calls.addresses[0].body.receiver_mobile, '9876543210');
  assert.equal(calls.addresses[0].options.timeoutMs, 45_000);
  assert.equal(calls.imports.length, 2);
  assert.deepEqual(calls.imports.map(call => call.body.leave_old), [false, true]);
  assert.equal(calls.imports[0].options.timeoutMs, 30_000);
  assert.equal(calls.imports[1].options.timeoutMs, 45_000);
  assert.equal(calls.reprices.length, 1);
  assert.equal(calls.couponCalls, 0);
  assert.equal(calls.reprices[0].cart_id, '55123');
  assert.equal(calls.reprices[0].items[0].price, 10000);

  await bot.processUpdate({ callback_query: { id: 'cb-accept', from: user, message: { chat: { id: user.id } }, data: `order:accept:${draft.reviewToken}` } });
  assert.equal(calls.reprices.length, 2, 'accept performs a fresh authoritative repricing');
  assert.equal(calls.places.length, 1);
  const place = calls.places[0];
  assert.deepEqual(Object.keys(place).sort(), ['address_id', 'amount', 'cart_id', 'cart_value', 'lat', 'lng', 'method', 'mobile', 'restaurant_id', 'snap'].sort());
  assert.equal(place.amount, 123.45);
  assert.equal(place.method, 'upi');
  assert.equal(place.restaurant_id, 'restaurant-1');
  assert.equal(place.snap.items[0].price, 100);
  assert.deepEqual(place.snap.address, { text: 'Flat 1, Lucknow', name: 'Receiver', phone: '9876543210' });
  assert.equal(place.snap.bill_lines[0].value, '₹100.00');
  assert.equal(place.snap.coupon.valid, false);

  const pending = await kv.getJson('user:1001:state');
  assert.equal(pending.phase, 'PAYMENT_PENDING');
  assert.equal(pending.orderId, 'order-900');
  assert.equal((await kv.getJson('order:order-900')).trackingLink, 'https://www.swiggy.com/orders/track/order-900');
  for (let check = 0; check < 5; check += 1) {
    await bot.processUpdate({ callback_query: { id: `cb-pay-${check}`, from: user, message: { chat: { id: user.id } }, data: `payment:check:${pending.paymentToken}` } });
    if (check === 0) assert.equal((await kv.getJson('order:order-900')).paymentStatus, 'INCONCLUSIVE');
  }
  assert.equal(calls.paymentChecks.length, 5);
  assert.equal(calls.qstash.length, 5, 'one delayed QStash check is chained after each pending status response');
  assert.deepEqual(calls.qstash.map(row => row.url.match(/delay=(\d+)s/)?.[1]), ['5', '5', '5', '5', '5']);
  assert.equal(calls.qstash[0].headers.Authorization, 'Bearer qstash-test-token');
  assert.equal(calls.qstash[0].headers['Upstash-Forward-Authorization'], 'Bearer cron-secret');
  assert.deepEqual(calls.qstash[0].body, { order_id: 'order-900' });
  assert.equal(calls.paymentChecks[0].restaurant_id, 'restaurant-1');
  assert.equal(calls.paymentChecks[0].cart_value, 10000);
  assert.equal(calls.paymentChecks[0].manual, true);
  assert.equal(calls.paymentChecks[0].deep, false);
  assert.equal(calls.paymentChecks[3].deep, true, 'deep payment check is sent on every fourth status query');
  assert.equal(calls.confirms, 1);
  assert.equal((await kv.getJson('order:order-900')).paymentStatus, 'PAID');
  assert.equal((await kv.getJson('user:1001:profile')).successfulOrders, 1);
});
