'use strict';

/**
 * Tests for the optional MySQL tracking mirror (tracking-api/src/mysql-store.js).
 *
 * Run without a database — the "mirror inert" cases are the ones that prove
 * ingestion keeps working when MySQL is not configured:
 *   node --test tracking-api/src/mysql-store.test.js
 *
 * Run against a real MySQL — the integration block un-skips itself when
 * TRACKING_MYSQL_URL (or TRACKING_MYSQL_HOST/DB/USER/PASS) points at one:
 *   TRACKING_MYSQL_URL=mysql://pos:pos@127.0.0.1:3307/pos_tracking \
 *     node --test tracking-api/src/mysql-store.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('./mysql-store');

function withEnv(env, fn) {
  const previous = {};
  for (const key of Object.keys(env)) previous[key] = process.env[key];
  Object.assign(process.env, env);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(env)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

test('mirror is inert when no MySQL env is set', async () => {
  await withEnv(
    {
      TRACKING_MYSQL_URL: '',
      TRACKING_MYSQL_HOST: '',
      TRACKING_MYSQL_DB: '',
      TRACKING_MYSQL_USER: '',
      TRACKING_MYSQL_PASS: '',
    },
    async () => {
      assert.equal(store.mirrorStatus(), 'disabled');
      assert.equal(store.isMirrorConfigured(), false);
      assert.equal(store.mirrorConfig(), null);

      const before = store.mirrorFailures();
      const result = await store.writeTrackingEvent({ page: 'checkout', user: 'u1' });
      assert.deepEqual(result, { written: false, reason: 'mirror not configured' });
      // "Not configured" is a choice, not a failure — it must not inflate the
      // failure counter that /health reports.
      assert.equal(store.mirrorFailures(), before);
    }
  );
});

test('TRACKING_MYSQL_URL wins over the discrete parts', () => {
  const config = store.mirrorConfig({
    TRACKING_MYSQL_URL: 'mysql://a:b@db.internal:3306/analytics',
    TRACKING_MYSQL_HOST: 'ignored',
    TRACKING_MYSQL_DB: 'ignored',
    TRACKING_MYSQL_USER: 'ignored',
    TRACKING_MYSQL_PASS: 'ignored',
  });
  assert.deepEqual(config, {
    host: 'db.internal',
    port: 3306,
    user: 'a',
    password: 'b',
    database: 'analytics',
  });
});

test('a URL without an explicit port defaults to 3306', () => {
  const config = store.mirrorConfig({ TRACKING_MYSQL_URL: 'mysql://reader:secret@db.internal/analytics' });
  assert.equal(config.port, 3306);
});

test('a URL with encoded credentials is decoded', () => {
  const config = store.mirrorConfig({ TRACKING_MYSQL_URL: 'mysql://read%2Fer:p%40ss@db.internal:3307/analytics' });
  assert.equal(config.user, 'read/er');
  assert.equal(config.password, 'p@ss');
});

test('a wrong-scheme or database-less URL is rejected loudly', () => {
  assert.throws(
    () => store.mirrorConfig({ TRACKING_MYSQL_URL: 'postgres://a:b@h/d' }),
    /mysql:\/\/ scheme/
  );
  assert.throws(
    () => store.mirrorConfig({ TRACKING_MYSQL_URL: 'mysql://a:b@db.internal' }),
    /must carry both a host and a database/
  );
});

test('discrete parts build a pool config, and a missing part disables the mirror', () => {
  const full = store.mirrorConfig({
    TRACKING_MYSQL_HOST: 'db.internal',
    TRACKING_MYSQL_PORT: '6000',
    TRACKING_MYSQL_DB: 'analytics',
    TRACKING_MYSQL_USER: 'reader',
    TRACKING_MYSQL_PASS: 'secret',
  });
  assert.deepEqual(full, {
    host: 'db.internal',
    port: 6000,
    database: 'analytics',
    user: 'reader',
    password: 'secret',
  });

  for (const missing of ['TRACKING_MYSQL_HOST', 'TRACKING_MYSQL_DB', 'TRACKING_MYSQL_USER', 'TRACKING_MYSQL_PASS']) {
    const env = {
      TRACKING_MYSQL_HOST: 'db.internal',
      TRACKING_MYSQL_PORT: '6000',
      TRACKING_MYSQL_DB: 'analytics',
      TRACKING_MYSQL_USER: 'reader',
      TRACKING_MYSQL_PASS: 'secret',
      [missing]: '',
    };
    assert.equal(store.mirrorConfig(env), null, `expected null when ${missing} is empty`);
  }
});

test('a bogus port is rejected loudly instead of silently disabling the mirror', () => {
  assert.throws(
    () =>
      store.mirrorConfig({
        TRACKING_MYSQL_HOST: 'db.internal',
        TRACKING_MYSQL_PORT: 'not-a-port',
        TRACKING_MYSQL_DB: 'analytics',
        TRACKING_MYSQL_USER: 'reader',
        TRACKING_MYSQL_PASS: 'secret',
      }),
    /TRACKING_MYSQL_PORT/
  );
});

test('a safe client id becomes the primary key and is not duplicated in payload', () => {
  const row = store.toMirrorRow({
    id: 'evt_123-abc',
    page: 'floor',
    user: 'cashier',
    module: 'orders',
    payload: { order: 'order:1' },
  });
  assert.equal(row.trackingId, 'evt_123-abc');
  assert.equal(row.page, 'floor');
  assert.equal(row.userId, 'cashier');
  assert.equal(row.module, 'orders');
  assert.deepEqual(JSON.parse(row.payload), { payload: { order: 'order:1' } });
});

test('an unsafe id is replaced by a uuid but the original value is kept in payload', () => {
  for (const bad of ['user:abc', 'has space', 'x'.repeat(129), '']) {
    const row = store.toMirrorRow({ id: bad, page: 'p', user: 'u' });
    assert.match(row.trackingId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    if (bad) assert.equal(JSON.parse(row.payload).id, bad);
  }
});

test('missing page/user fall back to the same sentinels the record write uses', () => {
  const row = store.toMirrorRow({});
  assert.equal(row.page, 'unknown');
  assert.equal(row.userId, 'unknown');
  assert.equal(row.module, null);
  assert.ok(row.createdAt instanceof Date);
});

test('an unreachable MySQL reports a failure and keeps ingestion alive', async () => {
  await withEnv(
    {
      TRACKING_MYSQL_URL: 'mysql://nobody:nope@127.0.0.1:1/nothing',
      TRACKING_MYSQL_HOST: '',
      TRACKING_MYSQL_DB: '',
      TRACKING_MYSQL_USER: '',
      TRACKING_MYSQL_PASS: '',
    },
    async () => {
      await store.closeMirror();
      const before = store.mirrorFailures();
      const result = await store.writeTrackingEvent({ page: 'checkout', user: 'u1' });
      assert.equal(result.written, false);
      assert.match(result.reason, /mirror unavailable|mirror write failed/);
      assert.equal(store.mirrorFailures(), before + 1);
      await store.closeMirror();
    }
  );
});

test('mirror write retries after a failed bootstrap instead of sticking', async () => {
  await withEnv({ TRACKING_MYSQL_URL: 'mysql://nobody:nope@127.0.0.1:1/nothing' }, async () => {
    await store.closeMirror();
    const before = store.mirrorFailures();
    const first = await store.writeTrackingEvent({ page: 'a', user: 'u' });
    const second = await store.writeTrackingEvent({ page: 'b', user: 'u' });
    assert.equal(first.written, false);
    assert.equal(second.written, false);
    // A cached dead pool would fail the first event and then report
    // "written: false" without ever retrying — the counter proves both attempts
    // actually reached the connection layer.
    assert.equal(store.mirrorFailures(), before + 2);
    await store.closeMirror();
  });
});

test('upsert semantics match the record CREATE-over-write for a client id', () => {
  assert.match(store.UPSERT_SQL, /ON DUPLICATE KEY UPDATE/);
  assert.match(store.UPSERT_SQL, /VALUES \(\?, \?, \?, \?, \?, \?\) AS new/);
  assert.match(store.CREATE_TABLE_SQL, /CREATE TABLE IF NOT EXISTS tracking_events/);
  assert.match(store.CREATE_TABLE_SQL, /payload\s+JSON/);
  // MySQL has no CREATE INDEX IF NOT EXISTS, so both indexes must ship inside
  // the CREATE TABLE — otherwise a second bootstrap of the same table errors.
  assert.match(store.CREATE_TABLE_SQL, /KEY tracking_events_created_at_idx/);
  assert.match(store.CREATE_TABLE_SQL, /KEY tracking_events_module_created_at_idx/);
});

// ---------------------------------------------------------------------------
// Integration — only runs against a live MySQL. It is skipped (visibly)
// when no database is configured, so a green local run never pretends to have
// exercised the real SQL.
// ---------------------------------------------------------------------------

const liveConfig = store.mirrorConfig();

test(
  'live: schema, insert, upsert overwrite, and read-back',
  { skip: liveConfig ? false : 'set TRACKING_MYSQL_URL to run against a real MySQL' },
  async () => {
    const mysql = require('mysql2/promise');
    const admin = mysql.createPool({ ...liveConfig, connectionLimit: 2 });
    const runId = `itest_${Date.now()}`;

    try {
      await admin.query(store.CREATE_TABLE_SQL);

      const first = await store.writeTrackingEvent({
        id: `${runId}_a`,
        page: 'floor',
        user: 'cashier-1',
        module: 'orders',
        payload: { order: 42 },
      });
      assert.equal(first.written, true, first.reason);

      // Same id, changed body: must overwrite, never duplicate.
      const second = await store.writeTrackingEvent({
        id: `${runId}_a`,
        page: 'floor',
        user: 'cashier-2',
        module: 'orders',
        payload: { order: 99 },
      });
      assert.equal(second.written, true, second.reason);

      // No usable id: uuid row, kept original id inside payload.
      const third = await store.writeTrackingEvent({
        id: 'user:evil',
        page: 'reports',
        user: 'manager',
      });
      assert.equal(third.written, true, third.reason);

      const [rows] = await admin.query(
        `SELECT tracking_id, page, user_id, module, payload, created_at
           FROM tracking_events
          WHERE tracking_id LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$."id"')) = ?
          ORDER BY tracking_id`,
        [`${runId}%`, 'user:evil']
      );

      const byId = Object.fromEntries(rows.map((r) => [r.tracking_id, r]));
      assert.equal(byId[`${runId}_a`].user_id, 'cashier-2');
      assert.equal(byId[`${runId}_a`].page, 'floor');
      assert.equal(byId[`${runId}_a`].module, 'orders');
      // The JSON column mirrors the record document, which nests the event
      // body under its own `payload` field — so the columns are page/user_id/
      // module plus the untouched remainder.
      assert.deepEqual(byId[`${runId}_a`].payload, { payload: { order: 99 } });
      assert.ok(byId[`${runId}_a`].created_at instanceof Date);

      const unsafe = rows.find((r) => r.tracking_id !== `${runId}_a`);
      assert.ok(unsafe, 'expected a uuid-keyed row for the rejected id');
      assert.equal(unsafe.payload.id, 'user:evil');
      assert.equal(unsafe.user_id, 'manager');
    } finally {
      await admin.query(
        `DELETE FROM tracking_events
          WHERE tracking_id LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(payload, '$."id"')) = ?`,
        [`${runId}%`, 'user:evil']
      );
      await admin.end();
      // The mirror's own pool is opened by writeTrackingEvent above. Leaving it
      // idle keeps the event loop alive and the test file never exits, so it
      // must be closed here — the service test does the same.
      await store.closeMirror();
    }
  }
);
