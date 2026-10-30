'use strict';

/**
 * Tests for the optional PostgreSQL tracking mirror (tracking-api/src/postgres-store.js).
 *
 * Run without a database — the "mirror inert" cases are the ones that prove
 * ingestion keeps working when Postgres is not configured:
 *   node --test tracking-api/src/postgres-store.test.js
 *
 * Run against a real PostgreSQL — the integration block un-skips itself when
 * TRACKING_PG_URL (or TRACKING_PG_HOST/DB/USER/PASS) points at one:
 *   TRACKING_PG_URL=postgres://pos:pos@127.0.0.1:55432/pos_tracking \
 *     node --test tracking-api/src/postgres-store.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('./postgres-store');

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

test('mirror is inert when no Postgres env is set', async () => {
  await withEnv(
    {
      TRACKING_PG_URL: '',
      TRACKING_PG_HOST: '',
      TRACKING_PG_DB: '',
      TRACKING_PG_USER: '',
      TRACKING_PG_PASS: '',
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

test('TRACKING_PG_URL wins over the discrete parts', () => {
  const config = store.mirrorConfig({
    TRACKING_PG_URL: 'postgres://a:b@db.internal:5432/analytics',
    TRACKING_PG_HOST: 'ignored',
    TRACKING_PG_DB: 'ignored',
    TRACKING_PG_USER: 'ignored',
    TRACKING_PG_PASS: 'ignored',
  });
  assert.deepEqual(config, { connectionString: 'postgres://a:b@db.internal:5432/analytics' });
});

test('discrete parts build a pool config, and a missing part disables the mirror', () => {
  const full = store.mirrorConfig({
    TRACKING_PG_HOST: 'db.internal',
    TRACKING_PG_PORT: '6000',
    TRACKING_PG_DB: 'analytics',
    TRACKING_PG_USER: 'reader',
    TRACKING_PG_PASS: 'secret',
  });
  assert.deepEqual(full, {
    host: 'db.internal',
    port: 6000,
    database: 'analytics',
    user: 'reader',
    password: 'secret',
  });

  for (const missing of ['TRACKING_PG_HOST', 'TRACKING_PG_DB', 'TRACKING_PG_USER', 'TRACKING_PG_PASS']) {
    const env = {
      TRACKING_PG_HOST: 'db.internal',
      TRACKING_PG_PORT: '6000',
      TRACKING_PG_DB: 'analytics',
      TRACKING_PG_USER: 'reader',
      TRACKING_PG_PASS: 'secret',
      [missing]: '',
    };
    assert.equal(store.mirrorConfig(env), null, `expected null when ${missing} is empty`);
  }
});

test('a bogus port is rejected loudly instead of silently disabling the mirror', () => {
  assert.throws(
    () =>
      store.mirrorConfig({
        TRACKING_PG_HOST: 'db.internal',
        TRACKING_PG_PORT: 'not-a-port',
        TRACKING_PG_DB: 'analytics',
        TRACKING_PG_USER: 'reader',
        TRACKING_PG_PASS: 'secret',
      }),
    /TRACKING_PG_PORT/
  );
});

test('TRACKING_PG_SCHEMA sets search_path', () => {
  const config = store.mirrorConfig({
    TRACKING_PG_URL: 'postgres://a:b@h/d',
    TRACKING_PG_SCHEMA: 'pos',
  });
  assert.equal(config.search_path, 'pos');
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

test('missing page/user fall back to the same sentinels the Surreal write uses', () => {
  const row = store.toMirrorRow({});
  assert.equal(row.page, 'unknown');
  assert.equal(row.userId, 'unknown');
  assert.equal(row.module, null);
  assert.ok(row.createdAt instanceof Date);
});

test('an unreachable Postgres reports a failure and keeps ingestion alive', async () => {
  await withEnv(
    {
      TRACKING_PG_URL: 'postgres://nobody:nope@127.0.0.1:1/nothing',
      TRACKING_PG_HOST: '',
      TRACKING_PG_DB: '',
      TRACKING_PG_USER: '',
      TRACKING_PG_PASS: '',
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
  await withEnv({ TRACKING_PG_URL: 'postgres://nobody:nope@127.0.0.1:1/nothing' }, async () => {
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

test('upsert semantics match the Surreal CREATE-over-write for a client id', () => {
  assert.match(store.UPSERT_SQL, /ON CONFLICT \(tracking_id\) DO UPDATE SET/);
  assert.match(store.CREATE_TABLE_SQL, /CREATE TABLE IF NOT EXISTS tracking_events/);
  assert.match(store.CREATE_TABLE_SQL, /payload\s+jsonb/);
});

// ---------------------------------------------------------------------------
// Integration — only runs against a live PostgreSQL. It is skipped (visibly)
// when no database is configured, so a green local run never pretends to have
// exercised the real SQL.
// ---------------------------------------------------------------------------

const liveConfig = store.mirrorConfig();

test(
  'live: schema, insert, upsert overwrite, and read-back',
  { skip: liveConfig ? false : 'set TRACKING_PG_URL to run against a real PostgreSQL' },
  async () => {
    const { Pool } = require('pg');
    const admin = new Pool({ ...liveConfig, max: 2 });
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

      const rows = await admin.query(
        `SELECT tracking_id, page, user_id, module, payload, created_at
           FROM tracking_events
          WHERE tracking_id LIKE $1 OR payload->>'id' = $2
          ORDER BY tracking_id`,
        [`${runId}%`, 'user:evil']
      );

      const byId = Object.fromEntries(rows.rows.map((r) => [r.tracking_id, r]));
      assert.equal(byId[`${runId}_a`].user_id, 'cashier-2');
      assert.equal(byId[`${runId}_a`].page, 'floor');
      assert.equal(byId[`${runId}_a`].module, 'orders');
      // The jsonb column mirrors the Surreal document, which nests the event
      // body under its own `payload` field — so the columns are page/user_id/
      // module plus the untouched remainder.
      assert.deepEqual(byId[`${runId}_a`].payload, { payload: { order: 99 } });
      assert.ok(byId[`${runId}_a`].created_at instanceof Date);

      const unsafe = rows.rows.find((r) => r.tracking_id !== `${runId}_a`);
      assert.ok(unsafe, 'expected a uuid-keyed row for the rejected id');
      assert.equal(unsafe.payload.id, 'user:evil');
      assert.equal(unsafe.user_id, 'manager');
    } finally {
      await admin.query(
        `DELETE FROM tracking_events
          WHERE tracking_id LIKE $1 OR payload->>'id' = $2`,
        [`${runId}%`, 'user:evil']
      );
      await admin.end();
    }
  }
);
