import fs from 'node:fs/promises';
import path from 'node:path';
import initSqlJs from 'sql.js';

export const SCHEMA = `CREATE TABLE IF NOT EXISTS scratch (
  telegram_id TEXT PRIMARY KEY, mobile TEXT, cart_id TEXT, address_id TEXT,
  lat REAL, lng REAL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS placements (
  telegram_id TEXT NOT NULL, cart_id TEXT NOT NULL, state TEXT NOT NULL,
  order_id TEXT, txn_id TEXT, method TEXT, PRIMARY KEY (telegram_id, cart_id)
);`;

export async function openStorelexScratch(file) {
  const SQL = await initSqlJs();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let db;
  try { db = new SQL.Database(await fs.readFile(file)); }
  catch (error) { if (error.code === 'ENOENT') db = new SQL.Database(); else throw error; }
  db.run(SCHEMA);
  let saving = Promise.resolve();
  const persist = () => {
    const bytes = Buffer.from(db.export());
    saving = saving.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, bytes, { mode: 0o600 });
      await fs.rename(tmp, file);
    });
    return saving;
  };
  const one = (sql, params) => {
    const statement = db.prepare(sql);
    try { statement.bind(params); return statement.step() ? statement.getAsObject() : null; }
    finally { statement.free(); }
  };
  return {
    get: id => one('SELECT * FROM scratch WHERE telegram_id = ?', [String(id)]) || { telegram_id: String(id) },
    async select(id, mobile) {
      db.run('INSERT INTO scratch (telegram_id,mobile,updated_at) VALUES (?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET mobile=excluded.mobile,cart_id=NULL,address_id=NULL,lat=NULL,lng=NULL,updated_at=excluded.updated_at', [String(id), mobile, Date.now()]);
      await persist();
    },
    async address(id, addressId, lat, lng) {
      db.run('UPDATE scratch SET address_id=?,lat=?,lng=?,cart_id=NULL,updated_at=? WHERE telegram_id=?', [addressId, lat, lng, Date.now(), String(id)]);
      await persist();
    },
    async cart(id, cartId) {
      db.run('UPDATE scratch SET cart_id=?,updated_at=? WHERE telegram_id=?', [cartId, Date.now(), String(id)]);
      await persist();
    },
    attempt: (id, cartId) => one('SELECT * FROM placements WHERE telegram_id=? AND cart_id=?', [String(id), cartId]),
    async lock(id, cartId) {
      if (this.attempt(id, cartId)) return false;
      db.run('INSERT INTO placements (telegram_id,cart_id,state) VALUES (?,?,?)', [String(id), cartId, 'ATTEMPTED']);
      await persist();
      return true;
    },
    async placed(id, cartId, orderId, txnId, method = 'upi') {
      db.run('UPDATE placements SET state=?,order_id=?,txn_id=?,method=? WHERE telegram_id=? AND cart_id=?', ['PLACED_PENDING_PAYMENT', orderId, txnId, method, String(id), cartId]);
      await persist();
    },
    async amountChanged(id, cartId) {
      db.run('DELETE FROM placements WHERE telegram_id=? AND cart_id=? AND state=?', [String(id), cartId, 'ATTEMPTED']);
      await persist();
    },
    async confirmed(id, cartId) {
      db.run('UPDATE placements SET state=? WHERE telegram_id=? AND cart_id=?', ['CONFIRMED', String(id), cartId]);
      await persist();
    },
    close: () => db.close()
  };
}
