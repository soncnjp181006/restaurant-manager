'use strict';

/**
 * Strip delivery/rider module tokens from stored `user_role.roles` arrays.
 *
 * The delivery feature is gone from access.rules, so these tokens are inert —
 * the permission tree is built from the rules, not from the row. They are
 * removed so no role keeps naming a screen that no longer exists.
 *
 * SurrealQL cannot filter one element out of a stored array here, which is why
 * this is a Node backfill rather than a line in 2026_11_06_remove_delivery.surql.
 *
 * Idempotent: a role whose array no longer contains any dropped token is not
 * written at all.
 *
 * Usage:
 *   SURREAL_URL=ws://127.0.0.1:8007/rpc \
 *   SURREAL_NS=restaurant_manager SURREAL_DB=restaurant_manager SURREAL_USER=root SURREAL_PASS=root \
 *   node migrations/scripts/backfill-strip-delivery-role-modules.cjs
 *
 * Env:
 *   DRY_RUN=1 — log only, do not write
 */

const WS = require('ws');
const { Surreal } = require('surrealdb');
if (typeof global.WebSocket === 'undefined') {
  global.WebSocket = WS;
}

const DB_URL = process.env.SURREAL_URL || 'ws://localhost:8007/rpc';
const DB_NS = process.env.SURREAL_NS || 'restaurant_manager';
const DB_NAME = process.env.SURREAL_DB || 'restaurant_manager';
const DB_USER = process.env.SURREAL_USER;
const DB_PASS = process.env.SURREAL_PASS;
if (!DB_USER || !DB_PASS) {
  console.error('ERROR: SURREAL_USER and SURREAL_PASS env vars are required.');
  process.exit(1);
}
const DRY_RUN = process.env.DRY_RUN === '1';

const DROPPED = new Set([
  'delivery',
  'delivery.orders',
  'delivery.areas',
  'delivery.settings',
  'riders',
  'rider',
  'reports.delivery_density',
  'reports.delivery_analytics',
]);

const rows = (result) => {
  const first = Array.isArray(result) ? result[0] : undefined;
  return Array.isArray(first) ? first : [];
};

const toId = (value) => {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.tb != null && value.id != null) {
    return `${value.tb}:${value.id}`;
  }
  const asString = String(value);
  return asString.includes(':') ? asString : null;
};

async function main() {
  const db = new Surreal();
  await db.connect(DB_URL);
  await db.signin({ username: DB_USER, password: DB_PASS });
  await db.use({ namespace: DB_NS, database: DB_NAME });

  const roles = rows(await db.query('SELECT id, name, roles FROM user_role'));
  console.log(`Found ${roles.length} role(s)`);

  let changed = 0;
  for (const role of roles) {
    const roleId = toId(role.id);
    if (!roleId || !Array.isArray(role.roles)) continue;

    const kept = role.roles.filter((token) => !DROPPED.has(String(token)));
    if (kept.length === role.roles.length) continue;

    changed += 1;
    console.log(
      `  ${role.name ?? roleId}: ${role.roles.length} -> ${kept.length} module(s) ` +
      `(dropped ${role.roles.filter((t) => DROPPED.has(String(t))).join(', ')})`
    );

    if (!DRY_RUN) {
      await db.merge(roleId, { roles: kept });
    }
  }

  console.log(`${DRY_RUN ? '[dry-run] would update' : 'updated'} ${changed} role(s)`);
  await db.close();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
