import 'dotenv/config';
import http from 'node:http';
import { Telegraf } from 'telegraf';
import { createConfiguredStorelexClient } from './storelex-api.js';

// Storelex-only cutover. Do not import index.js, bossbot, or local checkout modules.
export function registerStorelexHandlers(bot, client, bossId) {
  const isBoss = ctx => String(ctx.from?.id || '') === String(bossId);
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
    await bot.telegram.setMyCommands([{ command: 'start', description: 'Storelex mode' }, { command: 'status', description: 'Storelex connection (boss)' }, { command: 'sessions', description: 'Session count (boss)' }]);
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
