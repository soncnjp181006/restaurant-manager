// Debug login query FETCH through the dockerized proxy.
const { Surreal } = await import('surrealdb');

const db = new Surreal();
await db.connect('ws://127.0.0.1:8007/rpc', {
  namespace: 'restaurant_manager',
  database: 'restaurant_manager',
  authentication: { username: 'restaurant', password: 'fc3ec04f8907d7032df738bae6951b928d83' },
});

const r = await db.query(
  "SELECT * FROM user WHERE login = $login AND deleted_at = NONE AND (login_method = 'pin' OR login_method = NONE) AND crypto::bcrypt::compare(password, $password) = true FETCH user_role, user_shift",
  { login: '1234', password: '1234' }
);
const u = r[0][0];
console.log('rows:', r[0].length);
console.log('login:', u?.login);
console.log('user_role:', typeof u?.user_role, u?.user_role?.constructor?.name, JSON.stringify(u?.user_role)?.slice(0, 140));
console.log('user_shift:', typeof u?.user_shift);

const roleOnly = await db.query('SELECT * FROM ONLY type::record($roleId) WHERE deleted_at = NONE', {
  roleId: 'user_role:vixe1rlf7rox8256pg5t',
});
console.log('role fetch:', JSON.stringify(roleOnly)?.slice(0, 160));

await db.close();
process.exit(0);
