// Full-stack browser-flow smoke: gateway login → ws-relay → dbproxy → PostgreSQL.
// Uses the REAL gateway server and the REAL SDK, exactly like the browser does.
const path = require('node:path');
const { createRequire } = require('node:module');
const rootRequire = createRequire(path.join('C:', 'Users', 'Nexus', 'Documents', 'restaurant-pos', 'package.json'));

process.env.GATEWAY_JWT_SECRET = process.env.GATEWAY_JWT_SECRET ?? '523b8423c16d7b8c578609feb817fc14fba6209af9b521080ef0f1bd583703f20c28ad350fd1bc8cc5196f1f77bdce20';
process.env.SURREAL_URL = 'ws://127.0.0.1:8007/rpc';
process.env.SURREAL_USER = process.env.SURREAL_USER ?? 'restaurant';
process.env.SURREAL_PASS = process.env.SURREAL_PASS ?? 'fc3ec04f8907d7032df738bae6951b928d83';
process.env.SURREAL_NS = 'restaurant_manager';
process.env.SURREAL_DB = 'restaurant_manager';
process.env.GATEWAY_HOST = '127.0.0.1';
process.env.GATEWAY_PORT = '13142';
process.env.GATEWAY_AUTH_REQUIRED = 'true';
process.env.GATEWAY_ALLOWED_ORIGINS = '*';

(async () => {
  // 1. boot the real gateway
  await import(new URL('file:///C:/Users/Nexus/Documents/restaurant-pos/gateway/server.js').href);
  await new Promise((r) => setTimeout(r, 1500));
  const base = 'http://127.0.0.1:13142';

  // 2. login with a migrated PIN user (bcrypt compare runs in the proxy)
  const loginRes = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
    body: JSON.stringify({ method: 'pin', login: '1234', password: '1234' }),
  });
  const login = await loginRes.json();
  const sessionToken = login.token;
  console.log('login status:', loginRes.status, '| ok:', login.ok, '| user:', login.user?.login, '| role:', login.user?.user_role?.name, '| has surrealToken:', Boolean(login.surrealToken), '| has sessionToken:', Boolean(sessionToken));
  if (!loginRes.ok || !login.surrealToken || !sessionToken) process.exit(1);

  // 3. db-token refresh endpoint
  const refreshRes = await fetch(`${base}/auth/db-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}` },
  });
  const refreshed = await refreshRes.json();
  console.log('db-token refresh:', refreshRes.status, '| has token:', Boolean(refreshed.surrealToken));

  // 4. browser DB connect: ws-relay with the gateway JWT, then authenticate(surrealToken)
  const { Surreal } = rootRequire('surrealdb');
  const db = new Surreal();
  await db.connect(`ws://127.0.0.1:13142/rpc?token=${encodeURIComponent(sessionToken)}`, {
    namespace: 'restaurant_manager',
    database: 'restaurant_manager',
    authentication: login.surrealToken, // string token → SDK authenticate()
  });

  const me = await db.query('SELECT * FROM ONLY type::record($id) FETCH user_role', { id: login.user.id });
  console.log('authed query via ws-relay → me:', me?.login ?? me?.[0]?.login, '| role:', (me?.user_role ?? me?.[0]?.user_role)?.name);

  const dishes = await db.query('SELECT * FROM dish WHERE deleted_at = NONE LIMIT 5');
  console.log('dishes via relay:', Array.isArray(dishes[0]) ? dishes[0].length : 0);

  const users = await db.query('SELECT count() FROM user GROUP ALL');
  console.log('user count via relay:', users[0][0].count);

  // 5. live query through the relay
  const got = [];
  const live = await db.live('order').where('status = "In Progress"');
  const consume = (async () => { for await (const m of live) { got.push(m.action); if (got.length >= 1) break; } })().catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  const created = await db.create('order').content({ status: 'In Progress', total: 1, source: 'smoke' });
  await new Promise((r) => setTimeout(r, 1200));
  console.log('live via relay:', JSON.stringify(got));
  await live.kill();
  await db.delete(created.id ?? created[0].id);

  await db.close();
  console.log('FULL-STACK SMOKE: PASS');
  process.exit(0);
})().catch((e) => {
  console.error('SMOKE FAIL:', e.message);
  process.exit(1);
});
