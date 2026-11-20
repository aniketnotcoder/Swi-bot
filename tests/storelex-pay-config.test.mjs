import test from 'node:test';
import assert from 'node:assert/strict';
import { configureOwnerPay, isDedicatedDataMount } from '../storelex-pay-config.js';

const mounts = '1 2 0:1 / / rw - overlay overlay rw\n3 2 0:3 / /app/data rw - ext4 /dev/volume rw\n';
test('owner pay activates automatically only with a dedicated mounted data volume', () => {
  assert.equal(isDedicatedDataMount('/app/data', mounts), true);
  assert.equal(isDedicatedDataMount('/usr/src/app/data', mounts), false);
  assert.equal(configureOwnerPay({}, { RENDER: 'true' }, () => mounts).pay instanceof Function, true);
  assert.equal(configureOwnerPay({}, { RENDER: 'true' }, () => '1 2 0:1 / / rw - overlay overlay rw').pay, null);
  assert.equal(configureOwnerPay({}, { RENDER: 'true', STORELEX_OWNER_PAY_TEST: '0' }, () => mounts).pay, null);
});
