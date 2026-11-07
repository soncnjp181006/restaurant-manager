import { Surreal } from 'surrealdb';
const db = new Surreal();
await db.connect('ws://127.0.0.1:8007/rpc');
await db.signin({ username: process.env.SURREAL_USER, password: process.env.SURREAL_PASS });
await db.use({ namespace: 'restaurant_manager', database: 'restaurant_manager' });
const all = await db.query('SELECT login, login_method, deleted_at FROM user');
console.log(JSON.stringify(all));
for (const q of ["SELECT * FROM user WHERE login = '1111'", "SELECT * FROM user WHERE login = '1234'", "SELECT * FROM user WHERE first_name = 'Waiter 1'", "SELECT * FROM user LIMIT 2"]) {
  try { console.log(q, JSON.stringify(await db.query(q)).slice(0,300)); } catch(e) { console.log(q, 'ERR', e.message); }
}
await db.close();
