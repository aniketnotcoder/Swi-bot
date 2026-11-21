import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { createStorelexClient, StorelexApiError } from '../storelex-api.js';
import { authorizedMobiles, isAdmin } from './config.js';
import { buildBillCard, orderReviewKeyboard, homeMarkup, inlineMarkup, rupeesFromPaise } from './render.js';
import { extractSharedCartId, normalizeAddressResponse, normalizeCreatedAddress, normalizeGroupCartResponse, validateSwiggyLink } from './links.js';
import { createVoiceService } from './voice.js';

const STATE_TTL = 86_400;
const ORDER_TTL = 180 * 86_400;
const ACTIVE_LOCK_TTL = 4 * 60 * 60;
const RATE_LIMIT = 24;
const stateKey = id => `user:${id}:state`;
const profileKey = id => `user:${id}:profile`;
const orderKey = id => `order:${id}`;
const orderIndex = id => `user:${id}:orders`;
const accountLockKey = mobile => `account-lock:${mobile}`;
const pendingPaymentsKey = 'payments:pending';
const leaderboardKey = 'leaderboard:paid-orders';

const safeName = (value, fallback = 'User') => String(value || fallback).replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 60) || fallback;
const normalizeMobile = value => String(value || '').replace(/\D/g, '').slice(-10);
const maskedMobile = value => normalizeMobile(value) ? `••••${normalizeMobile(value).slice(-4)}` : 'linked ID';
const amountFromPaise = value => Number.isFinite(Number(value)) ? Number(value) / 100 : 0;
const callbackToken = () => crypto.randomBytes(6).toString('hex');
const getApi = config => createStorelexClient({ userKey: config.storelexKey });

function cleanTrackingUrl(value) {
  try {
    const u = new URL(String(value || ''));
    if (u.protocol !== 'https:' || !['swiggy.com', 'www.swiggy.com', 'm.swiggy.com'].includes(u.hostname.toLowerCase())) return '';
    return u.toString();
  } catch { return ''; }
}

function validateUpiIntent(value, totalPaise) {
  let url;
  try { url = new URL(String(value || '')); } catch { return { ok: false, reason: 'UPI_URL_INVALID' }; }
  if (url.protocol !== 'upi:' || url.hostname.toLowerCase() !== 'pay') return { ok: false, reason: 'UPI_URL_NOT_OFFICIAL' };
  const payee = String(url.searchParams.get('pa') || '');
  const amount = Number(url.searchParams.get('am'));
  const currency = String(url.searchParams.get('cu') || 'INR').toUpperCase();
  return payee.includes('@') && currency === 'INR' && Number.isFinite(amount) && Math.round(amount * 100) === Number(totalPaise)
    ? { ok: true, url: url.toString() } : { ok: false, reason: 'UPI_AMOUNT_MISMATCH' };
}

function readSessions(payload) {
  const rows = Array.isArray(payload?.sessions) ? payload.sessions : Array.isArray(payload?.data?.sessions) ? payload.data.sessions : [];
  return rows.filter(x => x && typeof x === 'object').map(x => ({ ...x, mobile: normalizeMobile(x.mobile), expired: x.is_expired === true || String(x.status || '').toLowerCase() === 'expired' }))
    .filter(x => /^[6-9]\d{9}$/.test(x.mobile));
}

function paymentRequest(order, { deep = false, manual = false } = {}) {
  return {
    mobile: order.mobile,
    cart_id: order.cartId,
    address_id: order.addressId,
    lat: order.lat,
    lng: order.lng,
    restaurant_id: order.restaurantId,
    cart_value: order.cartValue,
    order_id: order.orderId,
    txn_id: order.txnId,
    method: order.method || 'upi',
    manual: Boolean(manual),
    deep: Boolean(deep)
  };
}

function nextPaymentPollAt(order, now = Date.now()) {
  const started = Number(order.paymentStartedAt || now);
  const elapsed = Math.max(0, now - started);
  const interval = elapsed < 180_000 ? 5_000 : elapsed < 600_000 ? 10_000 : elapsed < 1_200_000 ? 20_000 : 60_000;
  return Math.min(now + interval, started + 86_400_000);
}

