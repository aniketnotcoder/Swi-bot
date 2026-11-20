import QRCode from 'qrcode';

// Only a provider-returned UPI intent may become a QR. Never construct a
// payment intent from an estimated bill or an operator-supplied UPI address.
export async function providerUpiQr(response) {
  if (response?.success !== true || response.method !== 'upi' || !response.order_id || !response.txn_id) {
    throw new Error('Provider placement response is incomplete');
  }
  const raw = response.upi_url;
  if (typeof raw !== 'string' || raw.length > 2048 || !raw.startsWith('upi://pay?')) {
    throw new Error('No verified provider UPI payment intent');
  }
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Invalid provider UPI intent'); }
  if (parsed.protocol !== 'upi:' || parsed.hostname !== 'pay' || !parsed.searchParams.get('pa') || !parsed.searchParams.get('am') || !parsed.searchParams.get('cu')) {
    throw new Error('Incomplete UPI payment intent');
  }
  const amount = Number(parsed.searchParams.get('am'));
  if (!Number.isFinite(amount) || amount <= 0 || parsed.searchParams.get('cu') !== 'INR') throw new Error('Invalid provider amount');
  return QRCode.toBuffer(raw, { type: 'png', margin: 2, width: 400, errorCorrectionLevel: 'M' });
}
