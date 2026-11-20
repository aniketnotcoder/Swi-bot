import fs from 'node:fs';
import path from 'node:path';
import { createOwnerPay } from './storelex-owner-pay.js';

// A directory baked into the Docker image is NOT a persistent journal. Require
// a dedicated volume mount before exposing a money-moving action.
export function isDedicatedDataMount(dataDir, mountInfo) {
  if (!dataDir || !path.isAbsolute(dataDir)) return false;
  const wanted = path.resolve(dataDir);
  return String(mountInfo || '').split('\n').some(line => {
    const parts = line.split(' ');
    const mountPoint = parts[4]?.replace(/\\040/g, ' ');
    return mountPoint === wanted;
  });
}

export function configureOwnerPay(client, env = process.env, readMounts = () => fs.readFileSync('/proc/self/mountinfo', 'utf8')) {
  if (env.STORELEX_OWNER_PAY_TEST === '0') return { pay: null, reason: 'disabled by STORELEX_OWNER_PAY_TEST=0' };
  // The Docker image already provides /app/data; use it without requiring any
  // new host variable. When no volume is mounted this journal is best-effort
  // across redeploys, never a claim of durable idempotency.
  const dir = env.DATA_DIR || (fs.existsSync('/app/data') ? '/app/data' : path.resolve('data'));
  let mounted = false;
  try { mounted = isDedicatedDataMount(dir, readMounts()); } catch { /* no volume proof */ }
  return { pay: createOwnerPay({ client, dataDir: dir }), reason: mounted ? 'owner-only, persistent journal' : 'owner-only, local journal (redeploy can lose it)' };
}
