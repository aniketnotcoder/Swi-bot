import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorelexClient, StorelexApiError } from './storelex-api.js';

const BASE = 'https://api.example.test/swiggy_web/api';
const fakeResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload
});

test('adds x-user-key without exposing it in the URL and parses authenticated GET', async () => {
  let seen;
  const client = createStorelexClient({
    baseUrl: BASE,
    userKey: 'TEST-KEY-DO-NOT-USE',
    fetchImpl: async (url, options) => {
      seen = { url: String(url), options };
      return fakeResponse({ success: true, sessions: [] });
    }
  });
  assert.deepEqual(await client.sessions(), { success: true, sessions: [] });
  assert.equal(seen.url, `${BASE}/sessions`);
  assert.equal(seen.options.headers['x-user-key'], 'TEST-KEY-DO-NOT-USE');
  assert.equal(seen.options.method, 'GET');
  assert.equal(seen.options.body, undefined);
});

test('serializes JSON bodies and URL-encodes account path segments', async () => {
  const calls = [];
  const client = createStorelexClient({
    baseUrl: BASE,
    userKey: 'TEST-KEY',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return fakeResponse({ success: true });
    }
  });
  await client.sendOtp('98/76543210');
  await client.addresses('98/76543210', { force: true });
  assert.equal(calls[0].url, `${BASE}/auth/send_otp`);
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), { mobile: '98/76543210' });
  assert.equal(calls[1].url, `${BASE}/addresses/98%2F76543210?force=true`);
});

test('manual address add and optional address-link import use separate endpoints and exact request shapes', async () => {
  const calls = [];
  const client = createStorelexClient({
    baseUrl: BASE, userKey: 'TEST-KEY',
    fetchImpl: async (url, options) => { calls.push({ url: String(url), options }); return fakeResponse({ success: true, address: { id: 'a1' } }); }
  });
  const addBody = { mobile: '9876543210', lat: '26.8', lng: '80.9', name: 'Receiver', receiver_mobile: '9123456789' };
  await client.addAddress(addBody, { timeoutMs: 45_000 });
  await client.resolveAddressByLink({ mobile: '9876543210', link: 'https://www.swiggy.com/ofo/address/abc' }, { timeoutMs: 45_000 });
  assert.equal(calls[0].url, `${BASE}/addresses/add`);
  assert.deepEqual(JSON.parse(calls[0].options.body), addBody);
  assert.equal(calls[1].url, `${BASE}/cart/address_by_link`);
  assert.deepEqual(JSON.parse(calls[1].options.body), { mobile: '9876543210', link: 'https://www.swiggy.com/ofo/address/abc' });
  assert.equal(calls[0].options.signal.aborted, false);
  assert.equal(calls[1].options.signal.aborted, false);
});

test('group import uses the documented endpoint/body and x-user-key header', async () => {
  const calls = [];
  const client = createStorelexClient({
    baseUrl: BASE,
    userKey: 'TEST-KEY',
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return fakeResponse({ success: false, already_in_group: true });
    }
  });
  await client.importGroupCart({ mobile: '9876543210', leave_old: false });
  await client.importGroupCart({ mobile: '9876543210', leave_old: true });
  assert.equal(calls[0].url, `${BASE}/cart/import_group`);
  assert.equal(calls[0].options.headers['x-user-key'], 'TEST-KEY');
  assert.deepEqual(JSON.parse(calls[0].options.body), { mobile: '9876543210', leave_old: false });
  assert.equal(calls[0].options.signal.aborted, false);
  assert.equal(calls[1].options.signal.aborted, false);
});

test('supports bodies on DELETE and long payment calls without exceeding 60s', async () => {
  let deletion;
  let payment;
  const client = createStorelexClient({
    baseUrl: BASE,
    userKey: 'TEST-KEY',
    fetchImpl: async (url, options) => {
      if (String(url).includes('/addresses/delete')) deletion = options;
      else payment = options;
      return fakeResponse({ success: true });
    }
  });
  await client.deleteAddress({ mobile: '9876543210', address_id: 'a1', is_global: false });
  await client.paymentStatus({ mobile: '9876543210', order_id: 'o1' });
  assert.equal(deletion.method, 'DELETE');
  assert.deepEqual(JSON.parse(deletion.body), { mobile: '9876543210', address_id: 'a1', is_global: false });
  assert.equal(payment.method, 'POST');
  assert.equal(payment.signal.aborted, false);
});

test('reports unauthorized without echoing the configured key', async () => {
  const secret = 'NEVER-ECHO-THIS-KEY';
  const client = createStorelexClient({
    baseUrl: BASE,
    userKey: secret,
    fetchImpl: async () => fakeResponse({ detail: 'Authentication Required' }, 401)
  });
  await assert.rejects(client.me(), error => {
    assert.ok(error instanceof StorelexApiError);
    assert.equal(error.code, 'STORELEX_UNAUTHORIZED');
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test('fails closed when key is absent and rejects non-HTTPS or absolute request paths', async () => {
  const client = createStorelexClient({ baseUrl: BASE, userKey: '', fetchImpl: async () => assert.fail('fetch must not run') });
  await assert.rejects(client.me(), error => error.code === 'STORELEX_NOT_CONFIGURED');
  assert.throws(() => createStorelexClient({ baseUrl: 'http://api.example.test', userKey: 'x' }), /HTTPS/);
  const configured = createStorelexClient({ baseUrl: BASE, userKey: 'x', fetchImpl: async () => fakeResponse({}) });
  await assert.rejects(configured.request('https://evil.example/steal'), /local absolute path/);
  await assert.rejects(configured.request('//evil.example/steal'), /local absolute path/);
});

test('maps network errors and response parse errors to safe API errors', async () => {
  const network = createStorelexClient({ baseUrl: BASE, userKey: 'x', fetchImpl: async () => { throw new Error('secret/url details'); } });
  await assert.rejects(network.me(), error => error.code === 'STORELEX_NETWORK_ERROR' && !error.message.includes('secret'));
  const invalid = createStorelexClient({
    baseUrl: BASE,
    userKey: 'x',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } })
  });
  await assert.rejects(invalid.me(), error => error.code === 'STORELEX_INVALID_RESPONSE');
});
