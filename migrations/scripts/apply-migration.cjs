'use strict';

/**
 * Apply a .surql migration over WebSocket (no host surreal CLI / no .sh required).
 *
 * Works anywhere Node can reach SurrealDB — your laptop, a one-off Docker
 * container, or an existing payment/api container.
 *
 * Usage:
 *   node migrations/scripts/apply-migration.cjs migrations/2026_07_18_location_stock_cutover.surql
 *
 * Env (required for production):
 *   SURREAL_URL   e.g. ws://surrealdb:8000/rpc  or  wss://db.example.com/rpc
 *   SURREAL_NS    default restaurant_manager
 *   SURREAL_DB    default restaurant_manager
 *   SURREAL_USER  (required — no default; must match the existing SurrealDB root user)
 *   SURREAL_PASS  (required — no default)
 *
 * Docker one-shot (from a machine that can reach the DB network):
 *   docker run --rm --network <compose_network> \
 *     -v "$PWD:/work" -w /work \
 *     -e SURREAL_URL=ws://surrealdb:8000/rpc \
 *     -e SURREAL_NS=restaurant_manager -e SURREAL_DB=restaurant_manager \
 *     -e SURREAL_USER=root -e SURREAL_PASS=root \
 *     node:20-alpine \
 *     sh -c "npm i surrealdb@2 ws --prefix /tmp/m && NODE_PATH=/tmp/m/node_modules \
 *            node migrations/scripts/apply-migration.cjs migrations/2026_07_18_location_stock_cutover.surql"
 *
 * If payments/ already has node_modules on the host:
 *   NODE_PATH=./payments/node_modules \
 *   SURREAL_URL=ws://YOUR_DB_HOST:8000/rpc \
 *   node migrations/scripts/apply-migration.cjs migrations/2026_07_18_location_stock_cutover.surql
 */

const fs = require('fs');
const path = require('path');
const WS = require('ws');
const { Surreal } = require('surrealdb');

if (typeof global.WebSocket === 'undefined') {
  global.WebSocket = WS;
}

const DB_URL = process.env.SURREAL_URL || 'ws://localhost:8000/rpc';
const DB_NS = process.env.SURREAL_NS || 'restaurant_manager';
const DB_NAME = process.env.SURREAL_DB || 'restaurant_manager';
const DB_USER = process.env.SURREAL_USER;
const DB_PASS = process.env.SURREAL_PASS;
if (!DB_USER || !DB_PASS) {
  console.error('ERROR: SURREAL_USER and SURREAL_PASS env vars are required. The previous root/root fallback was removed for security — set them explicitly (must match the existing SurrealDB root user created on first start).');
  process.exit(1);
}

const fileArg = process.argv[2];
if (!fileArg) {
  console.error('Usage: node apply-migration.cjs <path-to-migration.surql>');
  process.exit(1);
}

const filePath = path.isAbsolute(fileArg)
  ? fileArg
  : path.resolve(process.cwd(), fileArg);

if (!fs.existsSync(filePath)) {
  console.error(`Migration file not found: ${filePath}`);
  process.exit(1);
}

/** Strip SQL-style comments; keep statements separated by ; */
const stripComments = (sql) =>
  sql
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('--')) return '';
      return line;
    })
    .join('\n');

/**
 * A full export (e.g. migrations/demo-data.surql) also contains the
 * `_schema_migration` rows of the database it came from. Replaying those into a
 * database whose ledger already has the same names aborts the whole query on the
 * unique index — usually after half the data went in. The prod runner filters
 * them; do the same here so a manual apply of a dump stays usable.
 */
const withoutMigrationLedger = (sql) => {
  const lines = sql.split('\n');
  const kept = lines.filter((line) => !(line.trim().startsWith('INSERT') && line.includes('_schema_migration')));
  const dropped = lines.length - kept.length;
  if (dropped > 0) {
    console.log(`Skipping ${dropped} INSERT line(s) that only carry _schema_migration rows`);
  }
  return kept.join('\n');
};

async function main() {
  const raw = fs.readFileSync(filePath, 'utf8');
  const sql = withoutMigrationLedger(stripComments(raw)).trim();
  if (!sql) {
    console.error('Migration file is empty after stripping comments');
    process.exit(1);
  }

  console.log(`Applying ${path.basename(filePath)}`);
  console.log(`  url=${DB_URL} ns=${DB_NS} db=${DB_NAME}`);

  const db = new Surreal();
  await db.connect(DB_URL);
  await db.signin({ username: DB_USER, password: DB_PASS });
  await db.use({ namespace: DB_NS, database: DB_NAME });

  // Surreal accepts multi-statement queries in one call (DEFINE / LET / INSERT / UPDATE).
  const result = await db.query(sql);
  console.log('Query finished. Result batches:', Array.isArray(result) ? result.length : 1);

  await db.close();
  console.log(`Done: ${path.basename(filePath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
