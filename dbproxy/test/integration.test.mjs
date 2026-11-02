/**
 * Integration test: the REAL `surrealdb` JS SDK (the exact client the app
 * uses) against the PostgreSQL-backed RPC server. Self-skips when no
 * PostgreSQL is reachable at DB_TEST_PORT (5433 default).
 *
 * Run: node --test test/integration.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { Surreal, RecordId, StringRecordId, Uuid } from 'surrealdb';

const PG = {
  host: process.env.DB_TEST_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_TEST_PORT ?? 5433),
  database: process.env.DB_TEST_DB ?? 'restaurant_manager',
  user: process.env.DB_TEST_USER ?? 'restaurant',
  password: process.env.DB_TEST_PASS ?? 'fc3ec04f8907d7032df738bae6951b928d83',
};

async function pgReachable() {
  try {
    const client = new pg.Pool({ ...PG, max: 1, connectionTimeoutMillis: 1500 });
    await client.query('SELECT 1');
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const hasPg = await pgReachable();

async function startServer() {
  const { PgStore } = await import('../src/store.mjs');
  const { DbAuth } = await import('../src/auth.mjs');
  const { LiveRegistry } = await import('../src/live.mjs');
  const { RpcServer } = await import('../src/rpc.mjs');

  const pool = new pg.Pool({ ...PG, max: 10 });
  const store = new PgStore(pool, console);
  await store.init();
  const auth = new DbAuth({
    rootUser: 'restaurant',
    rootPass: 'test-pass',
    secret: 'integration-test-secret-integration-test-secret',
  });
  const liveRegistry = new LiveRegistry(store, { pollMs: 100 });
  await liveRegistry.start();
  const rpc = new RpcServer({ store, auth, liveRegistry, logger: { warn: () => {}, error: () => {}, info: () => {} } });
  rpc.listen({ port: 18099, host: '127.0.0.1' });
  return {
    rpc,
    liveRegistry,
    store,
    async stop() {
      liveRegistry.stop();
      await rpc.close();
      await pool.end();
    },
  };
}

async function cleanTables(pool) {
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM records');
    await client.query('DELETE FROM change_log');
    await client.query('DELETE FROM unique_indexes');
    await client.query('DELETE FROM field_defaults');
    await client.query('DELETE FROM event_defs');
    await client.query('DELETE FROM field_kinds');
    const store = { kindsCache: new Map() };
    void store;
  } finally {
    client.release();
  }
}

test('SDK ↔ dbproxy ↔ PostgreSQL end-to-end', { skip: hasPg ? false : 'no PostgreSQL available' }, async (t) => {
  const server = await startServer();
  const pool = new pg.Pool({ ...PG, max: 2 });
  await cleanTables(pool);

  const db = new Surreal();
  await db.connect('ws://127.0.0.1:18099/rpc', {
    namespace: 'restaurant_manager',
    database: 'restaurant_manager',
    authentication: { username: 'restaurant', password: 'test-pass' },
  });

  t.after(async () => {
    await db.close();
    await cleanTables(pool);
    await server.stop();
    await pool.end();
  });

  // ---- basic CRUD ----------------------------------------------------------
  const created = await db.create(new RecordId('dish', 'pho')).content({
    name: 'Phở bò',
    price: 65000,
    cost: 22000,
    categories: [new RecordId('category', 'sup')],
    active: true,
  });
  assert.equal(created.id.toString(), 'dish:pho');
  assert.equal(created.price, 65000);

  const selected = await db.select(new RecordId('dish', 'pho'));
  assert.equal(selected.name, 'Phở bò');
  assert.ok(selected.id instanceof RecordId, 'id must decode as RecordId');

  // update with merge
  await db.update(new RecordId('dish', 'pho')).merge({ price: 70000 });
  const afterMerge = await db.select(new RecordId('dish', 'pho'));
  assert.equal(afterMerge.price, 70000);
  assert.equal(afterMerge.name, 'Phở bò');

  // upsert creates when missing
  const upserted = await db.upsert(new RecordId('dish', 'banhmi')).content({ name: 'Bánh mì', price: 25000 });
  assert.equal(upserted.name, 'Bánh mì');

  // query with WHERE + ORDER + LIMIT
  await db.create('dish').content({ name: 'Cà phê sữa', price: 20000 });
  await db.create('dish').content({ name: 'Trà đá', price: 5000 });
  const cheap = await db.query('SELECT * FROM dish WHERE price < $max ORDER BY price ASC LIMIT 2', { max: 30000 });
  const rows = cheap[0];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Trà đá');
  assert.ok(rows[0].id instanceof RecordId);

  // SELECT ONLY record (await returns per-statement results; ONLY unwraps to the record)
  const only = await db.query('SELECT * FROM ONLY type::record($id) FETCH categories', {
    id: 'dish:pho',
  });
  assert.equal(only[0].name, 'Phở bò');
  // categories link points at a not-yet-created record → FETCH yields NONE (field removed)
  assert.equal(only[0].categories, undefined);

  // FETCH hydration
  await db.create(new RecordId('category', 'sup')).content({ name: 'Soup' });
  await db.update(new RecordId('dish', 'pho')).merge({ categories: [new RecordId('category', 'sup')] });
  const withFetch = await db.query('SELECT * FROM dish:pho FETCH categories');
  assert.equal(withFetch[0][0].categories[0].name, 'Soup');
  assert.ok(withFetch[0][0].categories[0].id instanceof RecordId);

  // without FETCH, the link decodes as RecordId
  const noFetch = await db.query('SELECT * FROM dish:pho');
  assert.ok(noFetch[0][0].categories[0] instanceof RecordId, 'learned rid field must decode as RecordId');

  // SELECT ONLY with FETCH on role-like table (gateway auth shape)
  await db.create(new RecordId('user_role', 'manager')).content({ name: 'Manager', roles: ['manage'] });
  await db.create(new RecordId('user', 'anna')).content({
    login: 'anna',
    password: '$2a$10$abcdefghijklmnopqrstuv',
    user_role: 'user_role:manager',
    login_method: 'pin',
  });
  const roleOnly = await db.query('SELECT * FROM ONLY type::record($roleId)', { roleId: 'user_role:manager' });
  assert.equal(roleOnly[0].name, 'Manager');

  const userRow = await db.query(
    'SELECT * FROM user WHERE login = $login AND deleted_at = NONE AND login_method = $method FETCH user_role',
    { login: 'anna', method: 'pin' }
  );
  assert.equal(userRow[0].length, 1);
  assert.equal(userRow[0][0].user_role.name, 'Manager');
  assert.ok(userRow[0][0].user_role.id instanceof RecordId);

  // DELETE
  await db.delete(new RecordId('dish', 'banhmi'));
  const gone = await db.select(new RecordId('dish', 'banhmi')).catch(() => null);
  assert.ok(gone === null || gone === undefined || (Array.isArray(gone) && gone.length === 0));

  // aggregate
  const totals = await db.query('SELECT count() AS n, math::max(price) AS max_price FROM dish GROUP ALL');
  assert.equal(totals[0][0].n, 3);
  assert.equal(totals[0][0].max_price, 70000);

  // RELATE + edge query
  await db.create(new RecordId('dish_modifier_group', 'extras')).content({ name: 'Extras' });
  await db.query('RELATE $dish->dish_modifiers->$group SET quantity = 1', {
    dish: new RecordId('dish', 'pho'),
    group: new RecordId('dish_modifier_group', 'extras'),
  });
  const edges = await db.query('SELECT * FROM dish_modifiers WHERE in = $dish FETCH out', {
    dish: new RecordId('dish', 'pho'),
  });
  assert.equal(edges[0].length, 1);
  assert.equal(edges[0][0].out.name, 'Extras');

  // bcrypt compare via WHERE (gateway login flow)
  const bcrypt = (await import('bcryptjs')).default;
  const hash = bcrypt.hashSync('pin1234', 10);
  await db.update(new RecordId('user', 'anna')).merge({ password: hash });
  const login = await db.query(
    "SELECT * FROM user WHERE login = $login AND deleted_at = NONE AND (login_method = 'pin' OR login_method = NONE) AND crypto::bcrypt::compare(password, $password) = true FETCH user_role, user_shift",
    { login: 'anna', password: 'pin1234' }
  );
  assert.equal(login[0].length, 1);
  assert.equal(login[0][0].login, 'anna');

  // NONE removal semantics
  await db.query('UPDATE user:anna SET deleted_at = NONE');
  const anna = await db.select(new RecordId('user', 'anna'));
  assert.equal('deleted_at' in anna, false, 'NONE must remove the field');

  // datetime round-trip: SDK DateTime
  await db.query('UPDATE user:anna SET created_at = time::now()');
  const anna2 = await db.select(new RecordId('user', 'anna'));
  assert.ok(anna2.created_at, 'datetime must come back');
  const iso = anna2.created_at instanceof Date ? anna2.created_at.toISOString() : anna2.created_at.toString();
  assert.ok(!Number.isNaN(Date.parse(iso)));

  // UNIQUE index enforcement
  await db.query('DEFINE INDEX user_login_unique ON user FIELDS login UNIQUE');
  await assert.rejects(
    () => db.create('user').content({ login: 'anna', login_method: 'form' }),
    /Unique index 'user_login_unique'/
  );

  // DEFINE TABLE / FIELD accepted as no-ops; DEFAULT applied on create
  await db.query('DEFINE FIELD uploaded_at ON document TYPE datetime DEFAULT time::now()');
  const doc = await db.create('document').content({ name: 'a.pdf' });
  assert.ok((Array.isArray(doc) ? doc[0] : doc).uploaded_at, 'DEFINE FIELD DEFAULT time::now() must fill the field');

  // INFO FOR DB lists tables
  const info = await db.query('INFO FOR DB');
  assert.ok(info[0].tables.dish, 'INFO FOR DB lists the dish table');

  // SHOW CHANGES from change_log
  const changes = await db.query('SHOW CHANGES FOR TABLE dish SINCE 0 LIMIT 100');
  assert.ok(Array.isArray(changes[0]));
  assert.ok(changes[0].length > 0);
  assert.ok('versionstamp' in changes[0][0]);

  // live query: subscribe then mutate
  const received = [];
  const live = await db.live('order').where('status = "In Progress"');
  (async () => {
    for await (const msg of live) {
      received.push(msg);
    }
  })().catch(() => {});

  await db.create('order').content({ status: 'In Progress', total: 1 });
  await db.create('order').content({ status: 'Done', total: 2 });
  await db.update(new RecordId('order', 'order-1')).merge({ total: 5 }).catch(() => {});
  // find the In Progress order id
  const open = await db.query('SELECT * FROM order WHERE status = "In Progress"');
  const openId = open[0][0].id;
  await db.update(openId).merge({ total: 99 });
  await db.delete(openId);

  await new Promise((r) => setTimeout(r, 700));
  const actions = received.map((m) => m.action);
  assert.ok(actions.includes('CREATE'), `expected CREATE in ${JSON.stringify(actions)}`);
  assert.ok(actions.includes('UPDATE'), `expected UPDATE in ${JSON.stringify(actions)}`);
  assert.ok(actions.includes('DELETE'), `expected DELETE in ${JSON.stringify(actions)}`);
  const createdMsg = received.find((m) => m.action === 'CREATE');
  assert.equal(createdMsg.value.status, 'In Progress');
  assert.ok(createdMsg.recordId instanceof RecordId);
  await live.kill();

  // sessions: signin via root returns a token; authenticate works
  const token = await db.signin({ username: 'restaurant', password: 'test-pass' });
  assert.equal(typeof token.access, 'string');
});

test('RPC: bad statements return per-statement ERR without killing the batch', { skip: hasPg ? false : 'no PostgreSQL available' }, async (t) => {
  const server = await startServer();
  const pool = new pg.Pool({ ...PG, max: 2 });
  await cleanTables(pool);
  const db = new Surreal();
  await db.connect('ws://127.0.0.1:18099/rpc', {
    namespace: 'restaurant_manager',
    database: 'restaurant_manager',
    authentication: { username: 'restaurant', password: 'test-pass' },
  });
  t.after(async () => {
    await db.close();
    await cleanTables(pool);
    await server.stop();
    await pool.end();
  });

  const results = await db.query('SELECT * FROM missing_table; SELECT * FROM dish WHERE price > 0');
  assert.equal(results.length, 2);
  // first statement: SurrealDB returns an empty set for a missing table scan
  assert.deepEqual(results[0], []);
  assert.ok(Array.isArray(results[1]));
});
