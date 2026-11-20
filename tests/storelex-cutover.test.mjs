import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerStorelexHandlers, classifyStorelexLinks, getStorelexMiniUrl } from '../storelex-bot.js';

test('mini app URL resolves HTTPS from public host and rejects unsafe URL', () => {
  assert.equal(getStorelexMiniUrl({ RENDER_EXTERNAL_URL: 'https://bot.onrender.com' }), 'https://bot.onrender.com/storelex');
  assert.equal(getStorelexMiniUrl({ RENDER_SERVICE_NAME: 'ammi-abbu-ka-sacha-beta' }), 'https://ammi-abbu-ka-sacha-beta.onrender.com/storelex');
  assert.equal(getStorelexMiniUrl({ PUBLIC_URL: 'http://insecure.test' }), '');
  const source=fs.readFileSync(new URL('../storelex-bot.js', import.meta.url),'utf8');
  assert.match(source, /setChatMenuButton\(\{ chatId: Number\(ownerId\), menuButton:/);
});

test('/start and /app give owner a persistent Web App button, not other users', async () => {
  const handlers = {};
  const bot = { start: fn => {handlers.start=fn;}, command: (name,fn) => {handlers[name]=fn;}, on: () => {} };
  registerStorelexHandlers(bot, {}, '12345', { miniUrl: 'https://bot.onrender.com/storelex' });
  const replies=[];
  const ctx={from:{id:12345},chat:{type:'private'},reply:async (message,options)=>replies.push(options)};
  await handlers.start(ctx);
  assert.equal(replies[0].reply_markup.is_persistent, true);
  assert.equal(replies[0].reply_markup.keyboard[0][0].web_app.url, 'https://bot.onrender.com/storelex');
  await handlers.app(ctx);
  assert.equal(replies.length, 2);
  ctx.from.id=99999;
  await handlers.start(ctx);
  assert.equal(replies[2].reply_markup, undefined);
});

test('recognizes forwarded address and group cart links, not arbitrary URLs', () => {
  assert.deepEqual(classifyStorelexLinks('link:[https://swiggy.onelink.me/JgkQ/a](https://swiggy.onelink.me/JgkQ/a) https://swig.gy/gc/abc'), { address: 'https://swiggy.onelink.me/JgkQ/a', group: 'https://swig.gy/gc/abc' });
  assert.deepEqual(classifyStorelexLinks('https://evil.example/abc'), { address: null, group: null });
});

test('boss can send natural address then cart and receive bill with pay button', async () => {
  const handlers = {};
  const bot = { start: () => {}, command: (name, fn) => { handlers[name] = fn; }, on: (name, fn) => { handlers[name] = fn; } };
  const calls = [];
  const client = {
    sessions: async () => ({ success: true, sessions: [{ mobile: '9876543210', is_done: false, orders_count: 0 }] }),
    resolveAddressByLink: async body => { calls.push('address'); return { success: true, address: { id: 'a1', lat: 26.85, lng: 80.95 } }; },
    importGroupCart: async () => { calls.push('group'); return { success: true, restaurant: { id: 'r1' }, items: [{ id: 'i1', quantity: 1 }], skipped: [] }; },
    repriceCart: async () => { calls.push('bill'); return { success: true, cart_id: 'c1', cart_value: 30000, bill: {}, bill_lines: [{ label: 'To Pay', value: '₹349' }] }; }
  };
  registerStorelexHandlers(bot, client, '123,456', { ownerPay: async () => {} });
  const replies = [];
  const ctx = { from: { id: 456 }, chat: { type: 'private' }, message: { text: 'https://swiggy.onelink.me/JgkQ/a' }, reply: async (text, opts) => { replies.push({ text, opts }); } };
  await handlers.message(ctx);
  ctx.message.text = 'https://swig.gy/gc/abc';
  await handlers.message(ctx);
  assert.deepEqual(calls, ['address', 'group', 'bill']);
  assert.match(replies.at(-1).text, /₹349/);
  assert.match(replies.at(-1).opts.reply_markup.inline_keyboard[0][0].text, /Pay ₹349/);
});

test('cart before address waits, unauthorized sender cannot invoke Storelex', async () => {
  const handlers = {};
  const bot = { start: () => {}, command: () => {}, on: (name, fn) => { handlers[name] = fn; } };
  const calls = [];
  registerStorelexHandlers(bot, {
    sessions: async () => { calls.push('sessions'); return { success: true, sessions: [{ mobile: '9876543210' }] }; },
    resolveAddressByLink: async () => { calls.push('address'); return { success: true, address: { id: 'a', lat: 26, lng: 80 } }; },
    importGroupCart: async () => { calls.push('group'); return { success: true, restaurant: { id: 'r' }, items: [{ id: 'i', quantity: 1 }] }; },
    repriceCart: async () => { calls.push('bill'); return { success: true, cart_id: 'c', cart_value: 10000, bill: {}, bill_lines: [{ label: 'To Pay', value: '₹100' }] }; }
  }, '123');
  const ctx = { from: { id: 999 }, chat: { type: 'private' }, message: { text: 'https://swig.gy/gc/abc' }, reply: async () => {} };
  await handlers.message(ctx);
  assert.deepEqual(calls, []);
  ctx.from.id = 123;
  await handlers.message(ctx);
  assert.deepEqual(calls, ['sessions', 'sessions']);
  ctx.message.text = 'https://swiggy.onelink.me/JgkQ/a';
  await handlers.message(ctx);
  assert.deepEqual(calls.slice(-3), ['address', 'group', 'bill']);
});

test('Storelex runtime installs prerecorded voice pack and /voice remains available', async () => {
  const source = fs.readFileSync(new URL('../storelex-bot.js', import.meta.url), 'utf8');
  assert.match(source, /installTelegramVoiceReplies\(bot\.telegram/);
  const handlers = {};
  const bot = { start: () => {}, command: (name, fn) => { handlers[name] = fn; }, on: () => {} };
  registerStorelexHandlers(bot, {}, '123');
  const replies = [];
  await handlers.voice({ chat: { type: 'private', id: 123 }, reply: text => replies.push(text) });
  assert.match(replies[0], /Voice reminder/);
});

test('production start uses Storelex-only entrypoint', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.scripts.start, 'node storelex-bot.js');
});

test('old callback buttons never invoke checkout and status is boss-only', async () => {
  const handlers = {};
  const bot = {
    start: fn => { handlers.start = fn; },
    command: (name, fn) => { handlers[name] = fn; },
    on: (name, fn) => { handlers[name] = fn; }
  };
  let calls = 0;
  registerStorelexHandlers(bot, { me: async () => { calls++; return { success: true }; } }, '123');
  const replies = [];
  const ctx = { from: { id: 456 }, reply: async text => { replies.push(text); }, answerCbQuery: async () => {} };
  await handlers.callback_query(ctx);
  await handlers.status(ctx);
  assert.equal(calls, 0);
  assert.match(replies[0], /band hai/);
  ctx.from.id = 123;
  await handlers.status(ctx);
  assert.equal(calls, 1);
  assert.match(replies.at(-1), /connected/);
});

test('pay is restricted to boss private chat and disabled without explicit gate', async () => {
  const handlers = {};
  const bot = { start: () => {}, command: (name, fn) => { handlers[name] = fn; }, on: () => {} };
  let calls = 0;
  registerStorelexHandlers(bot, {}, '123', { ownerPay: async () => { calls++; return { png: Buffer.from('x') }; } });
  const ctx = { from: { id: 456 }, chat: { type: 'private' }, message: { text: '/pay 349' }, reply: async () => {} };
  await handlers.pay(ctx);
  ctx.from.id = 123; ctx.chat.type = 'group';
  await handlers.pay(ctx);
  assert.equal(calls, 0);
  registerStorelexHandlers(bot, {}, '123');
  ctx.chat.type = 'private';
  await handlers.pay(ctx);
  assert.equal(calls, 0);
});

test('recent orders is boss-only and never sends order values', async () => {
  const handlers = {};
  const bot = { start: () => {}, command: (name, fn) => { handlers[name] = fn; }, on: () => {} };
  let calls = 0;
  registerStorelexHandlers(bot, { recentOrders: async query => {
    calls++;
    assert.deepEqual(query, { minutes: 60, live: false });
    return { orders: [{ address: 'PRIVATE ADDRESS', order_id: 'SECRET-ID' }] };
  } }, '123');
  const replies = [];
  const ctx = { from: { id: 456 }, reply: async text => replies.push(text) };
  await handlers.recent(ctx);
  assert.equal(calls, 0);
  ctx.from.id = 123;
  await handlers.recent(ctx);
  assert.equal(calls, 1);
  assert.match(replies.at(-1), /1 order/);
  assert.doesNotMatch(replies.at(-1), /PRIVATE ADDRESS|SECRET-ID/);
});

test('cartcheck is boss-only and never sends cart values', async () => {
  const handlers = {};
  const bot = { start: () => {}, command: (name, fn) => { handlers[name] = fn; }, on: () => {} };
  let calls = 0;
  registerStorelexHandlers(bot, { getCartState: async () => { calls++; return { cart: { address: 'PRIVATE ADDRESS' }, mobile: '9999999999' }; } }, '123');
  const replies = [];
  const ctx = { from: { id: 456 }, reply: async text => replies.push(text) };
  await handlers.cartcheck(ctx);
  assert.equal(calls, 0);
  ctx.from.id = 123;
  await handlers.cartcheck(ctx);
  assert.equal(calls, 1);
  assert.match(replies.at(-1), /cart, mobile/);
  assert.doesNotMatch(replies.at(-1), /PRIVATE ADDRESS|9999999999/);
});

test('sessions only shows count to boss and never leaks credentials', async () => {
  const handlers = {};
  const bot = { start: () => {}, command: (name, fn) => { handlers[name] = fn; }, on: () => {} };
  let calls = 0;
  registerStorelexHandlers(bot, { sessions: async () => { calls++; return { sessions: [{ cookie: 'PRIVATE' }] }; } }, '123');
  const replies = [];
  const ctx = { from: { id: 456 }, reply: async text => replies.push(text) };
  await handlers.sessions(ctx);
  assert.equal(calls, 0);
  ctx.from.id = 123;
  await handlers.sessions(ctx);
  assert.equal(calls, 1);
  assert.match(replies.at(-1), /1 session/);
  assert.doesNotMatch(replies.at(-1), /PRIVATE/);
});
