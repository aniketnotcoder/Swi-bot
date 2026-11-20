import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerStorelexHandlers } from '../storelex-bot.js';

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
  assert.match(replies[0], /band hain/);
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
