'use strict';

/**
 * Tests for the ingestion path in tracking-api/src/services/tracking.service.js.
 *
 * The Surreal client is replaced with a recording stub (the service requires it
 * once, at load time), so these tests prove the wiring without a SurrealDB
 * instance: the Surreal query is unchanged, its result is what the route returns,
 * and the PostgreSQL mirror receives the same normalised payload.
 *
 * The "mirror actually stored it" case is a live PostgreSQL test — skipped
 * visibly when TRACKING_PG_URL is not set.
 *
 *   node --test tracking-api/src/services/tracking.service.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const store = require('../postgres-store');

const clientPath = require.resolve('../surreal-client.js');

function loadServiceWithStub(record) {
  require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
      getClient: async () => ({
        query: async (sql, params) => {
          record.calls.push({ sql, params });
          // Shape mirrors a Surreal CREATE result: the stored document with the
          // record id of the row that was written.
          return [{ ...params.data, id: `tracking:${params.id || 'auto'}` }];
        },
      }),
    },
  };
  const servicePath = require.resolve('./tracking.service.js');
  delete require.cache[servicePath];
  return require(servicePath);
}

function withoutPgEnv(fn) {
  const keys = ['TRACKING_PG_URL', 'TRACKING_PG_HOST', 'TRACKING_PG_DB', 'TRACKING_PG_USER', 'TRACKING_PG_PASS'];
  const previous = {};
  for (const key of keys) previous[key] = process.env[key];
  for (const key of keys) process.env[key] = '';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

test('a client-supplied safe id still goes through CREATE type::record', async () => {
  const record = { calls: [] };
  const { createTracking } = loadServiceWithStub(record);

  await withoutPgEnv(async () => {
    const result = await createTracking({ id: 'evt_1', page: 'floor', user: 'cashier' });
    assert.equal(record.calls.length, 1);
    assert.match(record.calls[0].sql, /CREATE type::record\(\$table, \$id\)/);
    assert.equal(record.calls[0].params.id, 'evt_1');
    assert.equal(record.calls[0].params.data.page, 'floor');
    // The route returns this value to the client — the mirror must not change it.
    assert.equal(result.id, 'tracking:evt_1');
    await store.closeMirror();
  });
});

test('an unsafe id still falls back to CREATE type::table', async () => {
  const record = { calls: [] };
  const { createTracking } = loadServiceWithStub(record);

  await withoutPgEnv(async () => {
    const result = await createTracking({ id: 'user:abc', page: 'floor', user: 'cashier' });
    assert.equal(record.calls.length, 1);
    assert.match(record.calls[0].sql, /CREATE type::table\(\$table\)/);
    assert.equal(record.calls[0].params.data.id, 'user:abc');
    assert.equal(result.id, 'tracking:auto');
    await store.closeMirror();
  });
});

test('ingestion succeeds with the mirror disabled', async () => {
  const record = { calls: [] };
  const { createTracking } = loadServiceWithStub(record);

  await withoutPgEnv(async () => {
    const before = store.mirrorFailures();
    const result = await createTracking({ page: 'reports', user: 'manager' });
    assert.ok(result, 'Surreal result must still be returned');
    assert.equal(store.mirrorStatus(), 'disabled');
    assert.equal(store.mirrorFailures(), before);
  });
});

test(
  'live: createTracking also lands in PostgreSQL',
  { skip: store.mirrorConfig() ? false : 'set TRACKING_PG_URL to run against a real PostgreSQL' },
  async () => {
    const { Pool } = require('pg');
    const config = store.mirrorConfig();
    const admin = new Pool({ ...config, max: 2 });
    const record = { calls: [] };
    const { createTracking } = loadServiceWithStub(record);
    const runId = `svc_${Date.now()}`;

    try {
      await admin.query(store.CREATE_TABLE_SQL);
      const result = await createTracking({
        id: runId,
        page: 'checkout',
        user: 'cashier-9',
        module: 'payments',
        payload: { order: 7 },
      });
      assert.equal(result.id, `tracking:${runId}`);

      const rows = await admin.query(
        'SELECT page, user_id, module, payload FROM tracking_events WHERE tracking_id = $1',
        [runId]
      );
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].page, 'checkout');
      assert.equal(rows.rows[0].user_id, 'cashier-9');
      assert.equal(rows.rows[0].module, 'payments');
      assert.deepEqual(rows.rows[0].payload, { payload: { order: 7 } });
    } finally {
      await admin.query('DELETE FROM tracking_events WHERE tracking_id = $1', [runId]);
      await admin.end();
      await store.closeMirror();
    }
  }
);
