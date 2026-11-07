/**
 * Smoke test for RelationalStore against the converted database.
 * Run: DB_PASS=... node scratch/relational-smoke.mjs
 */
import mysql from 'mysql2/promise';
import { RelationalStore } from './src/store.relational.mjs';

const DB = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3307),
  database: process.env.DB_NAME ?? 'restaurant_manager_relational',
  user: process.env.DB_USER ?? 'restaurant',
  password: process.env.DB_PASS,
  timezone: '+00:00',
};

const pool = mysql.createPool(DB);
const store = new RelationalStore(pool, console);
await store.init();
const client = await pool.getConnection();
try {
  console.log('tables', (await store.listTables()).length);
  const users = await store.scanTable(client, 'user');
  console.log('users', users.length, JSON.stringify(users[0]?.data));

  const orders = await store.scanTable(client, 'order');
  const order = orders.find((o) => o.data.items);
  console.log('order', order?.id, order?.data?.number, 'items', order?.data?.items?.length);

  // write a record with a ref, a datetime, an array and a nested object
  const id = `smoke-${Date.now()}`;
  const kinds = new Map();
  const written = await store.writeRecord(
    client,
    'kitchen',
    id,
    {
      name: 'Smoke Kitchen',
      priority: 3,
      created_at: new Date().toISOString(),
      items: ['menu_item:item_peach_tea'],
      settings: { nested: { flag: true, depth: 2 }, list: [1, 'two', null] },
    },
    kinds,
    { auth: {} }
  );
  console.log('write', written.action);
  const [back] = await store.getRecords(client, 'kitchen', [id]);
  console.log('readback', JSON.stringify(back.data));
  const rows = await client.query(
    "SELECT path, kind FROM kitchen__attrs WHERE parent_id = ? ORDER BY path",
    [id]
  );
  console.log('attrs rows', rows[0].length, rows[0].map((r) => `${r.path}:${r.kind}`).join(', '));

  // update + delete
  const upd = await store.updateRecord(client, 'kitchen', id, (data) => ({ ...data, priority: 9 }), new Map(), {});
  console.log('update', upd.action, upd.after.priority);
  const del = await store.deleteRecord(client, 'kitchen', id, new Map(), {});
  console.log('delete', del.action);
  const gone = await store.getRecords(client, 'kitchen', [id]);
  console.log('gone', gone.length);

  // unique enforcement (account.code is UNIQUE if metadata carries it)
  console.log('unique indexes', store.uniqueCache.get('account'));
} finally {
  client.release();
  await pool.end();
}
