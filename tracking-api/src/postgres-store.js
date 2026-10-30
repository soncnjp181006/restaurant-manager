'use strict';

/**
 * Optional PostgreSQL mirror of the tracking / activity log.
 *
 * Scope — deliberately ONE part of the system:
 *   SurrealDB stays the authoritative store for every read the app performs
 *   (activity report, order lifecycle, sales dashboard, cash audit, order
 *   detail all `SELECT * FROM tracking`). This module only writes a copy of
 *   each ingested event into PostgreSQL so that analytical queries have a
 *   relational, SQL-native home. Nothing here changes the SurrealDB schema,
 *   the `migrations/` folder, or any row already stored in SurrealDB.
 *
 * Failure policy:
 *   A mirror failure must never fail ingestion. `writeTrackingEvent` returns
 *   a status object instead of throwing, and `mirrorFailures()` exposes the
 *   count so `/health` can surface a silent breakage instead of hiding it.
 *
 * Enablement (all opt-in; unset env = feature completely inert):
 *   TRACKING_PG_URL=postgres://user:pass@host:5432/db      — libpq URL, or
 *   TRACKING_PG_HOST + TRACKING_PG_PORT + TRACKING_PG_DB
 *   + TRACKING_PG_USER + TRACKING_PG_PASS                  — discrete parts
 *   TRACKING_PG_SCHEMA — optional non-default search_path.
 */

const crypto = require('node:crypto');

const MIRROR_TABLE = 'tracking_events';

/** Same id discipline the Surreal write applies: no colons, no cross-table ids. */
const SAFE_TRACKING_ID = /^[a-zA-Z0-9_-]{1,128}$/;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${MIRROR_TABLE} (
  tracking_id text PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  page        text NOT NULL,
  user_id     text NOT NULL,
  module      text,
  payload     jsonb
);
CREATE INDEX IF NOT EXISTS ${MIRROR_TABLE}_created_at_idx
  ON ${MIRROR_TABLE} (created_at DESC);
CREATE INDEX IF NOT EXISTS ${MIRROR_TABLE}_module_created_at_idx
  ON ${MIRROR_TABLE} (module, created_at DESC);
`.trim();

const UPSERT_SQL = `
INSERT INTO ${MIRROR_TABLE}
  (tracking_id, created_at, page, user_id, module, payload)
VALUES ($1, $2, $3, $4, $5, $6::jsonb)
ON CONFLICT (tracking_id) DO UPDATE SET
  created_at = EXCLUDED.created_at,
  page       = EXCLUDED.page,
  user_id    = EXCLUDED.user_id,
  module     = EXCLUDED.module,
  payload    = EXCLUDED.payload
`;

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {object|null} pg pool config, or null when the mirror is not configured
 */
function mirrorConfig(env = process.env) {
  const url = (env.TRACKING_PG_URL || '').trim();
  if (url) {
    const config = { connectionString: url };
    const schema = (env.TRACKING_PG_SCHEMA || '').trim();
    if (schema) config.search_path = schema;
    return config;
  }

  const host = (env.TRACKING_PG_HOST || '').trim();
  const db = (env.TRACKING_PG_DB || '').trim();
  const user = (env.TRACKING_PG_USER || '').trim();
  const pass = (env.TRACKING_PG_PASS || '').trim();
  if (!host || !db || !user || !pass) return null;

  const port = Number((env.TRACKING_PG_PORT || '').trim() || 5432);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`TRACKING_PG_PORT must be a valid port number, got "${env.TRACKING_PG_PORT}"`);
  }

  const config = { host, port, database: db, user, password: pass };
  const schema = (env.TRACKING_PG_SCHEMA || '').trim();
  if (schema) config.search_path = schema;
  return config;
}

/**
 * Maps an ingested tracking payload onto mirror columns.
 * `user` becomes `user_id` because `user` is a reserved word in PostgreSQL.
 *
 * @param {Record<string, any>} raw payload already normalised by the service
 */
function toMirrorRow(raw) {
  const payload = { ...(raw || {}) };
  const suppliedId = typeof payload.id === 'string' ? payload.id.trim() : '';
  const usesSuppliedId = SAFE_TRACKING_ID.test(suppliedId);

  const { id, page, user, module, created_at: createdAt, ...rest } = payload;

  return {
    trackingId: usesSuppliedId ? suppliedId : crypto.randomUUID(),
    createdAt: createdAt instanceof Date ? createdAt : new Date(),
    page: String(page ?? 'unknown'),
    userId: String(user ?? 'unknown'),
    module: module == null ? null : String(module),
    // Surreal keeps a client id in the record key, not in the document, so the
    // mirrored jsonb must not duplicate it either way.
    payload: JSON.stringify(usesSuppliedId ? rest : { ...rest, ...(id ? { id } : {}) }),
  };
}

let pool = null;
let schemaReady = null;
let failures = 0;

function isMirrorConfigured(env = process.env) {
  return mirrorConfig(env) !== null;
}

async function getReadyPool() {
  if (schemaReady) return schemaReady;

  const config = mirrorConfig();
  if (!config) return null;

  const { Pool } = require('pg');
  pool = new Pool({ ...config, max: 5 });
  schemaReady = pool.query(CREATE_TABLE_SQL).then(() => pool);
  // A failed bootstrap must not be cached forever: the next event retries the
  // connection, otherwise one transient Postgres outage would disable the
  // mirror for the life of the process while still reporting "configured".
  schemaReady.catch(() => {
    schemaReady = null;
    const dead = pool;
    pool = null;
    dead.end().catch(() => {});
  });
  return schemaReady;
}

/**
 * @returns {Promise<{written: boolean, reason?: string, trackingId?: string}>}
 */
async function writeTrackingEvent(raw) {
  let row;
  try {
    row = toMirrorRow(raw);
  } catch (error) {
    failures += 1;
    return { written: false, reason: `payload not serialisable: ${error.message}` };
  }

  let activePool;
  try {
    activePool = await getReadyPool();
  } catch (error) {
    failures += 1;
    return { written: false, reason: `mirror unavailable: ${error.message}` };
  }
  if (!activePool) return { written: false, reason: 'mirror not configured' };

  try {
    await activePool.query(UPSERT_SQL, [
      row.trackingId,
      row.createdAt,
      row.page,
      row.userId,
      row.module,
      row.payload,
    ]);
    return { written: true, trackingId: row.trackingId };
  } catch (error) {
    failures += 1;
    return { written: false, reason: `mirror write failed: ${error.message}` };
  }
}

function mirrorStatus(env = process.env) {
  return isMirrorConfigured(env) ? 'configured' : 'disabled';
}

function mirrorFailures() {
  return failures;
}

async function closeMirror() {
  const active = pool;
  pool = null;
  schemaReady = null;
  if (!active) return;
  await active.end();
}

module.exports = {
  CREATE_TABLE_SQL,
  MIRROR_TABLE,
  UPSERT_SQL,
  closeMirror,
  isMirrorConfigured,
  mirrorConfig,
  mirrorFailures,
  mirrorStatus,
  toMirrorRow,
  writeTrackingEvent,
};
