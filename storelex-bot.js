import 'dotenv/config';
import http from 'node:http';
import { Telegraf } from 'telegraf';
import { createConfiguredStorelexClient } from './storelex-api.js';
import { createStorelexFlow } from './storelex-flow.js';
import { confirmedPayable } from './storelex-owner-pay.js';
import { configureOwnerPay } from './storelex-pay-config.js';
import { installTelegramVoiceReplies, toggleVoiceTone } from './voice-replies.js';
import { extractSharedUrls } from './link-utils.js';
import { createConfiguredMiniService } from './storelex-mini-service.js';

export function classifyStorelexLinks(text) {
  const result = { address: null, group: null };
  for (const link of extractSharedUrls(text)) {
    let url;
    try { url = new URL(link); } catch { continue; }
    const host = url.hostname.toLowerCase();
    if ((host === 'swiggy.onelink.me' || (host === 'www.swiggy.com' && /\/ofo\/address\//i.test(url.pathname))) && !result.address) result.address = link;
    if ((host === 'swig.gy' && /\/gc\//i.test(url.pathname)) || ((host === 'www.swiggy.com' || host === 'swiggy.com') && /group.?cart|\/gc\//i.test(url.pathname))) result.group ||= link;
  }
  return result;
}

// Storelex-only cutover. Do not import index.js, bossbot, or local checkout modules.
export function registerStorelexHandlers(bot, client, bossId, { ownerPay = null } = {}) {
  const bossIds = new Set(String(bossId).split(/[,;\s]+/).filter(id => /^\d+$/.test(id)));
  const isBoss = ctx => bossIds.has(String(ctx.from?.id || ''));
  const flow = createStorelexFlow(client);
  const pendingGroup = new Map();
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
  const payHint = user => !ownerPay ? 'Pay host par enable nahi hai (persistent DATA_DIR mount chahiye).' : confirmedPayable(flow.paymentDraft(user)?.bill) ? 'Amount check karke Confirm bill & Pay dabayein.' : 'Bill me final To Pay ₹ amount nahi mila; button nahi dikhaya.';
  const billOptions = user => {
    const bill = flow.paymentDraft(user)?.bill;
    const amount = ownerPay && confirmedPayable(bill);
    return amount && bill?.nonce ? { reply_markup: { inline_keyboard: [[{ text: `Confirm bill & Pay ₹${amount}`, callback_data: `storelex_pay:${bill.nonce}` }]] } } : {};
  };
  const welcome = 'Storelex ready hai. Owner: Swiggy address aur group-cart link bhejein; bill khud aayega. /account <mobile> se ID badlein. Baaki users ke liye checkout abhi band hai.';
  bot.start(ctx => ctx.reply(welcome));
  bot.command('whoami', ctx => ctx.reply(`Aapki Telegram numeric ID: ${ctx.from?.id || 'unknown'}. Owner access BOSS_ID/BOSS_IDS se match hota hai.`));
  bot.command('voice', ctx => {
    if (ctx.chat?.type !== 'private') return ctx.reply('Voice sirf private chat mein hai.');
    const mood = toggleVoiceTone(ctx.chat.id);
    return ctx.reply(mood === 'stern' ? 'Voice reminder thoda firm ho gaya.' : 'Voice reminder normal ho gaya.');
  });
  bot.command('help', ctx => ctx.reply(welcome));
  bot.command('status', async ctx => {
    if (!isBoss(ctx)) return ctx.reply('Is command ki access nahi hai.');
    try {
      await client.me();
      return ctx.reply(`Storelex API connected hai. Address/cart links bhejein; bill auto aayega. Owner Pay ${ownerPay ? 'available hai' : 'host par enable nahi hai'}. Baaki users ka checkout band hai.`);
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
  flowCommand('account', argument, (user, mobile) => { pendingGroup.delete(String(user)); return flow.selectAccount(user, mobile); }, () => 'Storelex account select ho gaya. Ab /address <Swiggy address link> bhejein.');
  flowCommand('address', argument, (user, link) => flow.address(user, link), () => 'Storelex address verify hua. Ab /group <Swiggy group cart link> bhejein.');
  flowCommand('group', argument, (user, link) => flow.importGroup(user, link), result => `Storelex cart import hua: ${result.itemCount} item(s), ${result.skipped} skipped. /bill se reprice check karein.`);
  bot.command('bill', async ctx => {
    if (!isBoss(ctx) || ctx.chat?.type !== 'private') return ctx.reply('Is command ki access nahi hai.');
    try {
      const result = await flow.bill(ctx.from.id);
      return ctx.reply(`Storelex bill:\n${result.lines.join('\n')}\n${result.couponStatus}\n${payHint(ctx.from.id)}`, billOptions(ctx.from.id));
    } catch { return ctx.reply('Storelex bill verify nahi hua. Address/cart check karein.'); }
  });
  const watchTracking = (ctx, draft) => {
    let checks = 0;
    const timer = setInterval(async () => {
      if (++checks > 40) { clearInterval(timer); return; }
      try {
        const status = await ownerPay.track(draft);
        if (status.link) {
          clearInterval(timer);
          try { await ctx.reply(await ownerPay.receipt(draft)); }
          catch { await ctx.reply(`Storelex paid order status: ${status.status}\nTracking: ${status.link}\nFull receipt abhi verify nahi hua.`); }
        } else if (status.final) {
          clearInterval(timer);
          await ctx.reply(`Storelex order status: ${status.status}. Tracking link available nahi hai.`);
        }
      } catch { /* transient: /track remains available */ }
    }, 30_000);
    timer.unref?.();
  };
  const sendOwnerQr = async (ctx, amount) => {
    try {
      const draft = flow.paymentDraft(ctx.from.id);
      const result = await ownerPay(draft, amount);
      const sent = await ctx.replyWithPhoto({ source: result.png }, { caption: 'Storelex UPI QR. /paystatus se payment, /track se order status dekhein. Tracking link aate hi bot bhejega.' });
      await ctx.reply('QR payment request hai, order confirmation nahi. Payment verify hone ke baad hi receipt/tracking bhejunga.');
      watchTracking(ctx, draft);
      return sent;
    } catch { return ctx.reply('Pay incomplete/uncertain. Storelex order list mein check karein; same cart par Pay dobara na karein.'); }
  };
  bot.command('pay', async ctx => {
    if (!isBoss(ctx) || ctx.chat?.type !== 'private' || !ownerPay) return ctx.reply('Owner-only payment test disabled.');
    return sendOwnerQr(ctx, argument(ctx.message?.text || ''));
  });
  bot.command('paystatus', async ctx => {
    if (!isBoss(ctx) || ctx.chat?.type !== 'private' || !ownerPay) return ctx.reply('Owner-only payment test disabled.');
    try {
      const status = await ownerPay.status(flow.paymentDraft(ctx.from.id));
      return ctx.reply(`Storelex payment status: ${status}. ${status === 'PAID' ? 'Provider ne paid confirm kiya.' : 'Paid assume mat karein; Storelex par check karein.'}`);
    } catch { return ctx.reply('Payment status verify nahi hua. Storelex par manually check karein; /pay retry mat karein.'); }
  });
  bot.command('receipt', async ctx => {
    if (!isBoss(ctx) || ctx.chat?.type !== 'private' || !ownerPay) return ctx.reply('Owner-only receipt unavailable.');
    try { return ctx.reply(await ownerPay.receipt(flow.paymentDraft(ctx.from.id))); }
    catch { return ctx.reply('Storelex order detail abhi available nahi hai. /recent aur /track check karein.'); }
  });
  bot.command('track', async ctx => {
    if (!isBoss(ctx) || ctx.chat?.type !== 'private' || !ownerPay) return ctx.reply('Owner-only tracking unavailable.');
    try {
      const result = await ownerPay.track(flow.paymentDraft(ctx.from.id));
      return ctx.reply(`Storelex order: ${result.status}${result.link ? `\nTracking: ${result.link}` : '\nTracking link abhi nahi aaya.'}`);
    } catch { return ctx.reply('Storelex tracking verify nahi hua; /recent se order check karein.'); }
  });
  // Explicitly catch stale inline keyboards from previous deployments; never execute them.
  bot.on('callback_query', async ctx => {
    const data = String(ctx.callbackQuery?.data || '');
    if (data.startsWith('storelex_pay:')) {
      if (!isBoss(ctx) || ctx.chat?.type !== 'private' || !ownerPay) return ctx.answerCbQuery('Owner-only Pay unavailable.').catch(() => {});
      const bill = flow.paymentDraft(ctx.from.id)?.bill;
      if (!bill?.nonce || data !== `storelex_pay:${bill.nonce}` || !confirmedPayable(bill)) return ctx.answerCbQuery('Bill purana hai. /bill dobara bhejein.').catch(() => {});
      await ctx.answerCbQuery('Storelex Pay request bhej raha hoon...').catch(() => {});
      return sendOwnerQr(ctx, confirmedPayable(bill));
    }
    await ctx.answerCbQuery('Purana action band hai. /start bhejein.').catch(() => {});
    await ctx.reply(welcome);
  });
  bot.on('message', async ctx => {
    if (!isBoss(ctx) || ctx.chat?.type !== 'private') return ctx.reply(welcome);
    const text = ctx.message?.text || ctx.message?.caption || '';
    const links = classifyStorelexLinks(text);
    if (!links.address && !links.group) return ctx.reply('Address ya group-cart link bhejein. /account <mobile> se ID badal sakte hain.');
    try {
      const mobile = await flow.autoSelectAccount(ctx.from.id);
      const mask = `••••${mobile.slice(-4)}`;
      if (links.group && !links.address && !flow.paymentDraft(ctx.from.id)?.address) {
        pendingGroup.set(String(ctx.from.id), links.group);
        return ctx.reply(`Group-cart link mila (ID ${mask}). Address link bhejein; phir bill khud aa jayega.`);
      }
      if (links.address) {
        await flow.address(ctx.from.id, links.address);
        await ctx.reply(`Storelex address parse ho gaya (ID ${mask}). ${links.group || pendingGroup.has(String(ctx.from.id)) ? 'Cart import kar raha hoon…' : 'Ab group-cart link bhejein.'}`);
      }
      const groupLink = links.group || (links.address ? pendingGroup.get(String(ctx.from.id)) : null);
      if (groupLink) {
        const imported = await flow.importGroup(ctx.from.id, groupLink);
        pendingGroup.delete(String(ctx.from.id));
        const billed = await flow.bill(ctx.from.id);
        await ctx.reply(`Storelex cart: ${imported.itemCount} item(s), ${imported.skipped} skipped (ID ${mask}).\nBill:\n${billed.lines.join('\n')}\n${billed.couponStatus}\n${payHint(ctx.from.id)}`, billOptions(ctx.from.id));
      }
    } catch (error) {
      return ctx.reply(`Storelex address/cart/bill abhi verify nahi hua (${error.code || 'CHECK_FAILED'}). /account <mobile> se ID select karke dobara try karein.`);
    }
  });
}

export async function main() {
  const token = process.env.BOT_TOKEN;
  const bossId = process.env.BOSS_IDS || process.env.BOSS_ID;
  if (!token || !String(bossId || '').split(/[,;\s]+/).filter(Boolean).every(id => /^\d+$/.test(id)) || !String(bossId || '').trim()) throw new Error('BOT_TOKEN and numeric BOSS_ID/BOSS_IDS are required.');
  const client = createConfiguredStorelexClient();
  const bot = new Telegraf(token);
  // Legacy index.js is no longer started; explicitly install its existing
  // prerecorded private-chat voice pack on this Storelex-only runtime too.
  const voiceRuntime = installTelegramVoiceReplies(bot.telegram, { isBoss: () => false });
  const { pay: ownerPay, reason: ownerPayReason } = configureOwnerPay(client);
  console.log(`Storelex owner Pay: ${ownerPayReason}`);
  registerStorelexHandlers(bot, client, bossId, { ownerPay });
  // Fail closed before accepting Telegram updates if the configured remote API
  // cannot authenticate. Never log response bodies or credentials.
  const identity = await client.me();
  if (identity?.success !== true) throw new Error('Storelex key validation failed');
  // Do not claim readiness based on a successful TCP bind alone.
  const port = Number(process.env.PORT || (process.env.RENDER ? 10000 : 0));
  const dataDir = process.env.DATA_DIR || (process.env.RENDER ? '/app/data' : new URL('./data/', import.meta.url).pathname);
  const mini = port > 0 ? await createConfiguredMiniService({ token, bossIds: bossId, dataDir }) : null;
  let ready = false;
  const server = port > 0 ? http.createServer(async (req, res) => {
    try {
      if (await mini.handle(req, res)) return;
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'storelex-only' : 'starting', ordersEnabled: false, ownerTestEnabled: Boolean(ownerPay), miniApp: '/storelex' }));
    } catch { res.writeHead(500); res.end('Error'); }
  }) : null;
  if (server) await new Promise(resolve => server.listen(port, '0.0.0.0', resolve));
  try {
    await bot.telegram.deleteMyCommands();
    const publicBase = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
    const miniUrl = publicBase ? new URL('/storelex', publicBase).toString() : '';
    await bot.telegram.setChatMenuButton(miniUrl ? { type: 'web_app', text: 'Storelex Mini App', web_app: { url: miniUrl } } : { type: 'commands' });
    await bot.telegram.setMyCommands([{ command: 'start', description: 'Storelex mode' }, { command: 'whoami', description: 'Your Telegram numeric ID' }, { command: 'voice', description: 'Toggle voice reminder tone' }, { command: 'status', description: 'Storelex connection (boss)' }, { command: 'sessions', description: 'Session count (boss)' }, { command: 'cartcheck', description: 'Cart state diagnostic (boss)' }, { command: 'recent', description: 'Recent order count (boss)' }, { command: 'account', description: 'Select Storelex account (boss)' }, { command: 'address', description: 'Verify address link (boss)' }, { command: 'group', description: 'Import group cart (boss)' }, { command: 'bill', description: 'Check repriced bill (boss)' }, ...(ownerPay ? [{ command: 'pay', description: 'Owner UPI test (one attempt)' }, { command: 'paystatus', description: 'Owner payment status' }, { command: 'track', description: 'Owner order tracking' }, { command: 'receipt', description: 'Owner order details' }] : [])]);
    await bot.launch();
    ready = true;
    console.log('Storelex-only Telegram bot active; checkout disabled.');
  } catch (error) {
    server?.close();
    voiceRuntime.uninstall();
    throw error;
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    ready = false;
    voiceRuntime.uninstall();
    bot.stop(signal);
    server?.close();
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error('Storelex-only startup failed:', error.message); process.exitCode = 1; });
}
