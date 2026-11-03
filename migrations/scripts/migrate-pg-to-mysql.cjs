'use strict';

/**
 * Move the PostgreSQL store (the system of record before the MySQL switch)
 * into MySQL, table for table, and prove the copy is identical.
 *
 * The source is read from JSON files exported by psql, so this script needs no
 * PostgreSQL driver — nothing in the app depends on one any more. Export the
 * six source tables once, from a container still serving the old volume:
 *
 *   for t in records change_log field_kinds unique_indexes field_defaults event_defs; do
 *     docker exec <pg-container> psql -U <user> -d <db> -At \
 *       -c "SELECT COALESCE(json_agg(to_jsonb(x))::text,'[]') FROM $t x" > <dir>/$t.json
 *   done
 *
 *   (to_jsonb keeps jsonb as nested JSON and timestamptz as an ISO string,
 *   which is exactly what the loader below expects.)
 *
 * Then load and verify:
 *
 *   DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=restaurant DB_PASS=... \
 *   DB_NAME=restaurant_manager \
 *     node migrations/scripts/migrate-pg-to-mysql.cjs --from-dir <dir> --truncate
 *
 * Env:
 *   DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASS   target MySQL (the names dbproxy uses)
 *   SRC_DIR                                   export directory (default scratch/pg-export)
 *   CHUNK                                     rows per multi-row INSERT (default 200)
 *
 * Flags:
 *   --from-dir <dir>  override SRC_DIR
 *   --verify-only     skip the load, only compare source vs target
 *   --truncate        TRUNCATE the target tables before loading — without it a
 *                     non-empty target is refused, so a mistyped destination
 *                     cannot silently overwrite a live database
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..', '..');
const rootRequire = createRequire(path.join(ROOT, 'dbproxy', 'package.json'));
const mysql = rootRequire('mysql2/promise');
const STORE_MODULE = pathToFileURL(path.join(ROOT, 'dbproxy', 'src', 'store.mjs')).href;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SRC_DIR = path.resolve(ROOT, opt('from-dir', process.env.SRC_DIR ?? 'scratch/pg-export'));
const CHUNK = Number(process.env.CHUNK ?? 200);
const VERIFY_ONLY = flag('verify-only');
const TRUNCATE = flag('truncate');

const TARGET = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 3307),
  database: process.env.DB_NAME ?? 'restaurant_manager',
  user: process.env.DB_USER ?? 'restaurant',
  password: process.env.DB_PASS ?? 'fc3ec04f8907d7032df738bae6951b928d83',
};

/**
 * Column kinds:
 *   json — jsonb in the source, JSON in the target (compared canonically)
 *   ts   — timestamptz in the source, timestamp(3) in the target (±1 ms)
 *   upd  — participates in ON DUPLICATE KEY UPDATE (i.e. not part of the key)
 */
const TABLES = [
  {
    name: 'records',
    key: ['table_name', 'id'],
    cols: [
      { n: 'table_name' },
      { n: 'id' },
      { n: 'data', json: true, upd: true },
    ],
  },
  {
    // seq is AUTO_INCREMENT: writing the source value keeps the sync watermark
    // identical and moves the counter past it (asserted after the load).
    name: 'change_log',
    key: ['seq'],
    autoIncrement: 'seq',
    cols: [
      { n: 'seq' },
      { n: 'table_name' },
      { n: 'record_id' },
      { n: 'action' },
      { n: 'data', json: true, upd: true },
      { n: 'at', ts: true, upd: true },
    ],
  },
  {
    name: 'field_kinds',
    key: ['table_name', 'field'],
    cols: [
      { n: 'table_name' },
      { n: 'field' },
      { n: 'kind', upd: true },
    ],
  },
  {
    name: 'unique_indexes',
    key: ['name'],
    cols: [
      { n: 'name' },
      { n: 'table_name', upd: true },
      { n: 'fields', json: true, upd: true },
    ],
  },
  {
    name: 'field_defaults',
    key: ['table_name', 'field'],
    cols: [
      { n: 'table_name' },
      { n: 'field' },
      { n: 'expr', json: true, upd: true },
    ],
  },
  {
    name: 'event_defs',
    key: ['name'],
    cols: [
      { n: 'name' },
      { n: 'table_name', upd: true },
      { n: 'when_ast', json: true, upd: true },
      { n: 'then_statements', json: true, upd: true },
    ],
  },
];