export function createOrderBot({ config, kv, telegram, logger = console, voiceService, storelexFactory = getApi, qrCode = QRCode, fetchImpl = globalThis.fetch } = {}) {
  const voice = voiceService || createVoiceService({ telegram, apiKey: config.googleTtsApiKey, voiceName: config.googleTtsVoice, logger });

  async function say(chatId, text, kind = 'generic', data = {}, options = {}) {
    let sent = null;
    try { sent = await telegram.sendMessage(chatId, text, options); }
    catch (error) { logger.warn?.('[OrderBot] Telegram message failed:', error?.code || 'TELEGRAM_ERROR'); }
    if (sent) await voice(chatId, kind, data).catch(() => false);
    return sent;
  }

  async function saveProfile(user, extra = {}) {
    const id = String(user.id);
    const old = await kv.getJson(profileKey(id)).catch(() => null) || {};
    const profile = {
      ...old,
      userId: id,
      displayName: safeName([user.first_name, user.last_name].filter(Boolean).join(' '), `User ${id.slice(-4)}`),
      username: String(user.username || '').slice(0, 64),
      leaderboardOptIn: old.leaderboardOptIn === true,
      updatedAt: new Date().toISOString(),
      ...extra
    };
    await kv.setJson(profileKey(id), profile, { ttlSeconds: ORDER_TTL });
    return profile;
  }

  async function channelMembership(userId, { force = false } = {}) {
    const key = `channel-member:${userId}`;
    if (!force) {
      const cached = await kv.getJson(key).catch(() => null);
      if (cached && Number(cached.expiresAt) > Date.now()) return cached.member === true;
    }
    const member = await telegram.getChatMember(config.requiredChannel, Number(userId));
    const joined = ['creator', 'administrator', 'member'].includes(String(member?.status || '')) || (member?.status === 'restricted' && member?.is_member === true);
    await kv.setJson(key, { member: joined, expiresAt: Date.now() + (joined ? 60_000 : 8_000) }, { ttlSeconds: 120 });
    return joined;
  }

  async function requireChannel(userId, chatId, { force = false } = {}) {
    try {
      if (await channelMembership(userId, { force })) return true;
      await say(chatId, `Pehle ${config.requiredChannel} channel join karo. Join ke baad “Check Joined” dabao.`, 'join', {}, inlineMarkup([
        [{ text: '📢 Channel join karo', url: config.requiredChannelUrl }],
        [{ text: '✅ Check Joined', callback_data: 'gate:check' }]
      ]));
    } catch {
      await say(chatId, 'Channel membership check abhi nahi ho paya. Thodi der baad /start try karo.', 'error', { reason: 'channel check unavailable' });
    }
    return false;
  }

  async function sendHome(chatId, user) {
    const profile = await saveProfile(user);
    await say(chatId, `Assalamu alaikum ${profile.displayName}!\n\nCart link aur address link bhejo, ya neeche ka button chuno.`, 'start', {}, homeMarkup());
    if (!authorizedMobiles(config, user.id).length && !isAdmin(config, user.id)) {
      await say(chatId, 'Is Telegram ID ke liye authorized Swiggy ID link nahi hai. Admin access mapping set karega.', 'error', { reason: 'authorized account mapping missing' });
    }
  }

  async function startNewOrder(chatId, user) {
    if (config.orderFlowEnabled !== true) {
      return say(chatId, 'Order flow paused hai. Admin ke Vercel secrets me VERCEL_ORDER_FLOW_ENABLED=true karne par hi API-backed ordering shuru hogi; abhi koi order/payment request nahi bheji jayegi.', 'error', { reason: 'order feature flag disabled' }, homeMarkup());
    }
    const previous = await kv.getJson(stateKey(user.id)).catch(() => null);
    if (previous && ['PAYMENT_PENDING', 'PAID_CONFIRM_PENDING', 'UNKNOWN', 'SUBMITTING', 'PAYMENT_SETUP_FAILED', 'ADDRESS_ADD_UNKNOWN'].includes(previous.phase)) {
      return say(chatId, 'Pichhla order/address operation abhi unresolved hai. Pehle My Orders ya admin se status verify karo; duplicate request nahi bhejunga.', 'pending', {}, homeMarkup());
    }
    const allowed = authorizedMobiles(config, user.id);
    if (!allowed.length) return say(chatId, 'Order ke liye authorized Swiggy ID abhi linked nahi. Admin se access set karwao.', 'error', {}, homeMarkup());
    let sessions;
    try { sessions = readSessions(await storelexFactory(config).sessions()).filter(s => allowed.includes(s.mobile) && !s.expired); }
    catch { return say(chatId, 'Linked Swiggy IDs abhi load nahi hui. Retry karo; OTP yahan mat bhejo.', 'error', { reason: 'session list unavailable' }, homeMarkup()); }
    if (!sessions.length) return say(chatId, 'Authorized Swiggy ID active nahi mili. Admin session refresh kare; OTP yahan nahi maangenge.', 'error', { reason: 'no active authorized session' }, homeMarkup());
    const session = sessions[0];
    const state = {
      phase: 'ADDRESS', draftId: crypto.randomUUID(), userId: String(user.id),
      accountCandidates: sessions.map(s => ({ mobile: s.mobile, name: safeName(s.name || 'Swiggy ID') })),
      mobile: session.mobile, accountName: safeName(session.name || 'Swiggy ID'), startedAt: Date.now(), attempts: 0
    };
    await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
    const markup = { reply_markup: { keyboard: [[{ text: '📍 Share delivery location', request_location: true }], ['✖ Cancel']], resize_keyboard: true, one_time_keyboard: true } };
    await say(chatId, 'Delivery pin share karo. Phir building/house, area, landmark, receiver name aur phone bhejna hoga.', 'address', {}, markup);
    if (config.addressLinkEnabled === true) await say(chatId, 'Optional: address share link ke liye /addresslink bhejo. Link import alag flag se controlled hai.', 'address');
  }

  async function resolveAddress(chatId, user, state, link) {
    if (config.orderFlowEnabled !== true || config.addressLinkEnabled !== true) return say(chatId, 'Address link import off hai. Map location share karke manual address add karo.', 'error', { reason: 'address link feature flag disabled' });
    const valid = validateSwiggyLink(link, 'address');
    if (!valid.ok) return say(chatId, 'Ye valid Swiggy address share link nahi lag raha. Swiggy se naya address link bhejo.', 'address');
    state.addressLink = valid.value;
    state.phase = 'ADDRESS_RETRY';
    await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
    let response;
    try { response = await storelexFactory(config).resolveAddressByLink({ mobile: state.mobile, link: valid.value }, { timeoutMs: 45_000 }); }
    catch (error) {
      return say(chatId, 'Address API abhi fail hui. Link saved hai—Retry dabao ya naya address link bhejo.', 'error', { reason: error?.code || 'address API failed' }, inlineMarkup([
        [{ text: '↻ Retry address', callback_data: `retry:address:${state.draftId.slice(0, 10)}` }],
        [{ text: 'Naya address link', callback_data: `input:address:${state.draftId.slice(0, 10)}` }]
      ]));
    }
    const normalized = normalizeAddressResponse(response);
    if (!normalized.ok) {
      if (normalized.dropStoredSelection) {
        state.address = null; state.addressLink = ''; state.phase = 'ADDRESS';
        await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
        return say(chatId, 'Saved source address ab nahi mila. Stored address selection hata di; fresh map pin share karo.', 'address');
      }
      if (normalized.reason === 'EXPIRED') {
        state.phase = 'ADDRESS'; state.addressLink = '';
        await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
        return say(chatId, 'Address share link expire ho gaya. Naya address link bhejo.', 'address');
      }
      return say(chatId, 'Storelex response me address ID/coordinates verify nahi hue. Link saved hai; Retry ya naya address link bhejo.', 'error', { reason: 'address response incomplete' }, inlineMarkup([
        [{ text: '↻ Retry address', callback_data: `retry:address:${state.draftId.slice(0, 10)}` }],
        [{ text: 'Naya address link', callback_data: `input:address:${state.draftId.slice(0, 10)}` }]
      ]));
    }
    state.address = normalized.address;
    state.phase = 'CART';
    await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
    await say(chatId, `${normalized.existing ? 'Address pehle se account par tha; select ho gaya.' : 'Address account me add aur select ho gaya.'}\n${state.address.formattedAddress || 'Verified delivery location'}\n\nAb Swiggy group-cart share link bhejo.`, 'address', {}, homeMarkup());
  }

  async function addManualAddress(chatId, user, state, details) {
    const fields = String(details || '').split('|').map(value => value.trim());
    if (fields.length !== 5 || fields.some(value => !value) || !/^[6-9]\d{9}$/.test(fields[4].replace(/\D/g, '').slice(-10))) {
      return say(chatId, 'Is format me bhejo: building/house | area | landmark (optional ke liye -) | receiver name | 10-digit receiver phone', 'address');
    }
    const [flatNo, area, landmarkRaw, receiverName, receiverPhoneRaw] = fields;
    const location = state.pendingCoordinates;
    const lat = Number(location?.lat); const lng = Number(location?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 6 || lat > 38 || lng < 67 || lng > 98) {
      state.phase = 'ADDRESS'; state.pendingCoordinates = null;
      await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
      return say(chatId, 'Valid India delivery pin nahi mila. Location dobara share karo.', 'address');
    }
    if (landmarkRaw === '-') fields[2] = '';
    const body = {
      mobile: state.mobile,
      name: safeName(receiverName, 'Receiver'),
      receiver_mobile: receiverPhoneRaw.replace(/\D/g, '').slice(-10),
      flat_no: flatNo.slice(0, 100),
      address: [flatNo, area].filter(Boolean).join(', ').slice(0, 400),
      area: area.slice(0, 180),
      landmark: fields[2].slice(0, 180),
      lat: String(lat), lng: String(lng)
    };
    state.phase = 'ADDRESS_ADDING';
    await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
    let response;
    try { response = await storelexFactory(config).addAddress(body, { timeoutMs: 45_000 }); }
    catch (error) {
      state.phase = 'ADDRESS_ADD_UNKNOWN';
      state.addressAddUnknownAt = Date.now();
      await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
      return say(chatId, 'Address add ka response clear nahi mila. Duplicate address request nahi bhejunga; pehle Swiggy saved addresses/admin se verify karo. Order place nahi hua.', 'pending', { reason: error?.code || 'address add outcome unknown' }, homeMarkup());
    }
    const created = normalizeCreatedAddress(response, body);
    if (!created.ok) {
      state.phase = 'ADDRESS_DETAILS';
      await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
      return say(chatId, 'Address add response me Swiggy address ID verify nahi hui. Checkout nahi khulega; details retry karo ya admin se check karwao.', 'error', { reason: 'address id missing' });
    }
    state.address = created.address;
    state.pendingCoordinates = null;
    state.phase = 'CART';
    await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
    await say(chatId, `Manual address account me add/select ho gaya.\n${state.address.formattedAddress || body.address}\n\nAb Swiggy group-cart share link bhejo.`, 'address', {}, homeMarkup());
  }

  async function buildQuote(chatId, user, state, { announce = true } = {}) {
    if (config.orderFlowEnabled !== true) return false;
    if (!state.address?.id || !state.restaurant?.id || !state.items?.length || !state.cartId) {
      state.phase = 'CART'; await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
      if (announce) await say(chatId, 'Cart ya address details adhure hain. Naya cart link bhejo; address saved hai.', 'error', { reason: 'cart data incomplete' });
      return false;
    }
    const restaurant = {
      id: state.restaurant.id, parent_id: state.restaurant.parent_id, name: state.restaurant.name,
      image: state.restaurant.image, area: state.restaurant.area, sla: state.restaurant.sla,
      request_contexts: state.restaurant.request_contexts
    };
    const items = state.items.map(item => ({
      id: item.id, name: item.name, image_id: item.image_id, price: item.price,
      base_price: item.base_price ?? item.price, quantity: item.quantity,
      addons: Array.isArray(item.addons) ? item.addons : [],
      variants: Array.isArray(item.variants) ? item.variants : [],
      cart_context: item.cart_context ?? {}, offer_ids: Array.isArray(item.offer_ids) ? item.offer_ids : [],
      nudge_type: item.nudge_type ?? ''
    }));
    const body = {
      mobile: state.mobile, restaurant, items, address_id: state.address.id, cart_id: state.cartId,
      lat: state.address.lat, lng: state.address.lng, cooking: false, incognito: true, plan_id: ''
    };
    let quote;
    try {
      quote = await storelexFactory(config).repriceCart(body);
      if (quote?.is_expired === true) {
        state.phase = 'CART'; await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
        if (announce) await say(chatId, 'Swiggy session/cart expire ho gaya. Naya cart link bhejo; session refresh ke liye admin se bolo. OTP mat bhejo.', 'error', { reason: 'session expired' });
        return false;
      }
      if (quote?.success !== true) throw new StorelexApiError(String(quote?.error || 'Cart reprice failed.'), { code: 'STORELEX_CART_REPRICE_FAILED' });
    } catch (error) {
      state.phase = 'CART_RETRY'; state.repriceBody = body;
      await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
      if (announce) await say(chatId, 'Current bill API se verify nahi hua. Cart/address saved hain—Retry bill dabao.', 'error', { reason: error?.code || 'bill unavailable' }, inlineMarkup([
        [{ text: '↻ Retry bill', callback_data: `retry:bill:${state.draftId.slice(0, 10)}` }],
        [{ text: 'Naya cart link', callback_data: `input:cart:${state.draftId.slice(0, 10)}` }]
      ]));
      return false;
    }
    const unavailable = Array.isArray(quote.items) ? quote.items.filter(item => item && item.in_stock !== true && item.free !== true) : [];
    if (unavailable.length) {
      state.phase = 'CART'; state.cartLink = '';
      await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
      if (announce) await say(chatId, 'Swiggy cart me unavailable item hai. Cart update karke naya group link bhejo; checkout roka hai.', 'error', { reason: 'out of stock item' });
      return false;
    }
    const pricedIds = Array.isArray(quote.items) ? quote.items.map(item => String(item?.id ?? '')).sort() : [];
    const importedIds = state.items.map(item => String(item?.id ?? '')).sort();
    if (!Array.isArray(quote.items) || pricedIds.length !== importedIds.length || pricedIds.some((id, i) => !id || id !== importedIds[i])) {
      state.phase = 'CART_RETRY'; await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
      if (announce) await say(chatId, 'Fresh priced cart ke item IDs imported cart se match nahi hue. Wrong-item checkout se bachne ke liye review roka hai.', 'error', { reason: 'priced items mismatch' });
      return false;
    }
    const cartValue = Number(quote.cart_value);
    const cartId = String(quote.cart_id || state.cartId);
    const restaurantId = String(state.restaurant.id || '');
    if (!Number.isSafeInteger(cartValue) || cartValue < 0 || !cartId || !restaurantId) {
      state.phase = 'CART_RETRY'; await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
      if (announce) await say(chatId, 'Storelex reprice response me required cart ID/value nahi mile. Checkout roka hai.', 'error', { reason: 'cart metadata missing' });
      return false;
    }
    const bill = buildBillCard({ restaurant: state.restaurant, items: state.items, quote, coupon: quote.coupon || null, accountLabel: maskedMobile(state.mobile) });
    if (!Array.isArray(quote.bill_lines) || quote.bill_lines.length === 0) {
      state.phase = 'CART_RETRY'; await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
      if (announce) await say(chatId, 'Storelex ne bill breakdown nahi diya. Transparent bill ke bina checkout nahi khulega.', 'error', { reason: 'bill lines missing' });
      return false;
    }
    const changed = state.phase === 'REVIEW' && Number(state.totalPaise) !== bill.totalPaise;
    Object.assign(state, { cartId, cartValue, restaurantId, quote, quoteRequest: body, totalPaise: bill.totalPaise, phase: 'REVIEW', reviewToken: callbackToken(), updatedAt: Date.now() });
    await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
    const hasAlternative = state.accountCandidates.some(candidate => candidate.mobile !== state.mobile);
    await say(chatId, `${changed ? 'Bill badla hai—fresh total dobara check karo.\n\n' : ''}${bill.text}`, 'bill', { amount: amountFromPaise(bill.totalPaise) }, { ...inlineMarkup(orderReviewKeyboard(state.reviewToken, hasAlternative)), parse_mode: 'HTML' });
    return true;
  }

  async function importCart(chatId, user, state, link) {
    if (config.orderFlowEnabled !== true) return say(chatId, 'Cart link accept nahi hua: order feature flag abhi off hai.', 'error', { reason: 'order feature flag disabled' });
    const valid = validateSwiggyLink(link, 'cart');
    if (!valid.ok) return say(chatId, 'Valid Swiggy group-cart link nahi lag raha. Address saved hai—naya cart share link bhejo.', 'error', { reason: 'invalid cart link' });
    state.cartLink = valid.value; state.phase = 'CART_RETRY';
    await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
    let response;
    try {
      const api = storelexFactory(config);
      const body = { mobile: state.mobile, link: valid.value, address_id: state.address.id, lat: state.address.lat, lng: state.address.lng, leave_old: false };
      response = await api.importGroupCart(body, { timeoutMs: 30_000 });
      if (response?.success === false && response?.already_in_group === true) response = await api.importGroupCart({ ...body, leave_old: true }, { timeoutMs: 45_000 });
    } catch (error) {
      return say(chatId, 'Cart import API abhi fail hui. Link saved hai—Retry cart dabao; dobara paste nahi chahiye.', 'error', { reason: error?.code || 'cart import failed' }, inlineMarkup([
        [{ text: '↻ Retry cart', callback_data: `retry:cart:${state.draftId.slice(0, 10)}` }],
        [{ text: 'Naya cart link', callback_data: `input:cart:${state.draftId.slice(0, 10)}` }]
      ]));
    }
    const normalized = normalizeGroupCartResponse(response);
    if (!normalized.ok) {
      state.phase = 'CART'; state.cartLink = '';
      await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
      if (response?.is_expired === true) return say(chatId, 'Cart/session expire ho gaya. Naya cart link bhejo ya admin se session refresh karwao.', 'error', { reason: 'cart or session expired' });
      if (normalized.reason === 'ALREADY_IN_GROUP') return say(chatId, 'Purana group cart clear nahi hua. Naya group cart banao aur link bhejo.', 'error', { reason: 'already in group after leave_old retry' });
      if (normalized.reason === 'ITEMS_SKIPPED') return say(chatId, 'Kuch items import nahi hue; adhoore cart ka order nahi banega. Swiggy cart update karke naya link bhejo.', 'error', { reason: 'skipped items' });
      state.phase = 'CART_RETRY'; await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
      return say(chatId, 'Storelex ne complete restaurant/items data nahi diya. Retry cart dabao; internal error par naya link na banao.', 'error', { reason: 'cart response incomplete' }, inlineMarkup([[{ text: '↻ Retry cart', callback_data: `retry:cart:${state.draftId.slice(0, 10)}` }]]));
    }
    const cartId = normalized.cartId || extractSharedCartId(valid.value);
    if (!cartId) {
      state.phase = 'CART_RETRY'; await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
      return say(chatId, 'Group cart se cart ID verify nahi hui. Link parser se guess nahi karunga; API/admin setup check chahiye.', 'error', { reason: 'cart id missing' });
    }
    state.restaurant = normalized.restaurant; state.items = normalized.items; state.cartId = cartId; state.phase = 'REPRICING';
    await kv.setJson(stateKey(user.id), state, { ttlSeconds: STATE_TTL });
    await buildQuote(chatId, user, state);
  }

  async function retryStep(chatId, user, state, step) {
    if (step === 'address' && state.addressLink) return resolveAddress(chatId, user, state, state.addressLink);
    if (step === 'cart' && state.cartLink) return importCart(chatId, user, state, state.cartLink);
    if (step === 'bill' && state.restaurant && state.items?.length) return buildQuote(chatId, user, state);
    return say(chatId, 'Saved input nahi mila. Naya link bhejo.', 'error', { reason: 'retry input missing' });
  }

  async function repriceForAccept(chatId, user, state) {
    const ok = await buildQuote(chatId, user, { ...state, phase: 'REVIEW' }, { announce: false });
    if (!ok) return false;
    const fresh = await kv.getJson(stateKey(user.id));
    if (!fresh || Number(fresh.totalPaise) !== Number(state.totalPaise)) return false;
    Object.assign(state, fresh);
    return true;
  }

  function makeOrderRecord(state, user, placement, status) {
    return {
      orderId: String(placement?.order_id || state.orderId || state.draftId), draftId: state.draftId,
      userId: String(user.id), displayName: safeName([user.first_name, user.last_name].filter(Boolean).join(' ')),
      mobile: state.mobile, accountMask: maskedMobile(state.mobile), addressId: state.address.id,
      lat: state.address.lat, lng: state.address.lng, restaurantId: state.restaurantId, cartValue: state.cartValue,
      method: String(placement?.method || 'upi'),
      addressSummary: String(state.address.formattedAddress || '').slice(0, 180),
      addressName: String(state.address.name || '').slice(0, 80), addressPhone: state.address.receiverMobile,
      restaurant: safeName(state.restaurant?.name || 'Restaurant'),
      items: state.items.map(i => ({ name: String(i.name || 'Item').slice(0, 90), quantity: Math.max(1, Number(i.quantity || 1)) })),
      totalPaise: Number(state.totalPaise), coupon: state.quote?.coupon?.valid === true ? String(state.quote.coupon.code || '').slice(0, 40) : '',
      status, paymentStatus: status === 'PAYMENT_PENDING' ? 'PENDING' : status,
      txnId: String(placement?.txn_id || state.txnId || ''), cartId: state.cartId,
      createdAt: new Date().toISOString(), paymentStartedAt: Date.now(), paymentChecks: 0,
      trackingLink: cleanTrackingUrl(placement?.finalized?.tracking_link || ''), apiOrderStatus: '', paidCounted: false
    };
  }

  async function acceptOrder(chatId, user, token) {
    if (config.orderFlowEnabled !== true) return say(chatId, 'Checkout paused hai: VERCEL_ORDER_FLOW_ENABLED feature flag off hai. Koi order place nahi kiya.', 'error', { reason: 'order feature flag disabled' });
    const userId = String(user.id);
    const state = await kv.getJson(stateKey(userId));
    if (!state || state.phase !== 'REVIEW' || state.reviewToken !== token) return say(chatId, 'Ye bill purana hai. /start se fresh bill dekho.', 'error', { reason: 'stale bill' });
    const placeLock = `place-lock:${state.draftId}`;
    if (!(await kv.setJson(placeLock, { state: 'SUBMITTING', at: Date.now() }, { nx: true, ttlSeconds: ACTIVE_LOCK_TTL }))) return say(chatId, 'Checkout process me hai—dobara tap mat karo. Status check ho raha hai.', 'pending');
    const accountLock = accountLockKey(state.mobile);
    if (!(await kv.setJson(accountLock, { userId, draftId: state.draftId, stage: 'CHECKOUT', at: Date.now() }, { nx: true, ttlSeconds: ACTIVE_LOCK_TTL }))) {
      await kv.del(placeLock).catch(() => {});
      return say(chatId, 'Ye Swiggy ID pehle se active checkout me locked hai. Pehle us order ka status check karo.', 'error', { reason: 'account already locked' });
    }
    state.phase = 'SUBMITTING'; await kv.setJson(stateKey(userId), state, { ttlSeconds: ACTIVE_LOCK_TTL });
    await say(chatId, 'Bill amount ek baar aur Storelex se verify kar raha hoon…', 'bill', { amount: amountFromPaise(state.totalPaise) });
    if (!(await repriceForAccept(chatId, user, state).catch(() => false))) {
      await kv.del(placeLock).catch(() => {}); await kv.del(accountLock).catch(() => {});
      const latest = await kv.getJson(stateKey(userId));
      if (latest && latest.phase !== 'REVIEW') { latest.phase = 'CART_RETRY'; await kv.setJson(stateKey(userId), latest, { ttlSeconds: STATE_TTL }); }
      return;
    }
    const quote = state.quote;
    const toRupees = paise => Number.isSafeInteger(Number(paise)) && Number(paise) >= 0 ? Number((Number(paise) / 100).toFixed(2)) : null;
    const snapItems = state.items.map(i => ({
      name: String(i.name || '').slice(0, 120), quantity: Number(i.quantity), price: toRupees(i.price),
      veg: i.is_veg === true, variants: (i.variants || []).map(v => String(v.name || '').slice(0, 80)),
      addons: (i.addons || []).map(a => ({ name: String(a.name || '').slice(0, 80), price: toRupees(a.price) }))
    }));
    if (snapItems.some(i => !i.name || !Number.isSafeInteger(i.quantity) || i.quantity < 1 || i.price === null || i.addons.some(a => a.price === null))) {
      await kv.del(placeLock).catch(() => {}); await kv.del(accountLock).catch(() => {});
      state.phase = 'REVIEW'; await kv.setJson(stateKey(userId), state, { ttlSeconds: STATE_TTL });
      return say(chatId, 'Checkout snap item details incomplete hain. Order place nahi kiya; bill review me hi hai.', 'error', { reason: 'snap item mapping incomplete' });
    }
    const placeBody = {
      mobile: state.mobile, cart_id: state.cartId, address_id: state.address.id,
      lat: state.address.lat, lng: state.address.lng, restaurant_id: state.restaurantId, cart_value: state.cartValue,
      amount: Number((Number(state.totalPaise) / 100).toFixed(2)), method: 'upi',
      snap: {
        restaurant: state.restaurant, account_name: state.accountName, items: snapItems,
        bill_lines: quote.bill_lines.map(line => ({ label: String(line.label || ''), value: String(line.value ?? ''), negative: line.negative, total: line.total })),
        coupon: quote.coupon || null, cooking: false,
        address: { text: state.address.formattedAddress, name: state.address.name, phone: state.address.receiverMobile }
      }
    };
    let result;
    try { result = await storelexFactory(config).placeOrder(placeBody, { timeoutMs: 45_000 }); }
    catch (error) {
      state.phase = 'UNKNOWN'; state.lastErrorCode = String(error?.code || 'STORELEX_NETWORK_ERROR'); state.unknownAt = Date.now();
      await kv.setJson(stateKey(userId), state, { ttlSeconds: ACTIVE_LOCK_TTL });
      await kv.setJson(placeLock, { state: 'UNKNOWN', at: Date.now(), errorCode: state.lastErrorCode }, { ttlSeconds: ACTIVE_LOCK_TTL });
      await kv.setJson(accountLock, { userId, draftId: state.draftId, stage: 'UNKNOWN', at: Date.now() }, { ttlSeconds: ACTIVE_LOCK_TTL });
      return say(chatId, 'Checkout ka response clear nahi mila. Safety ke liye dobara order place nahi karunga. Admin Storelex order status reconcile kare.', 'pending', {}, homeMarkup());
    }
    if (result?.amount_changed === true) {
      await kv.del(placeLock).catch(() => {}); await kv.del(accountLock).catch(() => {});
      state.phase = 'REVIEW'; await kv.setJson(stateKey(userId), state, { ttlSeconds: STATE_TTL });
      await say(chatId, 'Storelex ne amount change bataya. Koi order place nahi hua; /search/cart se naya bill la raha hoon. Fresh amount dekh kar dobara confirm karo.', 'error', { reason: 'amount changed' });
      await buildQuote(chatId, user, state);
      return;
    }
    if (result?.unconfirmed === true) {
      state.phase = 'UNKNOWN'; state.orderId = String(result.order_id || ''); state.txnId = String(result.txn_id || '');
      await kv.setJson(stateKey(userId), state, { ttlSeconds: ACTIVE_LOCK_TTL });
      await kv.setJson(placeLock, { state: 'UNKNOWN', orderId: state.orderId, at: Date.now() }, { ttlSeconds: ACTIVE_LOCK_TTL });
      await kv.setJson(accountLock, { userId, orderId: state.orderId, draftId: state.draftId, stage: 'UNKNOWN', at: Date.now() }, { ttlSeconds: ACTIVE_LOCK_TTL });
      if (state.orderId) {
        const record = makeOrderRecord(state, user, result, 'UNKNOWN');
        await kv.setJson(orderKey(state.orderId), record, { ttlSeconds: ORDER_TTL });
        await kv.zAdd(orderIndex(userId), Date.now(), state.orderId);
      }
      return say(chatId, 'Storelex ke mutabik order Swiggy par ho sakta hai, par confirm nahi hua. Dobara ACCEPT mat dabao; admin se reconcile karwao.', 'pending', {}, homeMarkup());
    }
    if (result?.success !== true) {
      await kv.del(placeLock).catch(() => {}); await kv.del(accountLock).catch(() => {});
      state.phase = 'REVIEW'; await kv.setJson(stateKey(userId), state, { ttlSeconds: STATE_TTL });
      return say(chatId, `Order place nahi hua: ${String(result?.error || 'Storelex request rejected').slice(0, 220)}`, 'error', { reason: 'checkout rejected' });
    }
    const orderId = String(result.order_id || '').trim();
    const txnId = String(result.txn_id || '').trim();
    const upi = validateUpiIntent(result.upi_url, state.totalPaise);
    if (!orderId || !txnId || String(result.method || '').toLowerCase() !== 'upi' || !upi.ok) {
      state.phase = 'PAYMENT_SETUP_FAILED'; state.orderId = orderId; state.txnId = txnId;
      const record = makeOrderRecord(state, user, result, 'PAYMENT_SETUP_FAILED');
      await kv.setJson(orderKey(orderId || state.draftId), record, { ttlSeconds: ORDER_TTL });
      if (orderId) await kv.zAdd(orderIndex(userId), Date.now(), orderId);
      await kv.setJson(stateKey(userId), state, { ttlSeconds: ACTIVE_LOCK_TTL });
      await kv.setJson(placeLock, { state: 'PLACED_NO_VALID_QR', orderId, at: Date.now() }, { ttlSeconds: ACTIVE_LOCK_TTL });
      await kv.setJson(accountLock, { userId, orderId, stage: 'PAYMENT_SETUP_FAILED', at: Date.now() }, { ttlSeconds: ACTIVE_LOCK_TTL });
      return say(chatId, 'Order reference ya exact UPI amount verify nahi hua. Fake QR nahi bana; order dobara place nahi hoga. Admin Storelex status check kare.', 'error', { reason: upi.reason || 'order reference missing' });
    }
    Object.assign(state, { phase: 'PAYMENT_PENDING', orderId, txnId, upiUrl: upi.url, paymentToken: callbackToken(), paymentStartedAt: Date.now(), autoPollCount: 0 });
    const order = makeOrderRecord(state, user, result, 'PAYMENT_PENDING');
    order.paymentToken = state.paymentToken;
    order.paymentStartedAt = state.paymentStartedAt;
    await kv.setJson(orderKey(orderId), order, { ttlSeconds: ORDER_TTL });
    await kv.zAdd(orderIndex(userId), Date.now(), orderId);
    await kv.zAdd(pendingPaymentsKey, Date.now(), orderId);
    await kv.setJson(stateKey(userId), state, { ttlSeconds: ACTIVE_LOCK_TTL });
    await kv.setJson(placeLock, { state: 'PAYMENT_PENDING', orderId, at: Date.now() }, { ttlSeconds: ACTIVE_LOCK_TTL });
    await kv.setJson(accountLock, { userId, orderId, stage: 'PAYMENT_PENDING', at: Date.now() }, { ttlSeconds: ACTIVE_LOCK_TTL });
    order.nextPollAt = nextPaymentPollAt(order, Date.now());
    await kv.zAdd(pendingPaymentsKey, order.nextPollAt, orderId);
    await scheduleQStashCheck(order, Math.max(1, Math.ceil((order.nextPollAt - Date.now()) / 1000)));
    await sendPaymentQr(chatId, state, order);
  }

  async function sendPaymentQr(chatId, state, order) {
    const text = `💳 Payment ready\nOrder: ${order.orderId}\nAmount: ${rupeesFromPaise(order.totalPaise)}\n\nSwiggy ka authentic UPI QR scan karo. Payment ke baad “Payment check” dabao; confirmation API se hoga.`;
    let image;
    try { image = await qrCode.toBuffer(state.upiUrl, { type: 'png', errorCorrectionLevel: 'M', margin: 2, width: 420 }); } catch { image = null; }
    const buttons = inlineMarkup([[{ text: '✅ Payment check', callback_data: `payment:check:${state.paymentToken}` }]]);
    if (!image) return say(chatId, `${text}\n\nQR image nahi ban payi. Fake QR nahi banaya; admin se check karwao.`, 'error', { reason: 'QR render failed' }, buttons);
    try {
      await telegram.sendPhoto(chatId, image, 'storelex-payment.png', text, buttons.reply_markup);
      await voice(chatId, 'qr', { amount: amountFromPaise(order.totalPaise) }).catch(() => false);
    } catch { await say(chatId, `${text}\nQR image Telegram tak nahi pahunchi. My Orders me status check karo; dobara order create nahi hoga.`, 'error', { reason: 'QR delivery failed' }, buttons); }
  }

  async function releaseAccountLock(order) {
    const key = accountLockKey(order.mobile);
    const lock = await kv.getJson(key).catch(() => null);
    if (lock && String(lock.orderId || '') === String(order.orderId)) await kv.del(key).catch(() => {});
  }

  async function scheduleNextPaymentCheck(order) {
    const start = Number(order.paymentStartedAt || Date.now());
    if (Date.now() >= start + 24 * 60 * 60_000) {
      order.autoPollingStoppedAt = Date.now();
      await kv.zRem(pendingPaymentsKey, order.orderId).catch(() => {});
      return false;
    }
    order.nextPollAt = nextPaymentPollAt(order);
    await kv.zAdd(pendingPaymentsKey, order.nextPollAt, order.orderId);
    await scheduleQStashCheck(order, Math.max(1, Math.ceil((order.nextPollAt - Date.now()) / 1000)));
    return true;
  }

  async function scheduleQStashCheck(order, delaySeconds) {
    const token = String(config.qstashToken || '');
    const secret = String(config.cronSecret || '');
    let host = String(config.publicAppUrl || '').trim();
    if (!token || !secret || !host || typeof fetchImpl !== 'function') return { scheduled: 0, skipped: true };
    if (!/^https:\/\//i.test(host)) host = `https://${host}`;
    let destination;
    try {
      const url = new URL(host);
      if (url.protocol !== 'https:' || !/(^|\.)vercel\.app$/i.test(url.hostname) || url.username || url.password) return { scheduled: 0, skipped: true };
      destination = `${url.origin}/api/payment-poll`;
    } catch { return { scheduled: 0, skipped: true }; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    timer.unref?.();
    try {
      const delay = Math.max(1, Math.min(86_400, Math.ceil(Number(delaySeconds) || 1)));
      const endpoint = `https://qstash.upstash.io/v2/publish/${encodeURIComponent(destination)}?delay=${delay}s`;
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Upstash-Forward-Authorization': `Bearer ${secret}`
        },
        body: JSON.stringify({ order_id: String(order.orderId) }),
        signal: controller.signal
      });
      if (!response.ok) logger.warn?.('[OrderBot] QStash enqueue failed:', String(response.status));
      await response.text?.().catch(() => {});
      return { scheduled: response.ok ? 1 : 0, skipped: false };
    } catch (error) {
      logger.warn?.('[OrderBot] QStash enqueue failed:', String(error?.code || 'QSTASH_ERROR').slice(0, 60));
      return { scheduled: 0, skipped: false };
    } finally { clearTimeout(timer); }
  }

  async function countPaidOrderOnce(order) {
    const lockKey = `paid-count-lock:${order.orderId}`;
    const gotLock = await kv.setJson(lockKey, { at: Date.now() }, { nx: true, ttlSeconds: 30 });
    if (!gotLock) return false;
    try {
      const key = profileKey(order.userId);
      const profile = await kv.getJson(key) || { userId: order.userId, displayName: order.displayName, leaderboardOptIn: false };
      const counted = Array.isArray(profile.countedOrderIds) && profile.countedOrderIds.includes(String(order.orderId));
      const marker = await kv.getJson(`paid-counted:${order.orderId}`);
      if (!counted && !marker) {
        profile.successfulOrders = Number(profile.successfulOrders || 0) + 1;
        profile.totalSpentPaise = Number(profile.totalSpentPaise || 0) + Number(order.totalPaise || 0);
        profile.countedOrderIds = [...(Array.isArray(profile.countedOrderIds) ? profile.countedOrderIds : []), String(order.orderId)].slice(-500);
        profile.updatedAt = new Date().toISOString();
        await kv.setJson(key, profile, { ttlSeconds: ORDER_TTL });
        await kv.setJson(`paid-counted:${order.orderId}`, { at: Date.now() }, { nx: true, ttlSeconds: ORDER_TTL });
      }
      await kv.zAdd(`user:${order.userId}:paid-orders`, Number(profile.successfulOrders || 0), order.orderId);
      await kv.zAdd(leaderboardKey, Number(profile.successfulOrders || 0), order.userId);
      return true;
    } finally { await kv.del(lockKey).catch(() => {}); }
  }

  async function finalizePaid(order) {
    const api = storelexFactory(config);
    let response = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try { response = await api.confirmPayment(paymentRequest(order), { timeoutMs: 8_000 }); }
      catch { response = null; }
      if (response?.confirmed === true || response?.order_failed === true) break;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 3_000));
    }
    if (response?.order_failed === true) {
      order.status = 'ORDER_FAILED_REFUND_AUTO'; order.paymentStatus = 'REFUND_AUTOMATIC';
      await kv.setJson(orderKey(order.orderId), order, { ttlSeconds: ORDER_TTL });
      await kv.zRem(pendingPaymentsKey, order.orderId).catch(() => {}); await releaseAccountLock(order);
      await say(order.userId, `Swiggy ne order ${order.orderId} fail confirm kiya. Storelex ke mutabik refund automatic hai. Dobara pay mat karo.`, 'error');
      return { outcome: 'ORDER_FAILED_REFUND_AUTO' };
    }
    if (response?.success !== true || response?.confirmed !== true) {
      order.status = 'PAID_CONFIRM_PENDING'; order.paymentStatus = 'PAID_PROVIDER_CONFIRM_PENDING';
      await scheduleNextPaymentCheck(order); await kv.setJson(orderKey(order.orderId), order, { ttlSeconds: ORDER_TTL });
      await say(order.userId, 'Payment response paid tha, lekin confirmation conclusive nahi. Pending rakha hai—dobara pay/order mat karo.', 'pending');
      return { outcome: 'CONFIRM_PENDING' };
    }
    order.paymentStatus = 'PAID'; order.status = 'PAID'; order.paidAt ||= new Date().toISOString();
    await kv.setJson(orderKey(order.orderId), order, { ttlSeconds: ORDER_TTL });
    await countPaidOrderOnce(order);
    await kv.zRem(pendingPaymentsKey, order.orderId).catch(() => {});
    let status = null;
    try { status = await api.orderStatus({ order_id: order.orderId }); } catch {}
    const tracking = status?.success === true ? cleanTrackingUrl(status.tracking_link) : '';
    order.apiOrderStatus = String(status?.success === true ? status.status || 'Order placed' : 'Order placed').slice(0, 80);
    order.eta = String(status?.success === true ? status.eta || '' : '').slice(0, 40);
    if (tracking) order.trackingLink = tracking;
    if (status?.success === true && status.final === true) { order.status = 'COMPLETED'; await releaseAccountLock(order); }
    await kv.setJson(orderKey(order.orderId), order, { ttlSeconds: ORDER_TTL });
    await say(order.userId, `✅ Payment verified\nOrder ${order.orderId} · ${order.restaurant}\nStatus: ${order.apiOrderStatus}${order.eta ? ` · ETA ${order.eta}` : ''}${tracking ? `\nTracking: ${tracking}` : '\nTracking link abhi API se nahi aaya; baad me My Orders check karo.'}`, tracking ? 'tracking' : 'paid', {}, tracking ? inlineMarkup([[{ text: '🔗 Swiggy tracking kholo', url: tracking }]]) : homeMarkup());
    return { outcome: 'PAID' };
  }

  async function checkPaymentUnlocked(chatId, userId, token, { manual = true } = {}) {
    const state = await kv.getJson(stateKey(userId));
    if (!state?.orderId || state.paymentToken !== token) {
      if (manual) await say(chatId, 'Ye payment card purana hai. My Orders se current status dekho.', 'error'); return { outcome: 'STALE' };
    }
    const order = await kv.getJson(orderKey(state.orderId));
    if (!order || String(order.userId) !== String(userId)) { if (manual) await say(chatId, 'Order nahi mila ya tumhara nahi hai.', 'error'); return { outcome: 'NOT_FOUND' }; }
    if (order.paymentStatus === 'PAID') {
      await countPaidOrderOnce(order);
      if (manual) await say(chatId, `Payment verified hai. Order ${order.orderId}: ${order.apiOrderStatus || order.status}${order.trackingLink ? `\nTracking: ${order.trackingLink}` : ''}`, 'paid');
      return { outcome: 'PAID' };
    }
    const nextCheck = Number(order.paymentChecks || 0) + 1;
    let result;
    try { result = await storelexFactory(config).paymentStatus(paymentRequest(order, { manual, deep: nextCheck % 4 === 0 }), { timeoutMs: 20_000 }); }
    catch {
      order.paymentChecks = nextCheck; order.lastPaymentCheckAt = Date.now();
      await scheduleNextPaymentCheck(order); await kv.setJson(orderKey(order.orderId), order, { ttlSeconds: ORDER_TTL });
      if (manual) await say(chatId, 'Swiggy se payment status pooch nahi paaya. Order pending—dobara pay mat karo.', 'pending');
      return { outcome: 'INCONCLUSIVE' };
    }
    order.paymentChecks = nextCheck; order.lastPaymentCheckAt = Date.now();
    if (result?.is_expired === true) {
      order.paymentStatus = 'STATUS_CHECK_EXPIRED'; await scheduleNextPaymentCheck(order); await kv.setJson(orderKey(order.orderId), order, { ttlSeconds: ORDER_TTL });
      if (manual) await say(chatId, 'Payment status session expire hua; outcome unknown/pending hai. Admin se refresh karwao—dobara pay mat karo.', 'pending');
      return { outcome: 'INCONCLUSIVE' };
    }
    if (result?.success === true && result.order_failed === true) {
      order.status = 'ORDER_FAILED_REFUND_AUTO'; order.paymentStatus = 'REFUND_AUTOMATIC';
      await kv.setJson(orderKey(order.orderId), order, { ttlSeconds: ORDER_TTL });
      await kv.zRem(pendingPaymentsKey, order.orderId).catch(() => {}); await releaseAccountLock(order);
      state.phase = 'ORDER_FAILED'; await kv.setJson(stateKey(userId), state, { ttlSeconds: ORDER_TTL });
      await say(chatId, 'Swiggy ne order failed confirm kiya. Storelex ke mutabik refund automatic hai—dobara pay mat karo.', 'error');
      return { outcome: 'ORDER_FAILED_REFUND_AUTO' };
    }
    if (result?.success === true && result.paid === true) {
      order.paymentStatus = 'PAID_PROVIDER_CONFIRM_PENDING'; await kv.setJson(orderKey(order.orderId), order, { ttlSeconds: ORDER_TTL });
      return finalizePaid(order);
    }
    if (result?.success === true && result.failed === true) {
      order.status = 'PAYMENT_FAILED'; order.paymentStatus = 'PAYMENT_FAILED_REFUND_REVIEW';
      await kv.setJson(orderKey(order.orderId), order, { ttlSeconds: ORDER_TTL });
      await kv.zRem(pendingPaymentsKey, order.orderId).catch(() => {});
      if (manual) await say(chatId, 'Storelex ne payment failed report kiya. Refund/settlement review pending hai—dobara pay/order mat karo; admin check karega.', 'pending');
      return { outcome: 'FAILED_REVIEW' };
    }
    order.paymentStatus = result?.inconclusive === true || result?.unknown === true ? 'INCONCLUSIVE' : 'PENDING';
    await scheduleNextPaymentCheck(order); await kv.setJson(orderKey(order.orderId), order, { ttlSeconds: ORDER_TTL });
    if (manual) await say(chatId, result?.inconclusive === true
      ? 'Swiggy status check inconclusive raha. Order pending hai—dobara pay mat karo; baad me status check hoga.'
      : 'Payment abhi paid confirm nahi hua. Pending hai—dobara pay mat karo; thodi der baad check karo.', 'pending', {}, inlineMarkup([[{ text: '↻ Payment check', callback_data: `payment:check:${token}` }]]));
    return { outcome: result?.inconclusive === true || result?.unknown === true ? 'INCONCLUSIVE' : 'PENDING' };
  }

  async function checkPayment(chatId, userId, token, options = {}) {
    const state = await kv.getJson(stateKey(userId));
    const orderId = String(state?.orderId || '');
    if (!orderId) {
      if (options.manual !== false) await say(chatId, 'Payment order nahi mila. My Orders check karo.', 'error');
      return { outcome: 'NOT_FOUND' };
    }
    const lockKey = `payment-check-lock:${orderId}`;
    const claimed = await kv.setJson(lockKey, { at: Date.now() }, { nx: true, ttlSeconds: 50 }).catch(() => false);
    if (!claimed) return { outcome: 'ALREADY_CHECKING' };
    try { return await checkPaymentUnlocked(chatId, userId, token, options); }
    finally { await kv.del(lockKey).catch(() => {}); }
  }

  async function showMyId(chatId, user) {
    const p = await saveProfile(user);
    const links = authorizedMobiles(config, user.id).map(maskedMobile);
    await say(chatId, `🆔 My ID\nTelegram ID: ${user.id}\nName: ${p.displayName}\nLinked Swiggy IDs: ${links.length ? links.join(', ') : 'none'}\nSuccessful orders: ${Number(p.successfulOrders || 0)}\nVerified order value: ${rupeesFromPaise(p.totalSpentPaise || 0)}`, 'profile', {}, homeMarkup());
  }

  async function showMyOrders(chatId, user, page = 0) {
    const ids = await kv.zRevRange(orderIndex(user.id), page * 5, page * 5 + 4);
    if (!ids.length) return say(chatId, 'Abhi tumhare naam par koi order record nahi hai.', 'orders', {}, homeMarkup());
    const rows = [];
    for (const id of ids) {
      const o = await kv.getJson(orderKey(id));
      if (!o || String(o.userId) !== String(user.id)) continue;
      const token = callbackToken(); await kv.setJson(`order-view:${user.id}:${token}`, { orderId: o.orderId }, { ttlSeconds: 600 });
      rows.push(`📦 ${o.restaurant} · ${rupeesFromPaise(o.totalPaise)}\n${new Date(o.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} · ${o.paymentStatus} · ${o.apiOrderStatus || o.status}\nDetails: /order_${token}`);
    }
    const buttons = [];
    if (page > 0) buttons.push({ text: '← Newer', callback_data: `orders:page:${page - 1}` });
    if (ids.length === 5) buttons.push({ text: 'Older →', callback_data: `orders:page:${page + 1}` });
    await say(chatId, `📦 My Orders\n\n${rows.join('\n\n') || 'No orders.'}`, 'orders', {}, buttons.length ? inlineMarkup([buttons]) : homeMarkup());
  }

  async function showOrderDetail(chatId, user, token) {
    const ref = await kv.getJson(`order-view:${user.id}:${token}`);
    if (!ref) return say(chatId, 'Order detail link expire ho gaya. My Orders dobara kholo.', 'error');
    const o = await kv.getJson(orderKey(ref.orderId));
    if (!o || String(o.userId) !== String(user.id)) return say(chatId, 'Order access denied.', 'error');
    const tracking = cleanTrackingUrl(o.trackingLink);
    await say(chatId, `Order ${o.orderId}\nDate: ${new Date(o.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\nRestaurant: ${o.restaurant}\nItems: ${o.items.map(i => `${i.name} × ${i.quantity}`).join(', ')}\nAddress: ${o.addressSummary || 'masked'}\nAmount: ${rupeesFromPaise(o.totalPaise)}\nPayment: ${o.paymentStatus}\nOrder status: ${o.apiOrderStatus || o.status}${tracking ? `\nTracking: ${tracking}` : ''}`, tracking ? 'tracking' : 'orders', {}, tracking ? inlineMarkup([[{ text: '🔗 Swiggy tracking kholo', url: tracking }]]) : homeMarkup());
  }

  async function showLeaderboard(chatId, user) {
    const members = await kv.zRevRange(leaderboardKey, 0, 49, true); const rows = [];
    for (let i = 0; i < members.length; i += 2) {
      const id = String(members[i]); const p = await kv.getJson(profileKey(id));
      if (p?.leaderboardOptIn === true) rows.push({ name: safeName(p.publicName || p.displayName), count: Number(members[i + 1]) || 0 });
      if (rows.length >= 10) break;
    }
    const p = await kv.getJson(profileKey(user.id)) || {};
    await say(chatId, `🏆 Leaderboard\nSirf verified paid orders count hote hain.\n\n${rows.length ? rows.map((r, i) => `${i + 1}. ${r.name} — ${r.count} orders`).join('\n') : 'Abhi public participants nahi hain.'}`, 'leaderboard', {}, inlineMarkup([[{ text: p.leaderboardOptIn ? '🙈 Hide me' : '🏆 Opt in', callback_data: 'leaderboard:toggle' }]]));
  }

  async function showWallet(chatId, user) {
    const w = await kv.getJson(`wallet:${user.id}`) || { balancePaise: 0, transactions: [] };
    const history = (Array.isArray(w.transactions) ? w.transactions.slice(-5).reverse() : []).map(t => `• ${t.type} ${rupeesFromPaise(t.amountPaise)} — ${String(t.reason || '').slice(0, 60)}`).join('\n') || 'Koi wallet transaction nahi.';
    await say(chatId, `👛 Wallet (free)\nComplimentary balance: ${rupeesFromPaise(w.balancePaise || 0)}\nDeposit/fee: nahi\n\n${history}`, 'wallet', { balance: amountFromPaise(w.balancePaise || 0) }, homeMarkup());
  }

  async function toggleLeaderboard(chatId, user) {
    const p = await saveProfile(user); p.leaderboardOptIn = !p.leaderboardOptIn; p.publicName = p.leaderboardOptIn ? safeName(p.displayName) : '';
    await kv.setJson(profileKey(user.id), p, { ttlSeconds: ORDER_TTL });
    await say(chatId, p.leaderboardOptIn ? 'Opt-in ho gaya: display name aur verified count public dikhenge.' : 'Leaderboard se hide kar diya. Private details public nahi hain.', 'leaderboard');
    await showLeaderboard(chatId, user);
  }

  async function freeCredit(chatId, user, arg) {
    if (!isAdmin(config, user.id)) return say(chatId, 'Admin permission required.', 'error');
    if (!(config.freeCreditAdminGrantLimit > 0)) return say(chatId, 'Complimentary credit grant configured nahi; paid top-up supported nahi.', 'wallet');
    const [target, amountRaw, ...why] = String(arg || '').trim().split(/\s+/); const rupees = Number(amountRaw); const reason = why.join(' ').slice(0, 100);
    if (!/^\d+$/.test(target || '') || !Number.isFinite(rupees) || rupees <= 0 || rupees > config.freeCreditAdminGrantLimit || !reason) return say(chatId, `Use: /freecredit <telegram_id> <rupees> <reason>. Max ₹${config.freeCreditAdminGrantLimit}.`, 'error');
    const w = await kv.getJson(`wallet:${target}`) || { balancePaise: 0, transactions: [] };
    const amountPaise = Math.round(rupees * 100); w.balancePaise = Number(w.balancePaise || 0) + amountPaise;
    w.transactions = [...(w.transactions || []), { type: 'COMPLIMENTARY', amountPaise, reason, by: String(user.id), at: new Date().toISOString() }].slice(-100);
    await kv.setJson(`wallet:${target}`, w, { ttlSeconds: ORDER_TTL });
    await say(chatId, `Complimentary ₹${rupees.toFixed(2)} credit user ${target} ko add hua.`, 'wallet');
  }

  async function routeText(update) {
    const m = update.message; const user = m?.from; const chat = m?.chat;
    if (!user?.id || !chat?.id || chat.type !== 'private' || String(chat.id) !== String(user.id)) return;
    const id = String(user.id); const chatId = chat.id; const text = String(m.text || '').trim();
    if (!text && !m.location) { if (m.voice || m.audio || m.photo || m.document) await say(chatId, 'Text me details bhejo ya delivery location share karo.', 'start'); return; }
    const rateKey = `rate:${id}:${Math.floor(Date.now() / 60_000)}`;
    const rate = await kv.incrBy(rateKey, 1); if (rate === 1) await kv.expire(rateKey, 120);
    if (rate > RATE_LIMIT) return say(chatId, 'Bahut requests aaye; ek minute baad try karo.', 'error');
    if (!(await requireChannel(id, chatId))) return;
    const profile = await saveProfile(user); const state = await kv.getJson(stateKey(id));
    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
      if (['PAYMENT_PENDING', 'UNKNOWN'].includes(state?.phase)) await say(chatId, `Order ${state.orderId || ''} status pending/reconcile hai. Duplicate order nahi banega; My Orders check karo.`, 'pending', {}, homeMarkup());
      else await sendHome(chatId, user);
      return;
    }
    if (/^\/voice(?:@\w+)?$/i.test(text)) {
      profile.voiceTone = profile.voiceTone === 'stern' ? 'normal' : 'stern'; await kv.setJson(profileKey(id), profile, { ttlSeconds: ORDER_TTL });
      return say(chatId, profile.voiceTone === 'stern' ? 'Voice reminder thoda sakht, par respectful rahega.' : 'Normal voice reminder on hai.', profile.voiceTone === 'stern' ? 'stern' : 'generic');
    }
    if (/^\/cancel(?:@\w+)?$/i.test(text) || /^✖ cancel$/i.test(text)) {
      if (state && ['ADDRESS', 'ADDRESS_LINK', 'ADDRESS_RETRY', 'ADDRESS_DETAILS', 'ADDRESS_ADD_UNKNOWN', 'CART', 'CART_RETRY', 'REVIEW'].includes(state.phase)) {
        await kv.del(stateKey(id)); return say(chatId, state.phase === 'ADDRESS_ADD_UNKNOWN' ? 'Local draft clear hua. Address account par add hua ho sakta hai—Swiggy saved addresses verify karke hi naya address add karna.' : 'Checkout cancel. Order place nahi hua; naya order start kar sakte ho.', 'cancel', {}, homeMarkup());
      }
      return say(chatId, 'Placed ya payment-pending order yahan se cancel nahi kar sakta. My Orders ya Swiggy app check karo.', 'error');
    }
    if (/^\/freecredit(?:@\w+)?\s+/i.test(text)) return freeCredit(chatId, user, text.replace(/^\/freecredit(?:@\w+)?\s*/i, ''));
    const detail = text.match(/^\/order_([a-f0-9]{12})$/i); if (detail) return showOrderDetail(chatId, user, detail[1]);
    if (/^(🏆\s*)?leaderboard$/i.test(text) || /^\/leaderboard/i.test(text)) return showLeaderboard(chatId, user);
    if (/^(🆔\s*)?my id$/i.test(text) || /^\/myid/i.test(text)) return showMyId(chatId, user);
    if (/^(📦\s*)?my orders$/i.test(text) || /^\/orders/i.test(text)) return showMyOrders(chatId, user);
    if (/^(👛\s*)?wallet$/i.test(text) || /^\/wallet/i.test(text)) return showWallet(chatId, user);
    if (/^(🛒\s*)?naya order$/i.test(text) || /^\/order$/i.test(text)) return startNewOrder(chatId, user);
    if (/^\/addresslink(?:@\w+)?$/i.test(text)) {
      if (config.orderFlowEnabled !== true || config.addressLinkEnabled !== true || !state || !['ADDRESS', 'ADDRESS_DETAILS'].includes(state.phase)) return say(chatId, 'Address link option off hai ya order address step me nahi hai. Manual map-pin path available hai.', 'error');
      state.phase = 'ADDRESS_LINK'; state.pendingCoordinates = null;
      await kv.setJson(stateKey(id), state, { ttlSeconds: STATE_TTL });
      return say(chatId, 'Optional address share link bhejo. Manual path ke liye /cancel karke Naya order me location share kar sakte ho.', 'address');
    }
    if (m.location && state?.phase === 'ADDRESS') {
      const lat = Number(m.location.latitude); const lng = Number(m.location.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 6 || lat > 38 || lng < 67 || lng > 98) return say(chatId, 'Valid India delivery pin share karo.', 'address');
      state.pendingCoordinates = { lat: String(lat), lng: String(lng) }; state.phase = 'ADDRESS_DETAILS';
      await kv.setJson(stateKey(id), state, { ttlSeconds: STATE_TTL });
      return say(chatId, 'Ab ek line me bhejo: building/house | area | landmark (ya -) | receiver name | 10-digit receiver phone', 'address');
    }
    if (state?.phase === 'ADDRESS_DETAILS') return addManualAddress(chatId, user, state, text);
    if (state?.phase === 'ADDRESS_LINK') return resolveAddress(chatId, user, state, text);
    if (state?.phase === 'ADDRESS') return say(chatId, 'Delivery location pin share karo. Text address import alag optional feature hai; /addresslink se use karo jab enabled ho.', 'address');
    if (state?.phase === 'ADDRESS_RETRY') return say(chatId, 'Address request pending/retry state me hai—Retry dabao ya naya address link bhejo.', 'error', {}, inlineMarkup([
      [{ text: '↻ Retry address', callback_data: `retry:address:${state.draftId.slice(0, 10)}` }, { text: 'Naya address', callback_data: `input:address:${state.draftId.slice(0, 10)}` }]
    ]));
    if (state?.phase === 'CART') return importCart(chatId, user, state, text);
    if (state?.phase === 'CART_RETRY') return say(chatId, 'Saved cart/address ko button se retry karo; link tabhi badlo jab expire ho.', 'error', {}, inlineMarkup([
      [{ text: '↻ Retry', callback_data: `retry:${state.cartLink ? 'cart' : 'bill'}:${state.draftId.slice(0, 10)}` }, ...(state.cartLink ? [{ text: 'Naya cart', callback_data: `input:cart:${state.draftId.slice(0, 10)}` }] : [])]
    ]));
    if (state?.phase === 'REVIEW') return say(chatId, 'Bill card par ACCEPT, CANCEL, ya TRY ANOTHER ACCOUNT dabao.', 'bill');
    if (['PAYMENT_PENDING', 'UNKNOWN'].includes(state?.phase)) return say(chatId, 'Payment/order pending hai. My Orders ya Payment check use karo; duplicate order mat banao.', 'pending');
    return sendHome(chatId, user);
  }

  async function routeCallback(update) {
    const q = update.callback_query; const user = q?.from; const chatId = q?.message?.chat?.id; const data = String(q?.data || '');
    if (!user?.id || !chatId || String(chatId) !== String(user.id)) return;
    const id = String(user.id); try { await telegram.answerCallbackQuery(q.id); } catch {}
    if (data === 'gate:check') { if (await requireChannel(id, chatId, { force: true })) await sendHome(chatId, user); return; }
    if (!(await requireChannel(id, chatId))) return;
    await saveProfile(user);
    if (data === 'leaderboard:toggle') return toggleLeaderboard(chatId, user);
    if (data.startsWith('orders:page:')) return showMyOrders(chatId, user, Math.max(0, Number(data.split(':')[2]) || 0));
    if (data.startsWith('order:accept:')) return acceptOrder(chatId, user, data.slice('order:accept:'.length));
    if (data.startsWith('order:cancel:')) {
      const token = data.slice('order:cancel:'.length); const state = await kv.getJson(stateKey(id));
      if (!state || state.phase !== 'REVIEW' || state.reviewToken !== token) return say(chatId, 'Bill card purana hai; fresh bill kholo.', 'error');
      await kv.del(stateKey(id)); return say(chatId, 'Checkout cancel. Abhi order place nahi hua.', 'cancel', {}, homeMarkup());
    }
    if (data.startsWith('order:account:')) {
      const token = data.slice('order:account:'.length); const state = await kv.getJson(stateKey(id));
      if (!state || state.phase !== 'REVIEW' || state.reviewToken !== token) return say(chatId, 'Bill card purana hai; fresh bill kholo.', 'error');
      const next = state.accountCandidates.find(x => x.mobile !== state.mobile);
      if (!next) return say(chatId, 'Doosra authorized Swiggy ID available nahi.', 'error');
      state.mobile = next.mobile; state.accountName = next.name; state.phase = 'ADDRESS'; state.address = null; state.addressLink = '';
      state.cartId = ''; state.restaurant = null; state.items = []; state.quote = null; state.reviewToken = '';
      await kv.setJson(stateKey(id), state, { ttlSeconds: STATE_TTL });
      return say(chatId, `Authorized linked ID ${maskedMobile(next.mobile)} select hui. Is ID ke liye delivery location pin share karo.`, 'address', {}, { reply_markup: { keyboard: [[{ text: '📍 Share delivery location', request_location: true }], ['✖ Cancel']], resize_keyboard: true, one_time_keyboard: true } });
    }
    if (data.startsWith('retry:')) {
      const [, step, draft] = data.split(':'); const state = await kv.getJson(stateKey(id));
      if (!state || state.draftId.slice(0, 10) !== draft) return say(chatId, 'Retry button purana hai. Fresh step lo.', 'error');
      return retryStep(chatId, user, state, step);
    }
    if (data.startsWith('input:')) {
      const [, step, draft] = data.split(':'); const state = await kv.getJson(stateKey(id));
      if (!state || state.draftId.slice(0, 10) !== draft) return say(chatId, 'Input button purana hai.', 'error');
      state.phase = step === 'address' ? 'ADDRESS_LINK' : 'CART'; if (step === 'address') state.addressLink = ''; else state.cartLink = '';
      await kv.setJson(stateKey(id), state, { ttlSeconds: STATE_TTL });
      return say(chatId, step === 'address' ? 'Naya address share link bhejo.' : 'Naya group-cart link bhejo. Address saved hai.', step === 'address' ? 'address' : 'start');
    }
    if (data.startsWith('payment:')) { const [, action, token] = data.split(':'); if (['check', 'status'].includes(action)) return checkPayment(chatId, id, token); }
    if (data.startsWith('order-view:')) return showOrderDetail(chatId, user, data.split(':')[1]);
    return say(chatId, 'Button purana hai. Menu se dobara kholo.', 'generic', {}, homeMarkup());
  }

  async function processUpdate(update) {
    if (update?.message) return routeText(update);
    if (update?.callback_query) return routeCallback(update);
  }

  async function pollPendingPayments({ limit = 10, orderId = '' } = {}) {
    if (config.orderFlowEnabled !== true) return { checked: 0, finalized: 0, stillPending: 0, errors: 0, disabled: 'order feature flag disabled' };
    const due = orderId
      ? [String(orderId).slice(0, 100)]
      : await kv.zRangeByScore(pendingPaymentsKey, 0, Date.now(), limit).catch(() => []);
    const out = { checked: 0, finalized: 0, stillPending: 0, errors: 0 };
    for (const orderId of due) {
      const order = await kv.getJson(orderKey(orderId)).catch(() => null);
      if (!order || !['PAYMENT_PENDING', 'PAID_CONFIRM_PENDING'].includes(order.status)) { await kv.zRem(pendingPaymentsKey, orderId).catch(() => {}); continue; }
      const id = String(order.userId || ''); const state = await kv.getJson(stateKey(id)).catch(() => null);
      if (!state?.paymentToken || String(state.orderId) !== String(orderId)) { out.errors += 1; continue; }
      const start = Number(order.paymentStartedAt || 0);
      if (start && Date.now() >= start + 24 * 60 * 60_000) { order.autoPollingStoppedAt = Date.now(); await kv.setJson(orderKey(orderId), order, { ttlSeconds: ORDER_TTL }); await kv.zRem(pendingPaymentsKey, orderId).catch(() => {}); continue; }
      out.checked += 1;
      try {
        const result = await checkPayment(id, id, state.paymentToken, { manual: false });
        if (['PAID', 'ORDER_FAILED_REFUND_AUTO'].includes(result?.outcome)) out.finalized += 1;
        else if (['INCONCLUSIVE', 'PENDING', 'CONFIRM_PENDING'].includes(result?.outcome)) out.stillPending += 1;
        else if (result?.outcome === 'FAILED_REVIEW') out.errors += 1;
      } catch { out.errors += 1; }
    }
    return out;
  }

  return Object.freeze({ processUpdate, pollPendingPayments, channelMembership });
}
