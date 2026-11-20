import test from 'node:test';
import assert from 'node:assert/strict';
import { providerUpiQr } from '../storelex-payment.js';

test('only an actual successful Storelex UPI intent becomes a PNG QR', async () => {
  const png = await providerUpiQr({ success: true, method: 'upi', order_id: 'o1', txn_id: 't1', upi_url: 'upi://pay?pa=merchant%40upi&am=349.00&cu=INR&tn=order' });
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('does not create QR for unknown, failed, non-UPI or malformed responses', async () => {
  for (const response of [
    { success: false, method: 'upi', upi_url: 'upi://pay?pa=x&am=1&cu=INR' },
    { success: true, method: 'upi', order_id: 'o1', upi_url: 'upi://pay?pa=x&am=1&cu=INR' },
    { success: true, method: 'cod', order_id: 'o1', txn_id: 't1', upi_url: 'upi://pay?pa=x&am=1&cu=INR' },
    { success: true, method: 'upi', order_id: 'o1', txn_id: 't1', upi_url: 'https://evil.example/upi' },
    { success: true, method: 'upi', order_id: 'o1', txn_id: 't1', upi_url: 'upi://pay?pa=x&am=0&cu=INR' }
  ]) await assert.rejects(providerUpiQr(response));
});
