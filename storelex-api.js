const DEFAULT_BASE_URL = 'https://storelex.store/swiggy_web/api';
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 60_000;

export class StorelexApiError extends Error {
  constructor(message, { status = 0, code = 'STORELEX_ERROR', payload = null } = {}) {
    super(message);
    this.name = 'StorelexApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(String(value || DEFAULT_BASE_URL)); }
  catch { throw new TypeError('STORELEX_API_BASE_URL must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Storelex API base URL must be HTTPS and cannot contain credentials, query, or fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

function boundedTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.trunc(timeout), MAX_TIMEOUT_MS);
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value ?? ''));
}

/**
 * Thin, secret-safe client for the Storelex Swiggy PRO API.
 * It deliberately never logs request headers or bodies. Keep the user key in
 * the host's secret environment, not in source, Telegram messages, or JSON.
 */
export function createStorelexClient({
  baseUrl = process.env.STORELEX_API_BASE_URL || DEFAULT_BASE_URL,
  userKey = process.env.STORELEX_USER_KEY || process.env.STORELEX_KEY || '',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const key = String(userKey || '').trim();
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  const defaultTimeout = boundedTimeout(timeoutMs);

  async function request(path, { method = 'GET', query, body, timeoutMs: requestTimeout, auth = true } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new TypeError('Storelex API path must be a local absolute path.');
    }
    if (auth && !key) {
      throw new StorelexApiError('Storelex API key is not configured on the server.', {
        code: 'STORELEX_NOT_CONFIGURED'
      });
    }
    const url = new URL(`${base}${path}`);
    if (query && typeof query === 'object') {
      for (const [name, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        if (Array.isArray(value)) value.forEach(item => url.searchParams.append(name, String(item)));
        else url.searchParams.set(name, String(value));
      }
    }

    const headers = { Accept: 'application/json' };
    if (auth) headers['x-user-key'] = key;
    const hasBody = body !== undefined;
    if (hasBody) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), boundedTimeout(requestTimeout ?? defaultTimeout));
    timer.unref?.();

    let response;
    try {
      response = await fetchImpl(url, {
        method: String(method).toUpperCase(),
        headers,
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal
      });
    } catch (cause) {
      const timedOut = controller.signal.aborted;
      throw new StorelexApiError(timedOut ? 'Storelex API timed out.' : 'Could not connect to the Storelex API.', {
        code: timedOut ? 'STORELEX_TIMEOUT' : 'STORELEX_NETWORK_ERROR'
      });
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    try { payload = await response.json(); }
    catch {
      throw new StorelexApiError('Storelex API returned an unreadable response.', {
        status: response.status,
        code: 'STORELEX_INVALID_RESPONSE'
      });
    }
    if (!response.ok) {
      const status = Number(response.status) || 502;
      const message = status === 401
        ? 'Storelex rejected the configured access key (401).'
        : String(payload?.detail || payload?.message || `Storelex API request failed (${status}).`).slice(0, 240);
      throw new StorelexApiError(message, {
        status,
        code: status === 401 ? 'STORELEX_UNAUTHORIZED' : 'STORELEX_HTTP_ERROR',
        payload
      });
    }
    return payload;
  }

  const get = (path, query, options = {}) => request(path, { ...options, method: 'GET', query });
  const post = (path, body = {}, options = {}) => request(path, { ...options, method: 'POST', body });
  const put = (path, body = {}, options = {}) => request(path, { ...options, method: 'PUT', body });
  const del = (path, body, options = {}) => request(path, { ...options, method: 'DELETE', ...(body === undefined ? {} : { body }) });

  return Object.freeze({
    baseUrl: base,
    isConfigured: Boolean(key),
    request,
    me: () => get('/me'),
    maintenance: () => get('/maintenance'),
    sessions: () => get('/sessions'),
    profile: mobile => get(`/profile/${encodePathSegment(mobile)}`),
    removeAccount: mobile => del(`/accounts/${encodePathSegment(mobile)}`),
    removeAllAccounts: () => post('/accounts/remove_all'),
    markAccountUsed: mobile => post(`/accounts/${encodePathSegment(mobile)}/mark_used`),
    markAccountFresh: mobile => post(`/accounts/${encodePathSegment(mobile)}/mark_fresh`),
    checkFreeCash: mobile => post(`/accounts/${encodePathSegment(mobile)}/check_fc`),
    accountLoginKey: mobile => post(`/accounts/${encodePathSegment(mobile)}/login_key`),
    exportAccount: mobile => post(`/accounts/${encodePathSegment(mobile)}/export`),
    startAccountDeletion: mobile => post(`/accounts/${encodePathSegment(mobile)}/delete/start`),
    confirmAccountDeletion: (mobile, otp) => post(`/accounts/${encodePathSegment(mobile)}/delete/confirm`, { otp }),
    checkMobile: mobile => post('/auth/check_mobile', { mobile }),
    sendOtp: mobile => post('/auth/send_otp', { mobile }),
    verifyOtp: body => post('/auth/verify_otp', body),
    importSessionJson: body => post('/auth/import_json', body),
    loginByKey: keyValue => post('/login/json', { json_data: keyValue }),
    addresses: (mobile, { force = false } = {}) => get(`/addresses/${encodePathSegment(mobile)}`, { force }),
    addAddress: (body, options = {}) => post('/addresses/add', body, options),
    addAddressByLink: body => post('/addresses/add_link', body),
    deleteAddress: body => del('/addresses/delete', body),
    locationSearch: query => get('/location/search', { query }),
    locationDetails: placeId => get('/location/details', { place_id: placeId }),
    locationAutocomplete: query => get('/location/autocomplete', query),
    locationPlace: query => get('/location/place', query),
    locationReverse: query => get('/location/reverse', query),
    searchRestaurants: query => get('/search/restaurants', query),
    searchMenu: body => post('/search/menu', body),
    searchMenuItems: body => post('/search/menu_search', body),
    searchOutlets: body => post('/search/outlets', body),
    getCartState: () => get('/cart/state'),
    setCartState: body => put('/cart/state', body),
    repriceCart: body => post('/search/cart', body),
    addAddressToAccount: body => post('/cart/add_address_to_account', body),
    resolveAddressByLink: (body, options = {}) => post('/cart/address_by_link', body, { timeoutMs: options.timeoutMs ?? 45_000 }),
    importGroupCart: (body, options = {}) => post('/cart/import_group', body, {
      timeoutMs: options.timeoutMs ?? (body?.leave_old === true ? 45_000 : 30_000)
    }),
    coupons: body => post('/checkout/coupons', body),
    bestCoupon: body => post('/checkout/best_coupon', body),
    applyCoupon: body => post('/checkout/apply_coupon', body),
    removeCoupon: body => post('/checkout/remove_coupon', body),
    paymentOptions: body => post('/checkout/payment_options', body),
    oneStatus: mobile => post('/checkout/one/status', { mobile }),
    placeOrder: (body, options = {}) => post('/checkout/place', body, options),
    paymentStatus: (body, options = {}) => post('/checkout/payment_status', body, { timeoutMs: 20_000, ...options }),
    confirmPayment: (body, options = {}) => post('/checkout/confirm', body, { timeoutMs: 20_000, ...options }),
    orderStatus: body => post('/checkout/order_status', body, { timeoutMs: 20_000 }),
    orders: mobile => get(`/orders/${encodePathSegment(mobile)}`),
    recentOrders: query => get('/orders_recent', query),
    orderDetail: (mobile, orderId) => get(`/order_detail/${encodePathSegment(mobile)}/${encodePathSegment(orderId)}`),
    rateOrder: (mobile, orderId) => post(`/rating/${encodePathSegment(mobile)}/${encodePathSegment(orderId)}`),
    batchTools: body => post('/tools/batch', body),
    diya: body => post('/tools/diya', body),
    claimedOffers: offer => get('/offers/claimed', { offer }),
    breakfastDeal: mobile => post('/deals/breakfast', { mobile }),
    nightDeal: mobile => post('/deals/night', { mobile }),
    paylog: body => post('/paylog', body),
    upiPage: query => get('/pay/upi', query)
  });
}

export function createConfiguredStorelexClient(options = {}) {
  const client = createStorelexClient(options);
  if (!client.isConfigured) {
    throw new StorelexApiError('Set STORELEX_USER_KEY in the server secret environment.', {
      code: 'STORELEX_NOT_CONFIGURED'
    });
  }
  return client;
}
