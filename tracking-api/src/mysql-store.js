'use strict';

/**
 * Optional MySQL mirror of the tracking / activity log.
 *
 * Scope — deliberately ONE part of the system:
 *   The dbproxy/MySQL store keeps `tracking` as the record every app report
 *   reads. This module only writes a copy of each ingested event into a flat,
 *   SQL-native `tracking_events` table so analytical queries have a relational
 *   home. Nothing here changes the record schema or any row already stored.
 *
 * Failure policy:
 *   A mirror failure must never fail ingestion. `writeTrackingEvent` returns
 *   a status object instead of throwing, and `mirrorFailures()` exposes the
 *   count so `/health` can surface a silent breakage instead of hiding it.
 *
 * Enablement (all opt-in; unset env = feature completely inert):
 *   TRACKING_MYSQL_URL=mysql://user:pass@host:3306/db      — full URL, or
 *   TRACKING_MYSQL_HOST + TRACKING_MYSQL_PORT + TRACKING_MYSQL_DB
 *   + TRACKING_MYSQL_USER + TRACKING_MYSQL_PASS            — discrete parts
 *   There is no TRACKING_MYSQL_SCHEMA: MySQL has no search_path, the database
 *   a mirror table lives in is TRACKING_MYSQL_DB (or the URL path).
 */

const crypto = require('node:crypto');

const MIRROR_TABLE = 'tracking_events';

/** Same id discipline the record write applies: no colons, no cross-table ids. */
const SAFE_TRACKING_ID = /^[a-zA-Z0-9_-]{1,128}$/;

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS ${MIRROR_TABLE} (
  tracking_id VARCHAR(128) NOT NULL,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  page        VARCHAR(255) NOT NULL,
  user_id     VARCHAR(255) NOT NULL,
  module      VARCHAR(255) NULL,
  payload     JSON NULL,
  PRIMARY KEY (tracking_id),
  KEY ${MIRROR_TABLE}_created_at_idx (created_at DESC),
  KEY ${MIRROR_TABLE}_module_created_at_idx (module, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
`.trim();

const UPSERT_SQL = `
INSERT INTO ${MIRROR_TABLE}
  (tracking_id, created_at, page, user_id, module, payload)
VALUES (?, ?, ?, ?, ?, ?) AS new
ON DUPLICATE KEY UPDATE
  created_at = new.created_at,
  page       = new.page,
  user_id    = new.user_id,
  module     = new.module,
  payload    = new.payload
`;

/** Percent-decoded, but never throws on a password containing a bare '%'. */
function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function assertPort(port, source) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${source} must be a valid port number, got "${port}"`);
  }
  return port;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {object|null} mysql2 pool config, or null when the mirror is not configured
 */
function mirrorConfig(env = process.env) {
  const url = (env.TRACKING_MYSQL_URL || '').trim();
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`TRACKING_MYSQL_URL is not a parseable mysql:// URL, got "${url}"`);
    }
    if (parsed.protocol !== 'mysql:' && parsed.protocol !== 'mysqlx:') {
      throw new Error(`TRACKING_MYSQL_URL must use the mysql:// scheme, got "${url}"`);
    }
    const config = {
      host: decodeURIComponentSafe(parsed.hostname),
      port: assertPort(parsed.port ? Number(parsed.port) : 3306, 'TRACKING_MYSQL_URL port'),
      user: decodeURIComponentSafe(parsed.username),
      password: decodeURIComponentSafe(parsed.password),
      database: decodeURIComponentSafe(parsed.pathname.replace(/^\/+/, '')),
    };
    if (!config.host || !config.database) {
      throw new Error(`TRACKING_MYSQL_URL must carry both a host and a database, got "${url}"`);
    }
    return config;
  }

  const host = (env.TRACKING_MYSQL_HOST || '').trim();
  const db = (env.TRACKING_MYSQL_DB || '').trim();
  const user = (env.TRACKING_MYSQL_USER || '').trim();
  const pass = (env.TRACKING_MYSQL_PASS || '').trim();
  if (!host || !db || !user || !pass) return null;

  const port = Number((env.TRACKING_MYSQL_PORT || '').trim() || 3306);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`TRACKING_MYSQL_PORT must be a valid port number, got "${env.TRACKING_MYSQL_PORT}"`);
  }

  return { host, port, database: db, user, password: pass };
}

/**
 * Maps an ingested tracking payload onto mirror columns.
 * `user` becomes `user_id` because `user` is a keyword in MySQL too.
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
    // The record keeps a client id in its key, not in the document, so the
    // mirrored JSON column must not duplicate it either way.
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

  const mysql = require('mysql2/promise');
  // The server session runs in UTC, so DATETIME/TIMESTAMP strings on the wire
  // are UTC: parse and escape them as UTC instead of the OS local zone.
  pool = mysql.createPool({ ...config, connectionLimit: 5, waitForConnections: true, queueLimit: 0, timezone: '+00:00' });
  schemaReady = pool.query(CREATE_TABLE_SQL).then(() => pool);
  // A failed bootstrap must not be cached forever: the next event retries the
  // connection, otherwise one transient MySQL outage would disable the
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
