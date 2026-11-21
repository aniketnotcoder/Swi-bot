const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;

export class KvUnavailableError extends Error {
  constructor(message = 'Persistent Vercel KV is unavailable.') {
    super(message);
    this.name = 'KvUnavailableError';
    this.code = 'KV_UNAVAILABLE';
  }
}

export function createKv({
  url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '',
  token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '',
  fetchImpl = globalThis.fetch,
  prefix = 'storelexbot:v1:'
} = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  const secret = String(token || '').trim();
  const configured = Boolean(base && secret);

  async function command(parts) {
    if (!configured) throw new KvUnavailableError('Configure Vercel KV/Upstash REST URL and token.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    timer.unref?.();
    try {
      const response = await fetchImpl(base, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(parts),
        signal: controller.signal
      });
      if (!response.ok) throw new KvUnavailableError(`Vercel KV returned HTTP ${response.status}.`);
      const data = await response.json();
      if (data?.error) throw new KvUnavailableError('Vercel KV command failed.');
      return data?.result;
    } catch (error) {
      if (error instanceof KvUnavailableError) throw error;
      throw new KvUnavailableError(controller.signal.aborted ? 'Vercel KV timed out.' : 'Could not reach Vercel KV.');
    } finally {
      clearTimeout(timer);
    }
  }

  const key = value => `${prefix}${String(value)}`;
  const setJson = async (name, value, { ttlSeconds = DEFAULT_TTL_SECONDS, nx = false } = {}) => {
    const args = ['SET', key(name), JSON.stringify(value)];
    if (nx) args.push('NX');
    if (Number.isFinite(Number(ttlSeconds)) && Number(ttlSeconds) > 0) args.push('EX', String(Math.floor(Number(ttlSeconds))));
    const result = await command(args);
    return nx ? result === 'OK' : true;
  };
  const getJson = async name => {
    const result = await command(['GET', key(name)]);
    if (result === null || result === undefined) return null;
    try { return JSON.parse(result); }
    catch { throw new KvUnavailableError('A stored record is unreadable; refusing to reset it.'); }
  };
  const del = async name => Number(await command(['DEL', key(name)])) > 0;
  const zAdd = async (name, score, member) => command(['ZADD', key(name), String(Number(score) || 0), String(member)]);
  const zRem = async (name, member) => command(['ZREM', key(name), String(member)]);
  const zRevRange = async (name, start = 0, stop = 19, withScores = false) => {
    const result = await command(['ZREVRANGE', key(name), String(start), String(stop), ...(withScores ? ['WITHSCORES'] : [])]);
    return Array.isArray(result) ? result : [];
  };
  const zRangeByScore = async (name, min = '-inf', max = '+inf', limit = 100) => {
    const result = await command(['ZRANGEBYSCORE', key(name), String(min), String(max), 'LIMIT', '0', String(Math.max(1, Math.min(500, Number(limit) || 100)))]);
    return Array.isArray(result) ? result : [];
  };
  const incrBy = async (name, amount) => Number(await command(['INCRBY', key(name), String(Math.trunc(Number(amount) || 0))])) || 0;
  const expire = async (name, ttlSeconds) => command(['EXPIRE', key(name), String(Math.max(1, Math.floor(Number(ttlSeconds) || 1)))]);
  const raw = (parts) => command(parts.map((part, index) => index === 1 ? key(part) : part));
  async function initialize() {
    const markerKey = 'meta:schema';
    let marker = await getJson(markerKey);
    if (!marker) {
      const initial = { schemaVersion: 1, initializedAt: new Date().toISOString() };
      const created = await setJson(markerKey, initial, { nx: true, ttlSeconds: 0 });
      marker = created ? initial : await getJson(markerKey);
    }
    if (Number(marker?.schemaVersion) !== 1) {
      throw new KvUnavailableError('Stored KV schema is unknown; refusing to read/write user data.');
    }
    return marker;
  }

  return Object.freeze({
    configured,
    initialize,
    key,
    command,
    raw,
    setJson,
    getJson,
    del,
    zAdd,
    zRem,
    zRevRange,
    zRangeByScore,
    incrBy,
    expire
  });
}