/** timestamptz (ISO, tz-aware) → MySQL timestamp(3) literal in UTC. */
function toMysqlTimestamp(value) {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new Error(`unparsable timestamp: ${JSON.stringify(value)}`);
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

/** Sort object keys recursively: jsonb and MySQL JSON order members differently. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

const canon = (value) => JSON.stringify(canonical(value ?? null));

function readSource(name) {
  const file = path.join(SRC_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`missing export ${file}\n  (see the psql COPY commands in the header of this script)`);
  }
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(rows)) throw new Error(`${file} is not a JSON array`);
  return rows;
}

const keyOf = (spec, row) => spec.key.map((c) => String(row[c] ?? '')).join('\u0000');

function columnValue(spec, col, row) {
  const raw = row[col.n];
  if (col.json) return raw === undefined || raw === null ? null : JSON.stringify(raw);
  if (col.ts) return toMysqlTimestamp(raw);
  return raw === undefined ? null : raw;
}

async function load(pool, spec, rows) {
  const names = spec.cols.map((c) => c.n);
  const placeholders = names.map(() => '?').join(', ');
  const updates = spec.cols.filter((c) => c.upd).map((c) => `\`${c.n}\` = new.\`${c.n}\``);
  let loaded = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = [];
    const tuples = chunk.map((row) => {
      for (const col of spec.cols) values.push(columnValue(spec, col, row));
      return `(${placeholders})`;
    });
    const sql = updates.length
      ? `INSERT INTO ${spec.name} (${names.join(', ')}) VALUES ${tuples.join(', ')} AS new
         ON DUPLICATE KEY UPDATE ${updates.join(', ')}`
      : `INSERT INTO ${spec.name} (${names.join(', ')}) VALUES ${tuples.join(', ')}`;
    await pool.query(sql, values);
    loaded += chunk.length;
  }
  return loaded;
}

function compareCell(col, src, dst) {
  if (col.json) {
    const parsed = typeof dst === 'string' ? JSON.parse(dst) : dst;
    return canon(src) === canon(parsed);
  }
  if (col.ts) {
    const a = new Date(src ?? 0).getTime();
    const b = new Date(dst ?? 0).getTime();
    return Math.abs(a - b) <= 1;
  }
  return String(src ?? '') === String(dst ?? '');
}

async function verify(pool, spec, sourceRows) {
  const [targetRows] = await pool.query(`SELECT ${spec.cols.map((c) => `\`${c.n}\``).join(', ')} FROM ${spec.name}`);
  const problems = [];
  if (targetRows.length !== sourceRows.length) {
    problems.push(`row count ${sourceRows.length} (source) vs ${targetRows.length} (MySQL)`);
  }
  const byKey = new Map(targetRows.map((row) => [keyOf(spec, row), row]));
  for (const src of sourceRows) {
    const key = keyOf(spec, src);
    const dst = byKey.get(key);
    if (!dst) {
      problems.push(`missing row ${key.replace(/\u0000/g, ':')}`);
      continue;
    }
    for (const col of spec.cols) {
      if (!compareCell(col, src[col.n], dst[col.n])) {
        problems.push(`row ${key.replace(/\u0000/g, ':')} column "${col.n}" differs`);
        break;
      }
    }
  }
  return { source: sourceRows.length, target: targetRows.length, problems };
}

async function main() {
  console.log(`[migrate] source export: ${SRC_DIR}`);
  console.log(`[migrate] target MySQL : ${TARGET.user}@${TARGET.host}:${TARGET.port}/${TARGET.database}`);

  const specs = TABLES.map((spec) => ({ ...spec, rows: readSource(spec.name) }));
  for (const spec of specs) console.log(`[migrate] read ${spec.name}: ${spec.rows.length} rows`);

  const pool = mysql.createPool({ ...TARGET, connectionLimit: 4, connectTimeout: 15_000, timezone: '+00:00' });

  try {
    // The seven tables are dbproxy's schema; creating them here (from the same
    // DDL the service runs at start-up) means the mover works against a fresh
    // MySQL instance without booting the proxy first.
    const { INIT_SQL } = await import(STORE_MODULE);
    for (const ddl of INIT_SQL) await pool.query(ddl);

    if (!VERIFY_ONLY) {
      const [[{ n: existing }]] = await pool.query('SELECT COUNT(*) AS n FROM records');
      if (existing > 0 && !TRUNCATE) {
        throw new Error(
          `target already holds ${existing} rows in records — re-run with --truncate to replace them, or --verify-only to just compare`
        );
      }
      if (TRUNCATE) {
        for (const spec of specs) await pool.query(`TRUNCATE TABLE ${spec.name}`);
        console.log('[migrate] truncated target tables');
      }
      for (const spec of specs) {
        const t0 = Date.now();
        const loaded = await load(pool, spec, spec.rows);
        console.log(`[migrate] loaded ${loaded} rows into ${spec.name} (${Date.now() - t0}ms)`);
      }
    }

    const [[{ maxSeq }]] = await pool.query('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM change_log');
    const [[{ nextAuto }]] = await pool.query(
      "SELECT AUTO_INCREMENT AS nextAuto FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'change_log'",
      [TARGET.database]
    );

    let failures = 0;
    const report = (ok, label, detail) => {
      if (!ok) failures += 1;
      console.log(`  ${(ok ? 'OK' : 'MISMATCH').padEnd(9)} ${label}${detail ? ` — ${detail}` : ''}`);
    };

    console.log('\n[migrate] verification (source vs MySQL):');
    for (const spec of specs) {
      const result = await verify(pool, spec, spec.rows);
      report(
        result.problems.length === 0,
        `${spec.name}: ${result.source} → ${result.target}`,
        result.problems.slice(0, 3).join('; ') + (result.problems.length > 3 ? ` (+${result.problems.length - 3} more)` : '')
      );
    }

    const [perTable] = await pool.query('SELECT table_name, COUNT(*) AS n FROM records GROUP BY table_name');
    const srcPerTable = new Map();
    for (const row of specs.find((s) => s.name === 'records').rows) {
      srcPerTable.set(row.table_name, (srcPerTable.get(row.table_name) ?? 0) + 1);
    }
    const differs = perTable.filter((r) => r.n !== srcPerTable.get(r.table_name));
    const missingTables = [...srcPerTable.keys()].filter((t) => !perTable.some((r) => r.table_name === t));
    report(
      differs.length === 0 && missingTables.length === 0 && perTable.length === srcPerTable.size,
      `records per app table: ${srcPerTable.size} tables`,
      [...differs.map((d) => `${d.table_name}(${d.n})`), ...missingTables.map((t) => `${t}(0)`)].join(', ')
    );

    report(
      Number(nextAuto) > Number(maxSeq),
      `change_log seq watermark: max=${maxSeq} next_auto_increment=${nextAuto}`
    );

    const totalRows = specs.reduce((n, s) => n + s.rows.length, 0);
    console.log(`\n[migrate] ${totalRows} rows across ${specs.length} tables checked`);
    if (failures > 0) throw new Error(`${failures} check group(s) did not match`);
    console.log('[migrate] DONE — MySQL holds an identical copy of the PostgreSQL store');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] fatal:', err?.message ?? err);
  process.exit(1);
});
