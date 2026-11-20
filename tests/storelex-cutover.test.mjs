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
