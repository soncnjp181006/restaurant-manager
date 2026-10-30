'use strict';

const { getClient } = require('../surreal-client');
const { writeTrackingEvent } = require('../postgres-store');

const TRACKING_TABLE = 'tracking';

function normalizeTrackingPayload(raw) {
  const payload = { ...(raw || {}) };

  if (!payload.created_at) {
    payload.created_at = new Date();
  }

  if (!payload.page) {
    payload.page = 'unknown';
  }

  if (!payload.user) {
    payload.user = 'unknown';
  }

  return payload;
}

function toTrackingId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text.length === 0) return null;

  // SECURITY: Prevent the client from choosing arbitrary record IDs that could
  // collide with system records or overwrite other tracking rows. SurrealDB's
  // CREATE type::record($table, $id) succeeds even if the id already exists
  // (it overwrites). We restrict the id format to a safe pattern: alphanumeric
  // + dashes + underscores, max 128 chars. This prevents:
  //   - Table-qualified IDs like 'user:abc' (cross-table overwrite)
  //   - IDs with colons (record separator)
  //   - IDs with spaces or special chars
  //   - Extremely long IDs (DoS)
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(text)) {
    return null;
  }

  return text;
}

async function createTracking(rawPayload) {
  const client = await getClient();
  const payload = normalizeTrackingPayload(rawPayload);
  const trackingId = toTrackingId(payload.id);

  let result;
  if (trackingId) {
    const { id, ...rest } = payload;
    const [created] = await client.query(
      'CREATE type::record($table, $id) CONTENT $data;',
      {
        table: TRACKING_TABLE,
        id: trackingId,
        data: rest,
      }
    );
    result = created;
  } else {
    const [created] = await client.query(
      'CREATE type::table($table) CONTENT $data;',
      {
        table: TRACKING_TABLE,
        data: payload,
      }
    );
    result = created;
  }

  // SurrealDB stays the store every report reads from; the PostgreSQL copy is
  // an analytical mirror. Its status is logged, never thrown — a missing or
  // broken Postgres must not turn a successful ingestion into a 500.
  const mirror = await writeTrackingEvent(payload);
  if (!mirror.written && mirror.reason !== 'mirror not configured') {
    // eslint-disable-next-line no-console
    console.error('Tracking PostgreSQL mirror write failed:', mirror.reason);
  }

  return result;
}

module.exports = {
  createTracking,
};
