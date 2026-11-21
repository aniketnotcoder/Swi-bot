const ADDRESS_HOSTS = new Set(['swiggy.onelink.me', 'swiggy.com', 'www.swiggy.com', 'm.swiggy.com']);
const CART_HOSTS = new Set([...ADDRESS_HOSTS, 'swig.gy']);

export function validateSwiggyLink(raw, type) {
  const value = String(raw || '').trim();
  if (type === 'cart' && /^swiggy:\/\//i.test(value)) {
    let deep;
    try { deep = new URL(value); } catch { return { ok: false, reason: 'INVALID_URL' }; }
    if (!['gc', 'share', 'webviewv2'].includes(deep.hostname.toLowerCase()) || value.length > 2000) return { ok: false, reason: 'UNSUPPORTED_HOST' };
    return { ok: true, value };
  }
  let url;
  try { url = new URL(value); }
  catch { return { ok: false, reason: 'INVALID_URL' }; }
  const allowed = type === 'address' ? ADDRESS_HOSTS : CART_HOSTS;
  if (url.protocol !== 'https:' || !allowed.has(url.hostname.toLowerCase()) || url.username || url.password || (url.port && url.port !== '443')) {
    return { ok: false, reason: 'UNSUPPORTED_HOST' };
  }
  if (url.toString().length > 2000) return { ok: false, reason: 'TOO_LONG' };
  const addressLike = /\/ofo\/address\/|onelink\.me/i.test(url.pathname + url.hostname);
  const cartLike = url.hostname === 'swig.gy' || /\/gc(?:\/|$)|sharedcart|group.?cart/i.test(url.pathname + url.search);
  if (type === 'address' && !addressLike) return { ok: false, reason: 'NOT_ADDRESS_LINK' };
  if (type === 'cart' && !cartLike) return { ok: false, reason: 'NOT_GROUP_CART_LINK' };
  return { ok: true, value: url.toString() };
}

export function extractSharedCartId(raw) {
  const value = String(raw || '').trim();
  const decoded = (() => { try { return decodeURIComponent(value); } catch { return value; } })();
  const directMatch = decoded.match(/\/gc\/([A-Za-z0-9_-]{1,40})(?:\/[^/?#]*?-(\d{1,20}))?(?:[?#]|$)/i);
  if (directMatch) {
    const id = directMatch[2] || (/^\d{1,20}$/.test(directMatch[1]) ? directMatch[1] : '');
    if (id) return id;
  }
  const query = decoded.match(/[?&#](?:sharedCartId|shared_cart_id|groupCartId|group_cart_id|cartId|cart_id)=([A-Za-z0-9_-]{1,64})/i);
  if (query && /\d/.test(query[1])) return query[1];
  try {
    const url = new URL(value);
    const embedded = url.searchParams.get('text') || url.searchParams.get('deep_link_value') || '';
    if (embedded && embedded !== value) return extractSharedCartId(embedded);
  } catch {}
  return '';
}

export function normalizeAddressResponse(payload) {
  if (payload?.gone === true) return { ok: false, reason: 'GONE', dropStoredSelection: true };
  const raw = payload?.address || payload?.data?.address || payload?.result?.address || null;
  if (payload?.success !== true || !raw || typeof raw !== 'object') return { ok: false, reason: payload?.is_expired ? 'EXPIRED' : 'ADDRESS_NOT_RESOLVED' };
  const saved = payload?.saved && typeof payload.saved === 'object' ? payload.saved : {};
  const lat = Number(raw.lat || raw.latitude || saved.lat || saved.latitude);
  const lng = Number(raw.lng || raw.longitude || saved.lng || saved.longitude);
  const id = String(raw.id ?? '').trim();
  const receiverMobile = String(saved.receiver_mobile || saved.receiver_phone || saved.mobile || saved.phone || raw.receiver_mobile || raw.mobile || raw.phone || '').replace(/\D/g, '').slice(-10);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < 6 || lat > 38 || lng < 67 || lng > 98) {
    return { ok: false, reason: 'ADDRESS_FIELDS_MISSING' };
  }
  return {
    ok: true,
    existing: payload.existing === true,
    address: {
      ...saved, ...raw,
      id,
      address_id: id,
      lat: String(lat),
      lng: String(lng),
      name: String(saved.name || saved.receiver_name || raw.name || raw.receiver_name || '').slice(0, 100),
      house: String(raw.house || raw.flat_no || saved.house || saved.flat_no || '').slice(0, 180),
      area: String(raw.area || raw.locality || raw.annotation || saved.area || saved.locality || '').slice(0, 180),
      formattedAddress: String(raw.text || raw.formatted_address || raw.formattedAddress || raw.address || saved.text || saved.formatted_address || saved.address || '').slice(0, 400),
      receiverMobile,
      isGlobal: raw.is_global === true
    }
  };
}

export function normalizeCreatedAddress(payload, submitted) {
  const raw = payload?.address || payload?.data?.address || null;
  const id = String(raw?.id ?? '').trim();
  const lat = Number(raw?.lat || raw?.latitude || submitted?.lat);
  const lng = Number(raw?.lng || raw?.longitude || submitted?.lng);
  if (payload?.success !== true || !id || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < 6 || lat > 38 || lng < 67 || lng > 98) {
    return { ok: false, reason: 'ADDRESS_CREATE_FAILED' };
  }
  const normalized = normalizeAddressResponse({ success: true, address: { ...submitted, ...raw, id, lat, lng }, saved: submitted });
  return normalized.ok ? normalized : { ok: false, reason: 'ADDRESS_CREATE_FAILED' };
}

export function normalizeGroupCartResponse(payload) {
  if (payload?.success !== true || payload?.already_in_group === true) {
    return { ok: false, reason: payload?.already_in_group ? 'ALREADY_IN_GROUP' : 'CART_IMPORT_FAILED' };
  }
  const restaurant = payload.restaurant || payload.data?.restaurant;
  const items = payload.items || payload.data?.items;
  const skipped = payload.skipped || payload.data?.skipped || [];
  if (!restaurant || typeof restaurant !== 'object' || !Array.isArray(items) || !items.length) {
    return { ok: false, reason: 'CART_RESPONSE_INCOMPLETE' };
  }
  if (skipped.length) return { ok: false, reason: 'ITEMS_SKIPPED', skipped };
  const cartId = String(payload.cart_id || payload.cartId || payload.data?.cart_id || payload.data?.cartId || '').trim();
  return { ok: true, restaurant, items, cartId };
}

export function apiFailureKind(errorOrPayload) {
  const code = String(errorOrPayload?.code || '').toUpperCase();
  const status = Number(errorOrPayload?.status || errorOrPayload?.statusCode || 0);
  const text = String(errorOrPayload?.message || errorOrPayload?.detail || errorOrPayload?.error || '').toLowerCase();
  if (/expired|invalid.*link|no longer exists|not found|already.*placed|address.*not.*available/.test(text)) return 'USER_INPUT';
  if (status === 400 || status === 404 || status === 422 || ['GROUP_CART_EXPIRED', 'ADDRESS_EXPIRED'].includes(code)) return 'USER_INPUT';
  if (status === 401 || status === 403 || status === 429 || status >= 500 || /timeout|network|temporar|rate limit/.test(text)) return 'SERVICE';
  return 'SERVICE';
}
