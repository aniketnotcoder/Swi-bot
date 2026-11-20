// Boss-only preparation flow. No checkout/place calls: a pricing response is not
// evidence that placing an order is safe, and retries can create duplicate orders.
const mobilePattern = /^\d{10}$/;
const safeLink = (input, hosts) => {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error('Unsupported link');
  return url.toString();
};
const success = value => value && value.success === true;
const finiteCoord = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const id = value => (typeof value === 'string' || typeof value === 'number') && String(value).trim() ? String(value) : null;

export function createStorelexFlow(client) {
  // Ephemeral by design; never persist personal addresses or sessions.
  const drafts = new Map();
  return {
    async selectAccount(userId, mobile) {
      if (!mobilePattern.test(mobile)) throw new Error('10-digit mobile required');
      const response = await client.sessions();
      if (!success(response) || !Array.isArray(response.sessions)) throw new Error('Sessions cannot be verified');
      const account = response.sessions.find(item => String(item.mobile) === mobile);
      if (!account || account.is_expired || account.status === 'expired') throw new Error('Account unavailable or expired');
      drafts.set(String(userId), { mobile, accountName: typeof account.name === 'string' ? account.name : '' });
      return { selected: true };
    },
    async address(userId, rawLink) {
      const draft = drafts.get(String(userId));
      if (!draft) throw new Error('Select account first');
      const link = safeLink(rawLink, ['swiggy.com', 'swiggy.onelink.me']);
      const response = await client.resolveAddressByLink({ mobile: draft.mobile, link });
      const address = response?.address;
      if (!success(response) || !id(address?.id) || address?.lat == null || address?.lng == null || !finiteCoord(Number(address.lat), -90, 90) || !finiteCoord(Number(address.lng), -180, 180)) throw new Error('Address not verified by Storelex');
      draft.address = { id: id(address.id), lat: Number(address.lat), lng: Number(address.lng), raw: address };
      draft.imported = null;
      draft.bill = null;
      return { verified: true };
    },
    async importGroup(userId, rawLink) {
      const draft = drafts.get(String(userId));
      if (!draft?.address) throw new Error('Verify address first');
      const link = safeLink(rawLink, ['swiggy.com', 'swig.gy']);
      const response = await client.importGroupCart({ mobile: draft.mobile, link, address_id: draft.address.id, lat: draft.address.lat, lng: draft.address.lng, leave_old: false });
      if (!success(response) || !id(response.restaurant?.id) || !Array.isArray(response.items) || !response.items.length || !response.items.every(item => id(item.id) && Number.isSafeInteger(item.quantity) && item.quantity > 0)) throw new Error('Cart not verified by Storelex');
      draft.imported = { restaurant: response.restaurant, items: response.items };
      draft.bill = null;
      return { verified: true, itemCount: response.items.length, skipped: Array.isArray(response.skipped) ? response.skipped.length : 0 };
    },
    async bill(userId) {
      const draft = drafts.get(String(userId));
      if (!draft?.imported || !draft.address) throw new Error('Import cart and verify address first');
      const response = await client.repriceCart({ mobile: draft.mobile, restaurant: draft.imported.restaurant, items: draft.imported.items, address_id: draft.address.id, lat: draft.address.lat, lng: draft.address.lng, incognito: true, plan_id: '' });
      if (!success(response) || !id(response.cart_id) || !response.bill || !Array.isArray(response.bill_lines) || !response.bill_lines.length) throw new Error('Bill not verified by Storelex');
      draft.bill = { cartId: id(response.cart_id), cartValue: response.cart_value, lines: response.bill_lines, coupon: response.coupon, at: Date.now() };
      return { verified: true, lineCount: response.bill_lines.length, cartIdAvailable: true, lines: response.bill_lines.map(line => `${String(line.label || '').slice(0, 50)}: ${String(line.value ?? '').slice(0, 40)}`).slice(0, 15) };
    },
    paymentDraft(userId) {
      return drafts.get(String(userId));
    }
  };
}
