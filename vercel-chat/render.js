export const MAIN_MENU = Object.freeze({
  keyboard: [
    [{ text: '🏆 Leaderboard' }, { text: '🆔 My ID' }],
    [{ text: '📦 My Orders' }, { text: '👛 Wallet' }],
    [{ text: '🛒 Naya order' }]
  ],
  resize_keyboard: true,
  is_persistent: true,
  input_field_placeholder: 'Cart ya address link bhejo'
});

export function html(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function rupeesFromPaise(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `₹${(amount / 100).toFixed(2).replace(/\.00$/, '')}` : '—';
}

export function positivePaise(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

// Storelex's /search/cart bill.to_pay is the authoritative payable, in paise.
// Never synthesize it from lines or combine fee fields whose units differ.
export function extractPayablePaise(payload) {
  const bill = payload?.bill || payload?.data?.bill || {};
  return positivePaise(bill.to_pay ?? bill.to_pay_paise);
}

function itemTitle(item) {
  return String(item?.name || 'Item').slice(0, 90);
}

export function buildBillCard({ restaurant, items, quote, coupon = null, accountLabel = '' }) {
  const totalPaise = extractPayablePaise(quote);
  if (!totalPaise) throw new Error('API did not return a confirmed payable total in paise.');
  const rows = Array.isArray(quote?.bill_lines) ? quote.bill_lines : [];
  const safeLines = rows.slice(0, 24).map(line => {
    const label = String(line?.label || '').trim().slice(0, 70);
    // This API field is already formatted text; do not parse/reformat it as money.
    const formattedValue = String(line?.value ?? '').trim().slice(0, 80);
    if (!label || !formattedValue) return null;
    return `• ${html(label)}: ${html(formattedValue)}`;
  }).filter(Boolean);
  const products = (Array.isArray(items) ? items : []).slice(0, 30).map(item => {
    const quantity = Math.max(1, Math.min(99, Number(item?.quantity || 1)));
    return `• ${html(itemTitle(item))} × ${quantity}`;
  });
  const restaurantName = String(restaurant?.name || 'Restaurant').slice(0, 80);
  const couponLine = coupon?.code
    ? `\n🏷 <b>Coupon ${coupon.valid === true ? 'valid' : coupon.valid === false ? 'not valid' : 'status unknown'}:</b> ${html(coupon.code)}`
    : '';
  const accountLine = accountLabel ? `\n👤 <b>Swiggy ID:</b> ${html(accountLabel)}` : '';
  const billText = [
    `🧾 <b>${html(restaurantName)}</b>`,
    accountLine,
    '',
    '<b>Items</b>',
    ...(products.length ? products : ['• Item details unavailable']),
    '',
    '<b>Bill · Storelex live quote</b>',
    ...(safeLines.length ? safeLines : ['• Bill breakdown unavailable']),
    couponLine,
    `\n💳 <b>Final To Pay: ${rupeesFromPaise(totalPaise)}</b>`,
    '<i>Final amount is from the Storelex /search/cart response and will be checked again before placement.</i>'
  ].filter(value => value !== null).join('\n').replace(/\n\n\n+/g, '\n\n');
  return { text: billText, totalPaise, lines: rows, items: products };
}

export function orderReviewKeyboard(token, hasAlternative = false) {
  const rows = [
    [{ text: '✅ ACCEPT & CONFIRM', callback_data: `order:accept:${token}` }],
    [{ text: '✖ CANCEL', callback_data: `order:cancel:${token}` }]
  ];
  if (hasAlternative) rows.push([{ text: '↻ TRY ANOTHER ELIGIBLE ACCOUNT', callback_data: `order:account:${token}` }]);
  return { inline_keyboard: rows };
}

export function homeMarkup() {
  return { reply_markup: MAIN_MENU };
}

export function inlineMarkup(inline_keyboard) {
  return { reply_markup: { inline_keyboard } };
}
