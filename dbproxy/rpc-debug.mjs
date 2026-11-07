// Debug the exact gateway login query against the running dbproxy.
import { Surreal } from 'surrealdb';

const db = new Surreal();
await db.connect('ws://127.0.0.1:8007/rpc');
await db.signin({ username: process.env.SURREAL_USER, password: process.env.SURREAL_PASS });
await db.use({ namespace: 'restaurant_manager', database: 'restaurant_manager' });

const queries = {
  all: 'SELECT * FROM user',
  byLogin: "SELECT * FROM user WHERE login = '1234'",
  noneCheck: "SELECT * FROM user WHERE login = '1234' AND deleted_at = NONE",
  method: "SELECT * FROM user WHERE login = '1234' AND deleted_at = NONE AND (login_method = 'pin' OR login_method = NONE)",
  full: "SELECT * FROM user WHERE login = '1234' AND deleted_at = NONE AND (login_method = 'pin' OR login_method = NONE) AND crypto::bcrypt::compare(password, '1234') = true FETCH user_role, user_shift",
};
for (const [name, q] of Object.entries(queries)) {
  try {
    const result = await db.query(q);
    console.log(name, JSON.stringify(result).slice(0, 400));
  } catch (err) {
    console.log(name, 'ERROR', err.message);
  }
}
await db.close();
