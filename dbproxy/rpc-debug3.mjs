import { Surreal } from 'surrealdb';
const db = new Surreal();
await db.connect('ws://127.0.0.1:8007/rpc');
await db.signin({ username: process.env.SURREAL_USER, password: process.env.SURREAL_PASS });
await db.use({ namespace: 'restaurant_manager', database: 'restaurant_manager' });
const q = (pin) => `SELECT * FROM user WHERE login = '${pin}' AND deleted_at = NONE AND (login_method = 'pin' OR login_method = NONE) AND crypto::bcrypt::compare(password, '${pin}') = true FETCH user_role, user_shift`;
for (const pin of ['1111','2222']) {
  try { console.log(pin, JSON.stringify(await db.query(q(pin))).slice(0,500)); } catch(e) { console.log(pin, 'ERR', e.message); }
}
await db.close();
