import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { providerUpiQr } from './storelex-payment.js';
import { formatStorelexReceipt } from './storelex-receipt.js';

export function confirmedPayable(bill) {
  const rows = bill?.lines?.filter(row => /^(?:to pay|total payable|grand total)$/i.test(String(row.label || '').trim())) || [];
  const matches = rows.map(row => /^(?:₹\s*)?(\d+(?:\.\d{1,2})?)$/.exec(String(row.value ?? '').trim())).filter(Boolean);
  return matches.length === 1 ? matches[0][1] : null;
}

// One attempt per cart across restarts. An uncertain placement must be manually
// reconciled at Storelex; never blindly retry a payment-creating request.
export function createOwnerPay({ client, dataDir }) {
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Owner payment test needs an absolute persistent DATA_DIR');
  const journalFile = draft => path.join(dataDir, 'storelex-placement-journal', crypto.createHash('sha256').update(`${draft.mobile}:${draft.bill.cartId}`).digest('hex') + '.json');
  async function paymentStatus(draft) {
    if (!draft?.mobile || !draft?.bill?.cartId || !draft?.address?.id) throw new Error('No selected cart');
    const record = JSON.parse(await fs.readFile(journalFile(draft), 'utf8'));
    if (record.state !== 'QR_ISSUED' || !record.orderId || !record.txnId) throw new Error('Placement unresolved; check Storelex manually');
    const response = await client.paymentStatus({ mobile: draft.mobile, cart_id: draft.bill.cartId, address_id: draft.address.id, order_id: record.orderId, txn_id: record.txnId, method: 'upi', manual: false, deep: false });
    if (response?.success !== true) throw new Error('Payment status unverified');
    if (response.failed === true || response.order_failed === true || response.inconclusive === true || response.unknown === true) return 'PENDING_OR_UNKNOWN';
    return response.paid === true ? 'PAID' : 'PENDING_OR_UNKNOWN';
  }
  async function tracking(draft) {
    if (!draft?.mobile || !draft?.bill?.cartId) throw new Error('No selected cart');
    if (await paymentStatus(draft) !== 'PAID') return { status: 'Payment not confirmed', link: null, final: false };
    const record = JSON.parse(await fs.readFile(journalFile(draft), 'utf8'));
    if (record.state !== 'QR_ISSUED' || !record.orderId) throw new Error('Order not confirmed');
    const response = await client.orderStatus({ order_id: record.orderId });
    if (response?.success !== true || !response.status || /pending|unconfirmed|failed|cancel|unknown/i.test(String(response.status))) {
      return { status: 'Order not confirmed', link: null, final: false };
    }
    let link = null;
    if (typeof response.tracking_link === 'string') {
      try {
        const url = new URL(response.tracking_link);
        if (url.protocol === 'https:' && !url.username && !url.password &&
          ['swiggy.com', 'swig.gy'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) link = url.toString();
      } catch { /* no verified link */ }
    }
    return { status: String(response.status || 'Unknown').slice(0, 80), link, final: response.final === true };
  }
  async function receipt(draft) {
    if (!draft?.mobile || !draft?.bill?.cartId) throw new Error('No selected cart');
    if (await paymentStatus(draft) !== 'PAID') throw new Error('Payment not confirmed');
    const record = JSON.parse(await fs.readFile(journalFile(draft), 'utf8'));
    if (record.state !== 'QR_ISSUED' || !record.orderId) throw new Error('Order not confirmed');
    const detail = await client.orderDetail(draft.mobile, record.orderId);
    const returned = detail?.order && typeof detail.order === 'object' ? detail.order : detail;
    if (detail?.success !== true || String(returned?.order_id || '') !== record.orderId ||
      (!returned?.order_status && !returned?.status)) throw new Error('Order detail not confirmed');
    return formatStorelexReceipt(detail, draft.mobile);
  }
  async function pay(draft, enteredAmount) {
    const amount = Number(enteredAmount);
    if (!/^\d+(?:\.\d{1,2})?$/.test(String(enteredAmount)) || !Number.isFinite(amount) || amount <= 0 || amount > 10000) throw new Error('Invalid amount');
    if (!draft?.bill?.cartId || !draft?.address || !draft?.imported?.restaurant?.id || !draft?.mobile) throw new Error('Fresh bill required');
    if (Date.now() - draft.bill.at > 5 * 60_000) throw new Error('Bill expired');
    if (typeof draft.bill.cartValue !== 'number' || !Number.isFinite(draft.bill.cartValue) || draft.bill.cartValue <= 0 || !Array.isArray(draft.bill.lines) || !draft.bill.lines.length) throw new Error('Incomplete bill');
    // Require a human-readable final payable row, not cart_value (which can
    // exclude delivery/taxes). Never infer payable from a subtotal.
    const payable = confirmedPayable(draft.bill);
    if (!payable || Number(payable) !== amount) throw new Error('Payable does not match the confirmed bill');
    // Extra remote reconciliation when a local journal was lost on redeploy.
    // This does not replace an atomic persistent journal: Storelex may omit
    // unfinished/unconfirmed orders from its recent-orders feed.
    if (typeof client.recentOrders === 'function') {
      const recent = await client.recentOrders({ minutes: 60, live: false });
      const orders = Array.isArray(recent) ? recent : recent?.orders;
      if (Array.isArray(orders) && orders.some(order => String(order.cart_id || '') === draft.bill.cartId)) {
        throw new Error('Cart already appears in Storelex recent orders');
      }
    }
    const dir = path.join(dataDir, 'storelex-placement-journal');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = journalFile(draft);
    const handle = await fs.open(file, 'wx', 0o600); // atomic duplicate barrier
    try {
      await handle.writeFile(JSON.stringify({ at: new Date().toISOString(), state: 'ATTEMPTED', amount, cartId: draft.bill.cartId }));
      await handle.sync();
    } finally { await handle.close(); }
    const body = {
      mobile: draft.mobile, cart_id: draft.bill.cartId, address_id: draft.address.id,
      lat: draft.address.lat, lng: draft.address.lng,
      restaurant_id: draft.imported.restaurant.id, cart_value: draft.bill.cartValue,
      amount, method: 'upi',
      snap: { restaurant: draft.imported.restaurant, account_name: draft.accountName || '', items: draft.imported.items,
        bill_lines: draft.bill.lines, coupon: draft.bill.coupon || null, cooking: '', address: draft.address.raw }
    };
    // No retry. File is kept even for network errors / amount_changed so the
    // operator can reconcile remotely before initiating a *new* cart.
    const response = await client.placeOrder(body);
    if (!response?.success || response.amount_changed || response.unconfirmed) throw new Error('Placement not confirmed; reconcile in Storelex');
    const png = await providerUpiQr(response);
    const result = { orderId: String(response.order_id), txnId: String(response.txn_id), png };
    await fs.writeFile(file, JSON.stringify({ at: new Date().toISOString(), state: 'QR_ISSUED', amount, cartId: draft.bill.cartId, orderId: result.orderId, txnId: result.txnId }), { mode: 0o600 });
    return result;
  }
  pay.status = paymentStatus;
  pay.track = tracking;
  pay.receipt = receipt;
  return pay;
}
