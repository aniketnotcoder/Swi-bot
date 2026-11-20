import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOwnerPay } from '../storelex-owner-pay.js';

const draft = () => ({ mobile: '9876543210', address: { id: 'a1', lat: 26.85, lng: 80.95, raw: { id: 'a1' } }, imported: { restaurant: { id: 'r1' }, items: [{ id: 'i1', quantity: 1 }] }, bill: { cartId: 'c1', cartValue: 30000, lines: [{ label: 'To Pay', value: '₹349' }], at: Date.now() } });

test('only one owner payment attempt per cart, generates provider QR', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storelex-test-'));
  try {
    let calls = 0;
    const pay = createOwnerPay({ dataDir: dir, client: { placeOrder: async body => { calls++; assert.equal(body.amount, 349); return { success: true, method: 'upi', order_id: 'o1', txn_id: 't1', upi_url: 'upi://pay?pa=merchant%40upi&am=349&cu=INR' }; }, paymentStatus: async body => { assert.equal(body.order_id, 'o1'); return { success: true, paid: false, unknown: true }; }, orderStatus: async body => { assert.equal(body.order_id, 'o1'); return { success: true, status: 'Out for delivery', tracking_link: 'https://www.swiggy.com/track/order-1', final: false }; } } });
    const first = await pay(draft(), '349');
    assert.equal(first.png.subarray(0, 4).toString('hex'), '89504e47');
    assert.equal(await pay.status(draft()), 'PENDING_OR_UNKNOWN');
    assert.equal((await pay.track(draft())).link, 'https://www.swiggy.com/track/order-1');
    await assert.rejects(pay(draft(), '349'));
    assert.equal(calls, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('uncertain placement stays locked; bad draft never calls provider', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'storelex-test-'));
  try {
    let calls = 0;
    const pay = createOwnerPay({ dataDir: dir, client: { placeOrder: async () => { calls++; throw new Error('timeout'); } } });
    await assert.rejects(pay(draft(), 'not-an-amount'));
    assert.equal(calls, 0);
    await assert.rejects(pay(draft(), '349'));
    await assert.rejects(pay(draft(), '349'));
    assert.equal(calls, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
