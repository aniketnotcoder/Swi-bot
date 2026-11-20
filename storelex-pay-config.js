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
  const dir = env.DATA_DIR || (env.RENDER || env.RENDER_SERVICE_NAME ? '/app/data' : '');
  let mounted = false;
  try { mounted = isDedicatedDataMount(dir, readMounts()); } catch { /* no volume proof */ }
  if (!mounted) return { pay: null, reason: 'persistent DATA_DIR volume not mounted' };
  return { pay: createOwnerPay({ client, dataDir: dir }), reason: 'owner-only enabled' };
}
