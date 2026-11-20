import 'dotenv/config';
import http from 'node:http';
import { Telegraf } from 'telegraf';
import { createConfiguredStorelexClient } from './storelex-api.js';
import { createStorelexFlow } from './storelex-flow.js';

// Storelex-only cutover. Do not import index.js, bossbot, or local checkout modules.
export function registerStorelexHandlers(bot, client, bossId) {
  const isBoss = ctx => String(ctx.from?.id || '') === String(bossId);
  const flow = createStorelexFlow(client);
  const flowCommand = (name, parse, action, successMessage) => bot.command(name, async ctx => {
    if (!isBoss(ctx) || ctx.chat?.type !== 'private') return ctx.reply('Is command ki access nahi hai.');
    try {
      const arg = parse(ctx.message?.text || '');
      const result = await action(ctx.from.id, arg);
      return ctx.reply(successMessage(result));
    } catch (error) {
      // API failures may contain personal details: do not reflect raw messages.
      return ctx.reply(`Storelex ${name} verify nahi hua. ${error.code ? `Code: ${error.code}` : 'Input/response check karein.'}`);
    }
  });
  const argument = text => text.replace(/^\/\S+(?:@\w+)?\s*/, '').trim();
  const welcome = 'Storelex mode active hai. Purane buttons, cart, payment aur order actions band hain. /status se API connection check karein.';
  bot.start(ctx => ctx.reply(welcome));
  bot.command('help', ctx => ctx.reply(welcome));
  bot.command('status', async ctx => {
    if (!isBoss(ctx)) return ctx.reply('Is command ki access nahi hai.');
    try {
      await client.me();
      return ctx.reply('Storelex API connected hai. Live cart, checkout aur payment abhi verify nahi hue hain; orders band hain.');
    } catch (error) {
      return ctx.reply(`Storelex API verify nahi ho paayi (${error.code || 'ERROR'}). Orders band hain.`);
    }
  });
  bot.command('sessions', async ctx => {
    if (!isBoss(ctx)) return ctx.reply('Is command ki access nahi hai.');
    try {
      const result = await client.sessions();
      // Never send account identifiers, cookies or session objects to Telegram.
      const list = Array.isArray(result) ? result : Array.isArray(result?.sessions) ? result.sessions : null;
      return ctx.reply(list ? `Storelex par ${list.length} session(s) mile. Details privacy ke liye yahan nahi bheje jaate.` : 'Storelex sessions ka response mila, lekin format verify nahi hua; koi details nahi bheji.');
    } catch (error) {
      return ctx.reply(`Storelex sessions nahi mil paaye (${error.code || 'ERROR'}).`);
    }
  });
  bot.command('recent', async ctx => {
    if (!isBoss(ctx)) return ctx.reply('Is command ki access nahi hai.');
    try {
      // Storelex documents this as the caller's orders from the last hour.
      const result = await client.recentOrders({ minutes: 60, live: false });
      const list = Array.isArray(result) ? result : Array.isArray(result?.orders) ? result.orders : null;
      return ctx.reply(list ? `Storelex par pichhle 60 minute ke ${list.length} order(s) mile. Private details yahan nahi bheje jaate.` : 'Storelex recent-orders response mila, format verify nahi hua; details nahi bheji.');
    } catch (error) {
      return ctx.reply(`Recent orders check fail (${error.code || 'ERROR'}).`);
    }
  });
  bot.command('cartcheck', async ctx => {
    if (!isBoss(ctx)) return ctx.reply('Is command ki access nahi hai.');
    try {
      const state = await client.getCartState();
      // Only structural diagnostics: cart state may contain address, cookies or phone.
      const keys = state && typeof state === 'object' && !Array.isArray(state)
        ? Object.keys(state).filter(key => /^[a-zA-Z_]{1,40}$/.test(key)).slice(0, 30)
        : [];
      return ctx.reply(`Storelex cart/state read hua. Top-level fields: ${keys.length ? keys.join(', ') : '(unknown format)'}. Cart/checkout abhi band hain.`);
    } catch (error) {
      return ctx.reply(`Cart state check fail (${error.code || 'ERROR'}).`);
    }
  });
  flowCommand('account', argument, (user, mobile) => flow.selectAccount(user, mobile), () => 'Storelex account select ho gaya. Ab /address <Swiggy address link> bhejein.');
  flowCommand('address', argument, (user, link) => flow.address(user, link), () => 'Storelex address verify hua. Ab /group <Swiggy group cart link> bhejein.');
  flowCommand('group', argument, (user, link) => flow.importGroup(user, link), result => `Storelex cart import hua: ${result.itemCount} item(s), ${result.skipped} skipped. /bill se reprice check karein.`);
  flowCommand('bill', () => '', user => flow.bill(user), result => `Storelex bill verified: ${result.lineCount} bill lines. Exact payable amount mapping abhi unverified hai; payment/order disabled.`);
  // Explicitly catch stale inline keyboards from previous deployments; never execute them.
  bot.on('callback_query', async ctx => {
    await ctx.answerCbQuery('Purana action band hai. /start bhejein.').catch(() => {});
    await ctx.reply(welcome);
  });
  bot.on('message', ctx => ctx.reply(welcome));
}

export async function main() {
  const token = process.env.BOT_TOKEN;
  const bossId = process.env.BOSS_ID;
  if (!token || !/^\d+$/.test(String(bossId || ''))) throw new Error('BOT_TOKEN and numeric BOSS_ID are required.');
  const client = createConfiguredStorelexClient();
  const bot = new Telegraf(token);
  registerStorelexHandlers(bot, client, bossId);
  // Fail closed before accepting Telegram updates if the configured remote API
  // cannot authenticate. Never log response bodies or credentials.
  await client.me();
  // Do not claim readiness based on a successful TCP bind alone.
  const port = Number(process.env.PORT || 0);
  let ready = false;
  const server = port > 0 ? http.createServer((req, res) => {
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: ready ? 'storelex-only' : 'starting', ordersEnabled: false }));
  }) : null;
  if (server) await new Promise(resolve => server.listen(port, '0.0.0.0', resolve));
  try {
    await bot.telegram.deleteMyCommands();
    await bot.telegram.setChatMenuButton({ type: 'commands' });
    await bot.telegram.setMyCommands([{ command: 'start', description: 'Storelex mode' }, { command: 'status', description: 'Storelex connection (boss)' }, { command: 'sessions', description: 'Session count (boss)' }, { command: 'cartcheck', description: 'Cart state diagnostic (boss)' }, { command: 'recent', description: 'Recent order count (boss)' }, { command: 'account', description: 'Select Storelex account (boss)' }, { command: 'address', description: 'Verify address link (boss)' }, { command: 'group', description: 'Import group cart (boss)' }, { command: 'bill', description: 'Check repriced bill (boss)' }]);
    await bot.launch();
    ready = true;
    console.log('Storelex-only Telegram bot active; checkout disabled.');
  } catch (error) {
    server?.close();
    throw error;
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    ready = false;
    bot.stop(signal);
    server?.close();
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error('Storelex-only startup failed:', error.message); process.exitCode = 1; });
}
