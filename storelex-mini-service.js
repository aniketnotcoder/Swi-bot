import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createConfiguredStorelexClient, createStorelexClient } from './storelex-api.js';
import { openStorelexScratch } from './storelex-mini-db.js';

const html = new URL('./storelex-mini.html', import.meta.url);
const js = new URL('./storelex-mini.js', import.meta.url);
const css = new URL('./storelex-mini.css', import.meta.url);

export function verifyTelegramInitData(raw, token, now = Date.now()) {
  if (!raw || raw.length > 8192 || !token) return null;
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  const date = Number(params.get('auth_date'));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isSafeInteger(date) || Math.abs(now / 1000 - date) > 86400) return null;
  const check = [...params.entries()].filter(([key]) => key !== 'hash').sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;
  try {
    const id = JSON.parse(params.get('user') || '{}').id;
    return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  } catch { return null; }
}

function error(message, status = 400) { const err = new Error(message); err.status = status; throw err; }
const mobileOk = value => /^\d{10}$/.test(String(value || ''));
const id = value => String(value ?? '').trim();
const coordinates = state => state.lat != null && state.lng != null && Number.isFinite(Number(state.lat)) && Number.isFinite(Number(state.lng));
const allowedMethods = Object.freeze({
  sessions: 'GET', me: 'GET', maintenance: 'GET', profile: 'GET', addresses: 'GET', locationSearch: 'GET', locationDetails: 'GET', locationReverse: 'GET',
  searchRestaurants: 'GET', orders: 'GET', orderDetail: 'GET', getCartState: 'GET',
  exportAccount: 'POST', accountLoginKey: 'POST', checkFreeCash: 'POST', addAddress: 'POST', addAddressByLink: 'POST', deleteAddress: 'DELETE',
  searchMenu: 'POST', searchMenuItems: 'POST', searchOutlets: 'POST', repriceCart: 'POST', setCartState: 'PUT', addAddressToAccount: 'POST', importGroupCart: 'POST',
  coupons: 'POST', bestCoupon: 'POST', applyCoupon: 'POST', removeCoupon: 'POST', paymentOptions: 'POST', oneStatus: 'POST',
  placeOrder: 'POST', paymentStatus: 'POST', confirmPayment: 'POST', orderStatus: 'POST', rateOrder: 'POST', paylog: 'POST'
});
export const MINI_ACTIONS = Object.keys(allowedMethods);

