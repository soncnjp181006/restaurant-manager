#!/usr/bin/env node
/**
 * Move every record from the old SurrealDB namespace/database (named after the
 * previous project name) to the renamed one.
 *
 * SurrealDB has no `RENAME NAMESPACE`, so a name change is a data move. This
 * script copies records only — schema comes from the normal migration path,
 * which you run FIRST against the new names:
 *
 *   SURREAL_NS=restaurant_manager SURREAL_DB=restaurant_manager \
 *     node migrations/scripts/run-prod-migrations.cjs
 *   SURREAL_URL=http://127.0.0.1:8000 SURREAL_USER=root SURREAL_PASS=root \
 *     node scripts/rename-surreal-namespace.mjs
 *
 * Behaviour:
 *   - reads every table of the source ns/db from information_schema.tables;
 *   - reads each row as `meta::id(id)` + the remaining fields;
 *   - `CREATE type::record(table, id) OVERWRITE CONTENT` into the target, so a
 *     re-run is idempotent and never duplicates;
 *   - refuses to run if the target ns/db does not exist yet or the source is
 *     empty (a typo in the env would otherwise move nothing and look like
 *     success);
 *   - does NOT delete the source. Verify the counts it prints, switch SURREAL_NS
 *     and SURREAL_DB in .env, and only then drop the old database by hand.
 *
 * Nothing here runs automatically; it is an operator action on a local stack.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Surreal } = require('surrealdb');
const WS = require('ws');
if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = WS;

const env = process.env;
// Same transport as migrations/scripts/apply-migration.cjs — the WS RPC endpoint,
// not /sql (SurrealDB 3.x changed that HTTP dialect).
const URL = env.SURREAL_URL || 'ws://127.0.0.1:8000/rpc';
const USER = env.SURREAL_USER;
const PASS = env.SURREAL_PASS;
const FROM_NS = env.SURREAL_NS_FROM || 'posr';
const FROM_DB = env.SURREAL_DB_FROM || 'posr';
const TO_NS = env.SURREAL_NS_TO || 'restaurant_manager';
const TO_DB = env.SURREAL_DB_TO || 'restaurant_manager';

if (!USER || !PASS) {
  console.error('SURREAL_USER and SURREAL_PASS are required (no defaults on purpose).');
  process.exit(1);
}
if (FROM_NS === TO_NS && FROM_DB === TO_DB) {
  console.error('Source and target are identical — nothing to do.');
  process.exit(1);
}

async function scoped(ns, db) {
  const handle = new Surreal();
  await handle.connect(URL);
  // Root credentials authenticate at system level; passing namespace/database to
  // signin() asks for an NS-/DB-level user, which does not exist (same order as
  // migrations/scripts/apply-migration.cjs).
  await handle.signin({ username: USER, password: PASS });
  await handle.use({ namespace: ns, database: db });
  return handle;
}

async function query(ns, db, stmt, vars) {
  const handle = await scoped(ns, db);
  try {
    return await handle.query(stmt, vars ? { ...vars } : undefined);
  } finally {
    await handle.close();
  }
}

function rows(result) {
  // The surrealdb JS SDK returns one entry per statement: a single-statement
  // call yields [value], where value is the row array for SELECT and an object
  // for INFO FOR DB (both shapes measured on surrealdb:v3.0.5).
  if (Array.isArray(result) && result.length === 1) return result[0];
  return result;
}

async function listTables(ns, db) {
  // information_schema.tables is empty over this endpoint (measured on
  // surrealdb:v3.0.5); INFO FOR DB is the reliable source of table names.
  const info = rows(await query(ns, db, 'INFO FOR DB'));
  const tables = info?.tables ?? {};
  return Object.keys(tables).sort();
}

async function main() {
  console.log(`Source: ${FROM_NS}/${FROM_DB}   Target: ${TO_NS}/${TO_DB}   ${URL}`);

  const tables = await listTables(FROM_NS, FROM_DB);
  if (tables.length === 0) {
    throw new Error(`No tables found in ${FROM_NS}/${FROM_DB} — is the source name right?`);
  }
  const targetTables = await listTables(TO_NS, TO_DB);
  if (targetTables.length === 0) {
    throw new Error(
      `Target ${TO_NS}/${TO_DB} has no tables — run migrations against it first (see header of this file).`
    );
  }

  let moved = 0;
  const report = [];
  for (const table of tables) {
    const source = rows(await query(FROM_NS, FROM_DB, 'SELECT meta::id(id) AS rid, * FROM type::table($table)', { table })) || [];
    if (source.length === 0) { report.push({ table, rows: 0, status: 'empty' }); continue; }

    const missing = source.filter((r) => r.rid == null || r.rid === '');
    if (missing.length) {
      throw new Error(`${table}: ${missing.length} row(s) without a readable record id — aborting`);
    }

    const target = await scoped(TO_NS, TO_DB);
    try {
      for (const row of source) {
        const { rid, id: _id, ...rest } = row;
        // UPSERT is the idempotent form — `CREATE … OVERWRITE` is not valid
        // SurrealQL on v3.0.5 (measured: "Unexpected token OVERWRITE").
        await target.query('UPSERT type::record($table, $rid) CONTENT $data;', {
          table,
          rid: String(rid),
          data: rest,
        });
        moved += 1;
      }
    } finally {
      await target.close();
    }

    // A target may legitimately already hold rows (it was created by the
    // migration run), so equality of counts is the wrong invariant: assert that
    // every source record id now exists in the target.
    const targetIds = new Set(
      (rows(await query(TO_NS, TO_DB, 'SELECT meta::id(id) AS rid FROM type::table($table)', { table })) || [])
        .map((r) => String(r.rid))
    );
    const absent = source.filter((r) => !targetIds.has(String(r.rid)));
    const tcount = (rows(await query(TO_NS, TO_DB, 'SELECT count() FROM type::table($table) GROUP ALL', { table })) || [{}])[0]?.count ?? 0;
    report.push({ table, rows: tcount, status: absent.length === 0 ? 'match' : `MISSING ${absent.length} in target` });
    if (absent.length) {
      throw new Error(`${table}: ${absent.length} source record(s) not present in target — copy incomplete`);
    }
  }

  console.table(report);
  console.log(`Copied ${moved} record(s) across ${tables.length} table(s).`);
  console.log(`Source ${FROM_NS}/${FROM_DB} was left untouched. Verify, then set SURREAL_NS=${TO_NS} SURREAL_DB=${TO_DB} in .env.`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
