import { Surreal } from 'surrealdb';
const db = new Surreal();
await db.connect('ws://127.0.0.1:8007/rpc');
await db.signin({ username: process.env.SURREAL_USER, password: process.env.SURREAL_PASS });
await db.use({ namespace: 'restaurant_manager', database: 'restaurant_manager' });
const queries = [
  ['orders', 'SELECT * FROM `order` ORDER BY created_at DESC LIMIT 3'],
  ['order_items', 'SELECT * FROM order_item LIMIT 3'],
  ['menu', 'SELECT * FROM menu_item'],
  ['settings', 'SELECT * FROM setting'],
  ['inventory', 'SELECT * FROM inventory_item'],
  ['journal', 'SELECT * FROM account_journal_entry'],
  ['group', 'SELECT count() FROM order GROUP ALL'],
  ['fetch', 'SELECT * FROM order_item LIMIT 2 FETCH order, menu_item'],
];
for (const [name, q] of queries) {
  try { const r = await db.query(q); console.log(name, JSON.stringify(r).slice(0, 220)); }
  catch (e) { console.log(name, 'ERR', e.message); }
}
console.log('create', JSON.stringify(await db.query("CREATE notes:live_smoke SET text = 'live write', created_at = time::now()")).slice(0,300));
console.log('update', JSON.stringify(await db.query("UPDATE notes:live_smoke SET text = 'edited'")).slice(0,200));
console.log('read', JSON.stringify(await db.query('SELECT * FROM notes:live_smoke')));
console.log('delete', JSON.stringify(await db.query('DELETE notes:live_smoke')));
await db.close();
