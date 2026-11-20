// Telegram plain-text receipt sourced only from Storelex order_detail.
const text = value => String(value ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240);
export function formatStorelexReceipt(detail, mobile) {
  if (detail?.success !== true) throw new Error('Order detail unavailable');
  const order = detail.order && typeof detail.order === 'object' ? detail.order : detail;
  const lines = ['✅ Storelex order details', `Account: ••••${String(mobile).slice(-4)}`];
  for (const [label, value] of [['Restaurant', order.restaurant_name || order.restaurant?.name], ['Order ID', order.order_id], ['Payment', order.method || order.payment_method], ['Status', order.order_status || order.status]]) {
    if (value != null && value !== '') lines.push(`${label}: ${text(value)}`);
  }
  if (Array.isArray(order.items) && order.items.length) {
    lines.push('\nItems:');
    for (const item of order.items.slice(0, 30)) lines.push(`• ${text(item.name)} × ${text(item.quantity ?? 1)}${item.price != null ? ` — ${text(item.price)}` : ''}`);
  }
  const billLines = order.bill_lines || order.bill?.bill_lines;
  if (Array.isArray(billLines) && billLines.length) {
    lines.push('\nBill:');
    for (const item of billLines.slice(0, 25)) lines.push(`• ${text(item.label)}: ${text(item.value)}`);
  }
  const address = order.address;
  if (address && typeof address === 'object') {
    const location = address.formatted_address || address.address;
    if (location) lines.push(`\nDelivery address: ${text(location)}`);
    if (address.name) lines.push(`Receiver: ${text(address.name)}`);
    if (address.receiver_mobile) lines.push(`Receiver phone: ${text(address.receiver_mobile)}`);
  }
  if (order.tracking_link) {
    try {
      const url = new URL(order.tracking_link);
      if (url.protocol === 'https:' && ['swiggy.com', 'swig.gy'].some(h => url.hostname === h || url.hostname.endsWith(`.${h}`))) lines.push(`Tracking: ${url.toString()}`);
    } catch { /* never show an unverified URL */ }
  }
  return lines.join('\n').slice(0, 3900);
}
