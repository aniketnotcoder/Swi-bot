import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorelexFlow } from '../storelex-flow.js';

const client = () => {
  const calls = [];
  return { calls,
    sessions: async () => ({ success: true, sessions: [{ mobile: '9876543210', is_expired: false }] }),
    resolveAddressByLink: async body => { calls.push(['address', body]); return { success: true, address: { id: 'a1', lat: 26.85, lng: 80.95 } }; },
    importGroupCart: async body => { calls.push(['group', body]); return { success: true, restaurant: { id: 'r1' }, items: [{ id: 'i1', quantity: 2 }], skipped: [] }; },
    repriceCart: async body => { calls.push(['bill', body]); return { success: true, cart_id: 'c1', bill: {}, bill_lines: [{ label: 'Total' }] }; },
    placeOrder: () => assert.fail('must never place an order')
  };
};

test('boss flow passes verified address/cart to repricing without placing', async () => {
  const api = client();
  const flow = createStorelexFlow(api);
  await flow.selectAccount('boss', '9876543210');
  await flow.address('boss', 'https://swiggy.onelink.me/abc');
  await flow.importGroup('boss', 'https://swig.gy/gc/test');
  assert.equal((await flow.bill('boss')).lineCount, 1);
  assert.deepEqual(api.calls[1][1], { mobile: '9876543210', link: 'https://swig.gy/gc/test', address_id: 'a1', lat: 26.85, lng: 80.95, leave_old: false });
  assert.equal(api.calls[2][1].items[0].quantity, 2);
});

test('rejects foreign links, unavailable account and malformed import without repricing', async () => {
  const api = client();
  const flow = createStorelexFlow(api);
  await assert.rejects(flow.selectAccount('boss', '1111111111'));
  await flow.selectAccount('boss', '9876543210');
  await assert.rejects(flow.address('boss', 'https://swiggy.com.evil.test/link'));
  await flow.address('boss', 'https://www.swiggy.com/address/a');
  api.importGroupCart = async () => ({ success: false, already_in_group: true });
  await assert.rejects(flow.importGroup('boss', 'https://swig.gy/gc/test'));
  await assert.rejects(flow.bill('boss'));
});