// The API key is only read on the server. The browser never sees it.
export function createStorelexMiniService({ client, scratch, token, bossIds, createClient = createStorelexClient }) {
  const owners = new Set(String(bossIds || '').split(/[,;\s]+/).filter(Boolean));
  const checks = new Map(); // repriced bill in this process, never trusted from browser
  const webSessions = new Map(); // random cookie -> per-key session (never persisted)
  const loginAttempts = new Map();
  const cookieName = 'storelex_session';
  const webSession = req => {
    const sid = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const session = webSessions.get(sid);
    if (!session) return null;
    if (session.expires < Date.now()) { webSessions.delete(sid); return null; }
    return { sid, ...session };
  };
  const csrfValid = (req, session) => session && String(req.headers['x-csrf-token'] || '') === session.csrf &&
    (!req.headers.origin || req.headers.origin === `https://${req.headers.host}` || req.headers.origin === `http://${req.headers.host}`);
  const readBody = async (req, limit = 1_000_000) => {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > limit) error('Request too large', 413); }
    try { return JSON.parse(raw); } catch { error('Invalid JSON'); }
  };
  async function guard(mobile) {
    const [me, maintenance, profile] = await Promise.all([client.me(), client.maintenance(), client.profile(mobile)]);
    if (me?.success !== true || !Number.isFinite(Number(me.balance)) || !Number.isFinite(Number(me.fee)) || Number(me.balance) < Number(me.fee)) error('Wallet balance below order fee', 409);
    if (typeof maintenance?.maintenance !== 'boolean') error('Maintenance status unavailable', 503);
    if (maintenance.maintenance === true && me.is_owner !== true) error('Storelex maintenance', 503);
    if (profile?.expired === true || profile?.success !== true) error('Selected session expired or unverified: re-login on Storelex', 409);
  }
  async function action(userId, name, body = {}) {
    if (!Object.hasOwn(allowedMethods, name)) error('Action disabled', 403);
    const state = scratch.get(userId);
    const mobile = state.mobile;
    if (name === 'sessions' || name === 'me' || name === 'maintenance') return client[name]();
    if (name === 'getCartState') {
      if (!mobileOk(mobile)) error('Select an account first');
      const result = await client.getCartState();
      return result?.cart?.mobile === mobile ? result : { cart: null, loc: null };
    }
    if (name === 'locationSearch') return client.locationSearch(id(body.query).slice(0, 120));
    if (name === 'locationDetails') return client.locationDetails(id(body.place_id).slice(0, 120));
    if (name === 'locationReverse') return client.locationReverse({ lat: body.lat, lng: body.lng, mobile: mobile || '' });
    if (!mobileOk(mobile)) error('Select an account first');
    if (name === 'profile') return client.profile(mobile);
    if (name === 'addresses') {
      const response = await client.addresses(mobile);
      // Never return other accounts' or merged global_addresses.
      return { success: response?.success === true, addresses: Array.isArray(response?.account_addresses) ? response.account_addresses : Array.isArray(response?.addresses) ? response.addresses.filter(a => !a.is_global) : [], is_expired: response?.is_expired === true };
    }
    if (name === 'orders') return client.orders(mobile);
    if (name === 'orderDetail') return client.orderDetail(mobile, id(body.order_id));
    if (name === 'searchRestaurants') return client.searchRestaurants({ mobile, q: id(body.q).slice(0, 100), lat: state.lat, lng: state.lng });
    if (allowedMethods[name] !== 'GET') await guard(mobile);
    const common = { mobile, address_id: state.address_id, lat: state.lat, lng: state.lng, cart_id: state.cart_id };
    switch (name) {
      case 'exportAccount': return client.exportAccount(mobile);
      case 'accountLoginKey': {
        const sessions = await client.sessions();
        if (!sessions?.sessions?.some(s => String(s.mobile) === mobile && s.key_login === true)) error('Not a key-login account', 403);
        return client.accountLoginKey(mobile);
      }
      case 'checkFreeCash': return client.checkFreeCash(mobile);
      case 'addAddress': return client.addAddress({ ...body, mobile });
      case 'addAddressByLink': return client.addAddressByLink({ mobile, link: id(body.link) });
      case 'deleteAddress': return client.deleteAddress({ mobile, address_id: id(body.address_id), is_global: body.is_global === true });
      case 'searchMenu': return client.searchMenu({ mobile, restaurant_id: id(body.restaurant_id), query: body.query || '', metadata: body.metadata, lat: state.lat, lng: state.lng });
      case 'searchMenuItems': return client.searchMenuItems({ mobile, restaurant_id: id(body.restaurant_id), query: body.query || '', veg: !!body.veg, lat: state.lat, lng: state.lng });
      case 'searchOutlets': return client.searchOutlets({ mobile, restaurant_id: id(body.restaurant_id), lat: state.lat, lng: state.lng });
      case 'setCartState': return client.setCartState({ cart: { ...body.cart, mobile }, loc: body.loc });
      case 'addAddressToAccount': return client.addAddressToAccount({ mobile, address: body.address });
      case 'importGroupCart': return client.importGroupCart({ mobile, link: id(body.link), address_id: state.address_id, lat: state.lat, lng: state.lng, leave_old: false });
      case 'oneStatus': return client.oneStatus(mobile);
      case 'paylog': return client.paylog({ events: Array.isArray(body.events) ? body.events.slice(0, 20) : [] });
      case 'rateOrder': return client.rateOrder(mobile, id(body.order_id));
      default: break;
    }
    if (!coordinates(state) || !state.address_id) error('Select an address first');
    if (name === 'repriceCart') {
      checks.delete(userId);
      await scratch.cart(userId, '');
      const result = await client.repriceCart({ ...common, restaurant: body.restaurant, items: body.items, cooking: body.cooking || '', incognito: true, plan_id: body.plan_id || '' });
      if (result?.success === true && result.cart_id) {
        await scratch.cart(userId, id(result.cart_id));
        checks.set(userId, { cartId: id(result.cart_id), amount: finalAmount(result.bill_lines), at: Date.now(), restaurantId: id(body.restaurant?.id), cartValue: result.cart_value, restaurant: body.restaurant, items: body.items, lines: result.bill_lines, coupon: result.coupon });
      }
      return result;
    }
    if (!state.cart_id) error('Reprice cart first');
    const check = checks.get(userId);
    const rest = { ...common, restaurant_id: check?.restaurantId, cart_value: check?.cartValue };
    if (['coupons','bestCoupon','applyCoupon','removeCoupon','paymentOptions'].includes(name)) {
      const method = { coupons: 'coupons', bestCoupon: 'bestCoupon', applyCoupon: 'applyCoupon', removeCoupon: 'removeCoupon', paymentOptions: 'paymentOptions' }[name];
      const result = await client[method]({ ...rest, ...(name === 'applyCoupon' || name === 'removeCoupon' ? { code: id(body.code) } : {}) });
      if (name !== 'coupons' && name !== 'paymentOptions') checks.delete(userId); // reprice after coupon change
      return result;
    }
    if (name === 'placeOrder') {
      if (!check || check.cartId !== state.cart_id || Date.now() - check.at > 300_000 || !check.amount || Number(body.amount) !== check.amount) error('Bill changed: reprice and confirm again', 409);
      if (!['upi','cod','card'].includes(body.method)) error('Payment method unsupported');
      if (scratch.attempt(userId, state.cart_id)) error('Placement already attempted: reconcile before retry', 409);
      const addresses = await client.addresses(mobile);
      const confirmedAddress = (addresses?.account_addresses || addresses?.addresses || []).find(a => !a.is_global && String(a.id) === String(state.address_id));
      if (!confirmedAddress) error('Selected address changed: choose address again', 409);
      if (!await scratch.lock(userId, state.cart_id)) error('Placement already attempted', 409);
      const snap = { restaurant: check.restaurant, items: check.items, bill_lines: check.lines, coupon: check.coupon, address: confirmedAddress };
      const response = await client.placeOrder({ ...rest, amount: check.amount, method: body.method, snap, ...(body.method === 'card' ? { card: body.card } : {}) });
      if (response?.amount_changed === true && !response.order_id && !response.txn_id) {
        checks.delete(userId);
        await scratch.amountChanged(userId, state.cart_id);
        return { ...response, requires_reconfirm: true };
      }
      if (response?.unconfirmed) {
        if (!response.txn_id) return { ...response, requires_reconcile: true };
        // Exactly one bounded retry with the original cart and transaction id.
        const retry = await client.placeOrder({ ...rest, amount: check.amount, method: body.method,
          txn_id: response.txn_id, snap, ...(body.method === 'card' ? { card: body.card } : {}) });
        if (retry?.success && retry.order_id && (retry.txn_id || body.method === 'cod')) await scratch.placed(userId, state.cart_id, id(retry.order_id), id(retry.txn_id), body.method);
        return retry?.unconfirmed ? { ...retry, requires_reconcile: true } : retry;
      }
      if (response?.success && response.order_id && (response.txn_id || body.method === 'cod')) await scratch.placed(userId, state.cart_id, id(response.order_id), id(response.txn_id), body.method);
      return response;
    }
    const attempt = scratch.attempt(userId, state.cart_id);
    if (!attempt?.order_id) error('No placed order for this cart', 409);
    const paymentBody = { ...common, order_id: attempt.order_id, txn_id: attempt.txn_id, method: attempt.method || 'upi', manual: false, deep: body.deep === true };
    if (name === 'paymentStatus') {
      if (attempt.method === 'cod') error('COD has no UPI payment status', 409);
      return client.paymentStatus(paymentBody);
    }
    if (name === 'confirmPayment') {
      if (attempt.method === 'cod') error('COD confirmation uses order status', 409);
      const status = await client.paymentStatus(paymentBody);
      if (status?.success !== true || status.paid !== true || status.failed || status.unknown || status.inconclusive) error('Payment not verified', 409);
      const confirmed = await client.confirmPayment(paymentBody);
      if (confirmed?.confirmed === true && confirmed?.success === true) await scratch.confirmed(userId, state.cart_id);
      return confirmed;
    }
    if (name === 'orderStatus') {
      if (attempt.method === 'cod' && attempt.state !== 'CONFIRMED') {
        const current = await client.orderStatus({ order_id: attempt.order_id });
        if (current?.success !== true || !current.status || /pending|unconfirmed|failed|unknown/i.test(String(current.status))) error('COD order not confirmed', 409);
        await scratch.confirmed(userId, state.cart_id);
        return current;
      }
      if (attempt.state !== 'CONFIRMED') error('Payment not confirmed', 409);
      return client.orderStatus({ order_id: attempt.order_id });
    }
    error('Action disabled', 403);
  }
  async function perform(userId, payload) {
      if (payload.action === 'selectAccount') {
        const chosen = String(payload.body?.mobile || '');
        const sessions = await client.sessions();
        if (!Array.isArray(sessions?.sessions) || !sessions.sessions.some(s => String(s.mobile) === chosen && !s.is_expired)) error('Account unavailable');
        await guard(chosen);
        await scratch.select(userId, chosen);
        return { success: true, state: scratch.get(userId) };
      }
      if (payload.action === 'selectAddress') {
        const state = scratch.get(userId);
        if (!mobileOk(state.mobile)) error('Select account first');
        await guard(state.mobile);
        const addresses = await client.addresses(state.mobile);
        const listed = (addresses?.account_addresses || addresses?.addresses || []).find(a => !a.is_global && String(a.id) === String(payload.body?.address_id));
        if (!listed || !Number.isFinite(Number(listed.lat)) || !Number.isFinite(Number(listed.lng))) error('Address not in selected account');
        await scratch.address(userId, String(listed.id), Number(listed.lat), Number(listed.lng));
        return { success: true, state: scratch.get(userId) };
      }
      if (payload.action === 'state') return { success: true, state: scratch.get(userId) };
      const result = await action(userId, payload.action, payload.body && typeof payload.body === 'object' ? payload.body : {});
      return result;
  }
  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/storelex')) return false;
    const send = (code, payload) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); };
    try {
      if (req.method === 'GET' && ['/storelex', '/storelex/', '/storelex/app.js', '/storelex/app.css'].includes(url.pathname)) {
        const file = url.pathname.endsWith('.js') ? js : url.pathname.endsWith('.css') ? css : html;
        const contents = await fs.readFile(file);
        res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html', 'Cache-Control': 'no-store' });
        res.end(contents); return true;
      }
      if (url.pathname === '/storelex/web/login' && req.method === 'POST') {
        const ip = req.socket?.remoteAddress || 'unknown';
        const rec = loginAttempts.get(ip) || { count: 0, until: Date.now() + 15 * 60_000 };
        if (rec.until < Date.now()) { rec.count = 0; rec.until = Date.now() + 15 * 60_000; }
        if (++rec.count > 5) error('Too many login attempts', 429);
        loginAttempts.set(ip, rec);
        const input = await readBody(req, 4096);
        const key = String(input.access_key || '').trim();
        if (!/^(SWG|TNG)-(?:[A-Za-z0-9]{4}-){2}[A-Za-z0-9]{4}$/.test(key)) error('Invalid access key', 401);
        const ownClient = createClient({ baseUrl: client.baseUrl, userKey: key, timeoutMs: 60_000 });
        const me = await ownClient.me();
        if (me?.success !== true) error('Access key rejected', 401);
        for (const [key, session] of webSessions) if (session.expires < Date.now()) webSessions.delete(key);
        if (webSessions.size >= 500) error('Session capacity reached', 503);
        const sid = crypto.randomBytes(32).toString('hex');
        const csrf = crypto.randomBytes(32).toString('hex');
        const uid = `web:${crypto.createHash('sha256').update(key).digest('hex')}`;
        const service = createStorelexMiniService({ client: ownClient, scratch, token, bossIds: '', createClient });
        webSessions.set(sid, { uid, csrf, service, expires: Date.now() + 12 * 60 * 60_000 });
        loginAttempts.delete(ip);
        res.setHeader('Set-Cookie', `${cookieName}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.NODE_ENV === 'production' || req.socket?.encrypted ? '; Secure' : ''}`);
        return send(200, { success: true, csrf }), true;
      }
      if (url.pathname === '/storelex/web/session' && req.method === 'GET') {
        const session = webSession(req);
        return send(session ? 200 : 401, session ? { success: true, csrf: session.csrf } : { error: 'Login required' }), true;
      }
      if (url.pathname === '/storelex/web/logout' && req.method === 'POST') {
        const session = webSession(req);
        if (!csrfValid(req, session)) error('Session or CSRF invalid', 403);
        webSessions.delete(session.sid);
        res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return send(200, { success: true }), true;
      }
      if (req.method !== 'POST' || url.pathname !== '/storelex/api') return send(404, { error: 'Not found' }), true;
      const payload = await readBody(req);
      const userId = verifyTelegramInitData(String(req.headers['x-telegram-init-data'] || ''), token);
      if (userId && owners.has(userId)) return send(200, await perform(userId, payload)), true;
      const session = webSession(req);
      if (!csrfValid(req, session)) return send(403, { error: 'Telegram owner or web session required' }), true;
      return send(200, await session.service.perform(session.uid, payload)), true;
    } catch (e) { send(e.status || 502, { error: e.status ? e.message : 'Storelex request failed', code: e.code || 'STORELEX_ERROR' }); return true; }
  }
  return { handle, action, perform };
}

function finalAmount(lines) {
  const matches = Array.isArray(lines) ? lines.filter(line => /^(to pay|total payable|grand total)$/i.test(String(line.label || '').trim())).map(line => Number(String(line.value ?? '').replace(/^₹\s*/, ''))).filter(n => Number.isFinite(n) && n > 0) : [];
  return matches.length === 1 ? matches[0] : null;
}
export async function createConfiguredMiniService({ token, bossIds, dataDir }) {
  const client = createConfiguredStorelexClient({ timeoutMs: 60_000 });
  const scratch = await openStorelexScratch(`${dataDir}/storelex-mini.sqlite`);
  return createStorelexMiniService({ client, scratch, token, bossIds });
}
