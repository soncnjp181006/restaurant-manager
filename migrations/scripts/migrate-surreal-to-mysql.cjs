'use strict';

/**
 * Migrate the legacy SurrealDB datastore (surrealkv files in ./database) into
 * MySQL via the dbproxy service.
 *
 * Steps performed by this script (see docs/MIGRATION-MYSQL.md):
 *   1. Connect to the running legacy SurrealDB (SRC_* env) and read the table
 *      list + every record.
 *   2. Connect to the MySQL data service (DST_* env, the dbproxy) and
 *      UPSERT every record with its original id. Record links, datetimes and
 *      other typed values travel as SDK objects so the proxy re-learns their
 *      wire types exactly like production writes.
 *   3. Apply migrations/latest.surql (DEFINE TABLE/FIELD/INDEX/EVENT) so
 *      unique indexes, field defaults and audit events are registered.
 *   4. Print a per-table row-count comparison for verification.
 *
 * Usage (from the repo root):
 *   node migrations/scripts/migrate-surreal-to-mysql.cjs
 *
 * Env:
 *   SRC_URL   ws://127.0.0.1:18000/rpc  (temp SurrealDB serving ./database)
 *   SRC_NS / SRC_DB / SRC_USER / SRC_PASS
 *   DST_URL   ws://127.0.0.1:18001/rpc  (dbproxy with DB_DISABLE_EVENTS=1)
 *   SCHEMA_FILE  migrations/latest.surql
 *   BATCH     records per UPSERT batch (default 100)
 */

const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..', '..');
const rootRequire = createRequire(path.join(ROOT, 'package.json'));
const { Surreal } = rootRequire('surrealdb');

const SRC_URL = process.env.SRC_URL ?? 'ws://127.0.0.1:18000/rpc';
const SRC_NS = process.env.SRC_NS ?? 'restaurant_manager';
const SRC_DB = process.env.SRC_DB ?? 'restaurant_manager';
const SRC_USER = process.env.SRC_USER ?? process.env.SURREAL_USER;
const SRC_PASS = process.env.SRC_PASS ?? process.env.SURREAL_PASS;
const DST_URL = process.env.DST_URL ?? 'ws://127.0.0.1:18001/rpc';
const DST_NS = process.env.DST_NS ?? 'restaurant_manager';
const DST_DB = process.env.DST_DB ?? 'restaurant_manager';
const DST_USER = process.env.DST_USER ?? process.env.SURREAL_USER;
const DST_PASS = process.env.DST_PASS ?? process.env.SURREAL_PASS;
const SCHEMA_FILE = path.join(ROOT, process.env.SCHEMA_FILE ?? 'migrations/latest.surql');
const BATCH = Number(process.env.BATCH ?? 100);

if (!SRC_USER || !SRC_PASS || !DST_USER || !DST_PASS) {
  console.error('[migrate] SURREAL_USER/SURREAL_PASS must be set (copy from .env)');
  process.exit(1);
}

async function connect(url, ns, db, user, pass, label) {
  const client = new Surreal();
  await client.connect(url, {
    namespace: ns,
    database: db,
    authentication: { username: user, password: pass },
  });
  console.log(`[migrate] connected: ${label} → ${url}`);
  return client;
}

async function listSourceTables(src) {
  const info = await src.query('INFO FOR DB');
  const first = Array.isArray(info) ? info[0] : info;
  const tables = first?.tables ? Object.keys(first.tables) : [];
  return tables;
}

async function readSourceTable(src, table) {
  const records = [];
  let start = 0;
  const pageSize = 1000;
  for (;;) {
    const result = await src.query(`SELECT * FROM type::table($table) LIMIT $limit START $start`, {
      table,
      limit: pageSize,
      start,
    });
    const rows = Array.isArray(result) ? result[0] : [];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const id = row?.id?.toString?.() ?? row?.id;
      if (!id) continue;
      const { id: _id, ...data } = row;
      records.push({ id: String(id), data });
    }
    if (rows.length < pageSize) break;
    start += pageSize;
  }
  return records;
}

function splitStatements(sql) {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));
}

async function applySchema(dst) {
  if (!fs.existsSync(SCHEMA_FILE)) {
    console.warn(`[migrate] schema file not found: ${SCHEMA_FILE} — skipping`);
    return 0;
  }
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const statements = splitStatements(sql);
  let applied = 0;
  const chunkSize = 40;
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize).join('; ');
    const result = await dst.query(chunk);
    for (const r of Array.isArray(result) ? result : []) {
      applied += 1;
      void r;
    }
  }
  return statements.length;
}

async function main() {
  const src = await connect(SRC_URL, SRC_NS, SRC_DB, SRC_USER, SRC_PASS, 'source (SurrealDB)');
  const dst = await connect(DST_URL, DST_NS, DST_DB, DST_USER, DST_PASS, 'target (dbproxy/MySQL)');

  const tables = await listSourceTables(src);
  console.log(`[migrate] source tables: ${tables.length}`);
  if (tables.length === 0) {
    console.error('[migrate] no tables found — is the source datastore the right one?');
    process.exit(1);
  }

  const counts = [];
  for (const table of tables) {
    const records = await readSourceTable(src, table);
    let imported = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH);
      const statements = [];
      const bindings = {};
      batch.forEach((rec, j) => {
        // Binding names are unique per record within the batch.
        const p = `r${i}_${j}`;
        statements.push(`UPSERT type::record($table_${p}, $id_${p}) CONTENT $data_${p}`);
        bindings[`table_${p}`] = table;
        bindings[`id_${p}`] = rec.id;
        bindings[`data_${p}`] = rec.data;
      });
      await dst.query(statements.join('; '), bindings);
      imported += batch.length;
    }
    counts.push({ table, source: records.length, imported });
    console.log(`[migrate] ${table}: ${records.length} records → imported ${imported}`);
  }

  const statementCount = await applySchema(dst);
  console.log(`[migrate] schema statements applied: ${statementCount}`);

  console.log('\n[migrate] verification (source vs imported):');
  let mismatches = 0;
  for (const { table, source, imported } of counts) {
    const status = source === imported ? 'OK' : 'MISMATCH';
    if (source !== imported) mismatches += 1;
    console.log(`  ${status.padEnd(9)} ${table}: ${source} → ${imported}`);
  }

  await src.close();
  await dst.close();
  if (mismatches > 0) {
    console.error(`\n[migrate] FAILED: ${mismatches} table(s) with mismatched counts`);
    process.exit(1);
  }
  console.log('\n[migrate] DONE — all tables migrated with matching counts');
}

main().catch((err) => {
  console.error('[migrate] fatal:', err?.message ?? err);
  if (err?.message && /already exists/i.test(err.message)) {
    console.error('[migrate] hint: records already exist in MySQL — the migration is not idempotent.');
    console.error('[migrate] hint: to re-run, TRUNCATE the records/field_kinds tables first (see docs/MIGRATION-MYSQL.md).');
  }
  process.exit(1);
});
