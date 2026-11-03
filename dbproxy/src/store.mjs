/**
 * MySQL persistence for the data service.
 *
 * Storage model: every SurrealDB table maps to rows in a single `records`
 * table — (table_name, id, data JSON). Record links ("table:id" strings),
 * datetimes (ISO-8601 UTC strings), decimals/uuids/durations (strings) are
 * re-hydrated to their wire types on read using per-field kinds learned at
 * write time and seeded from migrations/latest.surql during import.
 *
 * Metadata tables:
 *   field_kinds     — learned wire types per (table, field path)
 *   unique_indexes  — DEFINE INDEX ... UNIQUE (enforced on write)
 *   field_defaults  — DEFINE FIELD ... DEFAULT (applied on create)
 *   event_defs      — DEFINE EVENT (WHEN/THEN evaluated on write)
 *   change_log      — durable change feed (replaces SurrealDB changefeeds)
 *
 * Dialect notes (MySQL 8 / InnoDB, utf8mb4_bin so record ids stay byte-exact):
 *   jsonb           → JSON (the driver parses it back into objects, like jsonb)
 *   $n placeholders → ?
 *   ON CONFLICT     → ON DUPLICATE KEY UPDATE col = new.col (row alias)
 *   RETURNING seq   → result.insertId (seq is AUTO_INCREMENT)
 *   = ANY(array)    → IN (?, ?, …)
 *   data->>'col'    → JSON_EXTRACT(data, '$."col"') = CAST(? AS JSON)
 */

import { SRid, SDateTime, SDecimal, SUuid, SDuration, SNone, SSet, STagged } from './cbor.mjs';
import { DTMarker, evaluate, QueryError, NONE } from './eval.mjs';
import fs from 'node:fs';

const RID_PATH_RE = /^([A-Za-z_][A-Za-z0-9_]*):(.+)$/s;

const INIT_SQL = [
  `CREATE TABLE IF NOT EXISTS records (
     table_name VARCHAR(128) NOT NULL,
     id VARCHAR(512) NOT NULL,
     data JSON NOT NULL,
     created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
     PRIMARY KEY (table_name, id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS field_kinds (
     table_name VARCHAR(128) NOT NULL,
     field VARCHAR(512) NOT NULL,
     kind VARCHAR(64) NOT NULL,
     PRIMARY KEY (table_name, field)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS change_log (
     seq BIGINT NOT NULL AUTO_INCREMENT,
     table_name VARCHAR(128) NOT NULL,
     record_id VARCHAR(512) NOT NULL,
     action VARCHAR(16) NOT NULL,
     data JSON NULL,
     at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     PRIMARY KEY (seq),
     KEY change_log_table_idx (table_name, seq)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS unique_indexes (
     name VARCHAR(255) NOT NULL,
     table_name VARCHAR(128) NOT NULL,
     fields JSON NOT NULL,
     PRIMARY KEY (name),
     KEY unique_indexes_table_idx (table_name)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS field_defaults (
     table_name VARCHAR(128) NOT NULL,
     field VARCHAR(512) NOT NULL,
     expr JSON NOT NULL,
     PRIMARY KEY (table_name, field)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS event_defs (
     name VARCHAR(255) NOT NULL,
     table_name VARCHAR(128) NOT NULL,
     when_ast JSON NULL,
     then_statements JSON NOT NULL,
     PRIMARY KEY (name),
     KEY event_defs_table_idx (table_name)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

const REMOVED = Symbol('field-removed');

/** Normalize an incoming wire value into the JSON storage model. */
export function normalizeIn(value, table, path, kinds) {
  if (value instanceof SRid) {
    const s = `${value.table}:${value.id}`;
    learnKind(table, path, 'rid', kinds);
    return s;
  }
  if (value instanceof SDateTime) {
    learnKind(table, path, 'datetime', kinds);
    return value.iso;
  }
  if (value instanceof SDecimal) {
    learnKind(table, path, 'decimal', kinds);
    return value.str;
  }
  if (value instanceof SUuid) {
    learnKind(table, path, 'uuid', kinds);
    return value.str;
  }
  if (value instanceof SDuration) {
    learnKind(table, path, 'duration', kinds);
    return value.str;
  }
  if (value instanceof DTMarker) {
    learnKind(table, path, 'datetime', kinds);
    return value.iso;
  }
  if (value instanceof SNone) return REMOVED;
  if (value === NONE) return REMOVED;
  if (value === undefined) return REMOVED;
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (value instanceof SSet) {
    return normalizeIn(value.items, table, path, kinds);
  }
  if (value instanceof STagged) {
    // ranges / geometry / files are stored as tagged markers, best effort
    learnKind(table, path, `tag:${value.tag}`, kinds);
    return { __surreal_tag: value.tag, value: normalizeIn(value.value, table, path, kinds) };
  }
  if (value instanceof Date) {
    learnKind(table, path, 'datetime', kinds);
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeIn(item, table, path, kinds))
      .filter((v) => v !== REMOVED);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const v = normalizeIn(val, table, childPath, kinds);
      if (v !== REMOVED) out[key] = v;
    }
    return out;
  }
  throw new QueryError(`Cannot store value of type ${value?.constructor?.name ?? typeof value}`);
}

function learnKind(table, path, kind, kinds) {
  if (!path) return;
  kinds.set(`${table}\u0000${path}`, kind);
}

/** Serialize AST node for metadata tables (defaults/events). */
function astToJson(node) {
  return JSON.parse(JSON.stringify(node));
}

/** JSON path for a top-level record field, with the key safely quoted. */
function jsonPath(field) {
  const escaped = String(field).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `$."${escaped}"`;
}

export class MySqlStore {
  constructor(pool, logger = console) {
    this.pool = pool;
    this.logger = logger;
    // cache: table -> Map(field -> kind)
    this.kindsCache = new Map();
    // cache: table -> [{name, fields}]
    this.uniqueCache = new Map();
    // cache: table -> [{field, ast}]
    this.defaultsCache = new Map();
    // cache: table -> [{name, whenAst, thenStatements}]
    this.eventsCache = new Map();
  }

  async init() {
    const client = await this.pool.getConnection();
    try {
      for (const ddl of INIT_SQL) {
        await client.query(ddl);
      }
    } finally {
      client.release();
    }
    await this.loadKinds();
  }

  kindsForTable(table) {
    return this.kindsCache.get(table) ?? new Map();
  }

  async loadKinds() {
    const [kinds] = await this.pool.query('SELECT table_name, field, kind FROM field_kinds');
    for (const row of kinds) {
      const key = row.table_name;
      if (!this.kindsCache.has(key)) this.kindsCache.set(key, new Map());
      this.kindsCache.get(key).set(row.field, row.kind);
    }
    const [[uq], [def], [evt]] = await Promise.all([
      this.pool.query('SELECT name, table_name, fields FROM unique_indexes'),
      this.pool.query('SELECT table_name, field, expr FROM field_defaults'),
      this.pool.query('SELECT name, table_name, when_ast, then_statements FROM event_defs'),
    ]);
    for (const row of uq) {
      if (!this.uniqueCache.has(row.table_name)) this.uniqueCache.set(row.table_name, []);
      this.uniqueCache.get(row.table_name).push({ name: row.name, fields: row.fields });
    }
    for (const row of def) {
      if (!this.defaultsCache.has(row.table_name)) this.defaultsCache.set(row.table_name, []);
      this.defaultsCache.get(row.table_name).push({ field: row.field, ast: row.expr });
    }
    for (const row of evt) {
      if (!this.eventsCache.has(row.table_name)) this.eventsCache.set(row.table_name, []);
      this.eventsCache.get(row.table_name).push({
        name: row.name,
        whenAst: row.when_ast,
        thenStatements: row.then_statements,
      });
    }
  }

  async persistKinds(client, kinds) {
    for (const [key, kind] of kinds) {
      const [table, field] = key.split('\u0000');
      const existing = this.kindsCache.get(table)?.get(field);
      if (existing === kind) continue;
      await client.query(
        `INSERT INTO field_kinds (table_name, field, kind) VALUES (?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE kind = new.kind`,
        [table, field, kind]
      );
      if (!this.kindsCache.has(table)) this.kindsCache.set(table, new Map());
      this.kindsCache.get(table).set(field, kind);
    }
  }

  // ---- metadata -----------------------------------------------------------

  async upsertUniqueIndex(client, { name, table, fields }) {
    await client.query(
      `INSERT INTO unique_indexes (name, table_name, fields) VALUES (?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE table_name = new.table_name, fields = new.fields`,
      [name, table, JSON.stringify(fields)]
    );
    const list = this.uniqueCache.get(table) ?? [];
    const entry = { name, fields };
    const idx = list.findIndex((x) => x.name === name);
    if (idx === -1) list.push(entry);
    else list[idx] = entry;
    this.uniqueCache.set(table, list);
  }

  async upsertFieldDefault(client, { table, field, ast }) {
    await client.query(
      `INSERT INTO field_defaults (table_name, field, expr) VALUES (?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE expr = new.expr`,
      [table, field, JSON.stringify(astToJson(ast))]
    );
    const list = this.defaultsCache.get(table) ?? [];
    const entry = { field, ast };
    const idx = list.findIndex((x) => x.field === field);
    if (idx === -1) list.push(entry);
    else list[idx] = entry;
    this.defaultsCache.set(table, list);
  }

  async upsertEvent(client, { name, table, whenAst, thenStatements }) {
    if (process.env.DB_DEBUG_DEFINE) {
      try { JSON.stringify(whenAst); JSON.stringify(thenStatements); } catch (e) { console.error("[define-debug] stringify failed:", e.message); }
    }
    try {
      await client.query(
        `INSERT INTO event_defs (name, table_name, when_ast, then_statements) VALUES (?, ?, ?, ?) AS new
         ON DUPLICATE KEY UPDATE table_name = new.table_name, when_ast = new.when_ast, then_statements = new.then_statements`,
        [
          name,
          table,
          whenAst ? JSON.stringify(astToJson(whenAst)) : null,
          JSON.stringify(astToJson(thenStatements)),
        ]
      );
    } catch (err) {
      console.error("[event-debug] insert failed:", err.message, "name:", name, "table:", table);
      try { fs.writeFileSync("event-params.debug.json", JSON.stringify([name, table, whenAst ? astToJson(whenAst) : null, astToJson(thenStatements)])); } catch {}
      throw err;
    }
    const list = this.eventsCache.get(table) ?? [];
    const entry = { name, whenAst, thenStatements };
    const idx = list.findIndex((x) => x.name === name);
    if (idx === -1) list.push(entry);
    else list[idx] = entry;
    this.eventsCache.set(table, list);
  }

  async removeUniqueIndex(client, name, table) {
    await client.query('DELETE FROM unique_indexes WHERE name = ?', [name]);
    this.uniqueCache.set(table, (this.uniqueCache.get(table) ?? []).filter((x) => x.name !== name));
  }

  async removeFieldDefault(client, table, field) {
    await client.query('DELETE FROM field_defaults WHERE table_name = ? AND field = ?', [table, field]);
    this.defaultsCache.set(table, (this.defaultsCache.get(table) ?? []).filter((x) => x.field !== field));
  }

  async removeEvent(client, name, table) {
    await client.query('DELETE FROM event_defs WHERE name = ?', [name]);
    this.eventsCache.set(table, (this.eventsCache.get(table) ?? []).filter((x) => x.name !== name));
  }

  // ---- reads --------------------------------------------------------------

  async listTables(client) {
    const [rows] = await client.query('SELECT DISTINCT table_name FROM records ORDER BY table_name');
    return rows.map((r) => r.table_name);
  }

  async countRecords(client, table) {
    const [rows] = await client.query('SELECT COUNT(*) AS n FROM records WHERE table_name = ?', [table]);
    return Number(rows[0].n);
  }

  async getRecords(client, table, ids) {
    if (ids.length === 0) return [];
    const [rows] = await client.query(
      `SELECT id, data FROM records WHERE table_name = ? AND id IN (${ids.map(() => '?').join(', ')})`,
      [table, ...ids]
    );
    return rows;
  }

  async scanTable(client, table) {
    const [rows] = await client.query('SELECT id, data FROM records WHERE table_name = ?', [table]);
    return rows;
  }

  async scanTables(client, tables) {
    if (tables.length === 0) return [];
    const [rows] = await client.query(
      `SELECT table_name, id, data FROM records WHERE table_name IN (${tables.map(() => '?').join(', ')})`,
      tables
    );
    return rows;
  }

  async getMaxSeq(client) {
    const [rows] = await client.query('SELECT COALESCE(MAX(seq), 0) AS max FROM change_log');
    return Number(rows[0].max);
  }

  async getChangesSince(client, table, sinceSeq, limit) {
    const [rows] = await client.query(
      'SELECT seq, table_name, record_id, action, data, at FROM change_log WHERE seq > ? AND table_name = ? ORDER BY seq ASC LIMIT ?',
      [sinceSeq, table, Number(limit)]
    );
    return rows;
  }

  async getAllChangesSince(client, sinceSeq, limit) {
    const [rows] = await client.query(
      'SELECT seq, table_name, record_id, action, data, at FROM change_log WHERE seq > ? ORDER BY seq ASC LIMIT ?',
      [sinceSeq, Number(limit)]
    );
    return rows;
  }

  // ---- writes -------------------------------------------------------------

  /**
   * Upsert a record. Applies field defaults on create, enforces unique
   * indexes, fires DEFINE EVENT handlers, writes the change log.
   * @returns {action: 'CREATE'|'UPDATE', before, after}
   */
  async writeRecord(client, table, id, rawData, kinds, ctx = {}) {
    const data = normalizeIn(rawData, table, '', kinds);
    const existing = await this.getRecords(client, table, [id]);
    const before = existing[0]?.data ?? null;
    const isCreate = !existing[0];

    let finalData = data;
    if (isCreate) {
      finalData = await this.applyDefaults(client, table, data);
    }

    await this.enforceUnique(client, table, id, finalData);
    await this.persistKinds(client, kinds);

    const action = isCreate ? 'CREATE' : 'UPDATE';
    if (isCreate) {
      await client.query(
        'INSERT INTO records (table_name, id, data) VALUES (?, ?, ?)',
        [table, id, JSON.stringify(finalData)]
      );
    } else {
      await client.query(
        'UPDATE records SET data = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE table_name = ? AND id = ?',
        [JSON.stringify(finalData), table, id]
      );
    }

    const after = finalData;
    await this.appendChange(client, table, id, action, after);
    if (process.env.DB_DISABLE_EVENTS !== '1') {
      await this.fireEvents(client, table, id, action, before, after, ctx, kinds, 0);
    }

    return { action, before, after };
  }

  /** SurrealDB MERGE: shallow merge of objects (arrays replaced wholesale). */
  mergeData(base, patch) {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (value === REMOVED || value === undefined) delete out[key];
      else out[key] = value;
    }
    return out;
  }

  async applyDefaults(client, table, data) {
    const defaults = this.defaultsCache.get(table) ?? [];
    if (defaults.length === 0) return data;
    const out = { ...data };
    for (const { field, ast } of defaults) {
      if (out[field] !== undefined) continue;
      const value = normalizeIn(evaluate(ast, {}, {}, {}), table, field, new Map());
      if (value !== REMOVED && value !== undefined) out[field] = value;
    }
    return out;
  }

  async enforceUnique(client, table, id, data) {
    const uniques = this.uniqueCache.get(table) ?? [];
    for (const unique of uniques) {
      const values = unique.fields.map((f) => data[f]);
      if (values.some((v) => v === undefined)) continue; // NULLs don't conflict (SurrealDB semantic)
      // Typed comparison: the stored JSON scalar vs the value re-parsed as
      // JSON, so a number never matches the same digits written as a string
      // (jsonb's `data->>$n = $m` compared both as text).
      const sql = `SELECT id FROM records WHERE table_name = ? AND id <> ? AND ${unique.fields
        .map(() => 'JSON_EXTRACT(data, ?) = CAST(? AS JSON)')
        .join(' AND ')} LIMIT 1`;
      const params = [table, id, ...unique.fields.map(jsonPath), ...values.map((v) => JSON.stringify(v))];
      const [rows] = await client.query(sql, params);
      if (rows.length > 0) {
        throw new QueryError(
          `Unique index '${unique.name}' violated on table '${table}' (fields: ${unique.fields.join(', ')}) — existing record '${rows[0].id}'`,
          'unique'
        );
      }
    }
  }

  async appendChange(client, table, id, action, data) {
    const [result] = await client.query(
      'INSERT INTO change_log (table_name, record_id, action, data) VALUES (?, ?, ?, ?)',
      [table, id, action, data ? JSON.stringify(data) : null]
    );
    return Number(result.insertId);
  }

  async fireEvents(client, table, id, action, before, after, ctx, kinds, depth) {
    if (depth > 3) return;
    const events = this.eventsCache.get(table) ?? [];
    for (const event of events) {
      try {
        const eventCtx = {
          event: action,
          before: before ?? undefined,
          after: after ?? undefined,
          auth: ctx.auth ?? {},
        };
        if (event.whenAst) {
          const params = {
            event: action,
            before: before ?? undefined,
            after: after ?? undefined,
            auth: ctx.auth ?? {},
          };
          const result = evaluate(event.whenAst, {}, params, {});
          if (!result) continue;
        }
        for (const stmt of event.thenStatements ?? []) {
          await this.runEventStatement(client, stmt, eventCtx, kinds, depth + 1);
        }
      } catch (err) {
        this.logger.warn?.(`[events] event '${event.name}' on ${table}:${id} failed: ${err.message}`);
      }
    }
  }

  /** Execute a THEN statement of a DEFINE EVENT (currently: CREATE ... CONTENT <expr>). */
  async runEventStatement(client, stmt, eventCtx, kinds, depth) {
    if (stmt.kind !== 'create' && stmt.kind !== 'upsert') return;
    // Resolve the target (table|rid|param|type::record) using the event context as params.
    const target = stmt.target;
    let table = null;
    let id = null;
    if (target.t === 'table') table = target.name;
    else if (target.t === 'rid') {
      table = target.table;
      id = target.id;
    } else if (target.t === 'param') {
      const v = eventCtx[target.name];
      const m = typeof v === 'string' ? v.match(RID_PATH_RE) : null;
      if (m) {
        table = m[1];
        id = m[2];
      }
    } else if (target.t === 'func' && target.name === 'type::record') {
      const args = target.args.map((a) => {
        if (a.t === 'param') return eventCtx[a.name];
        if (a.t === 'lit') return a.v;
        return undefined;
      });
      if (args.length >= 2) {
        table = String(args[0]);
        id = String(args[1]);
      } else if (typeof args[0] === 'string') {
        const m = args[0].match(RID_PATH_RE);
        if (m) {
          table = m[1];
          id = m[2];
        }
      }
    }
    if (!table) return;
    const content = stmt.content
      ? normalizeIn(evaluate(stmt.content, {}, eventCtx, {}), table, '', new Map())
      : {};
    if (!id) {
      const generated = `${table}:${globalThis.crypto.randomUUID()}`;
      await this.writeRecord(client, table, generated, content, kinds, { auth: eventCtx.auth });
      return;
    }
    await this.writeRecord(client, table, id, content, kinds, { auth: eventCtx.auth });
  }

  /** Change a record's data with an arbitrary transform (patch/merge/set). */
  async updateRecord(client, table, id, transform, kinds, ctx = {}) {
    const existing = await this.getRecords(client, table, [id]);
    if (!existing[0]) return null;
    const before = existing[0].data;
    const after = transform(before);
    if (after === null) {
      return this.deleteRecord(client, table, id, kinds, ctx);
    }
    await this.enforceUnique(client, table, id, after);
    await this.persistKinds(client, kinds);
    await client.query(
      'UPDATE records SET data = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE table_name = ? AND id = ?',
      [JSON.stringify(after), table, id]
    );
    await this.appendChange(client, table, id, 'UPDATE', after);
    await this.fireEvents(client, table, id, 'UPDATE', before, after, ctx, kinds, 0);
    return { action: 'UPDATE', before, after };
  }

  async deleteRecord(client, table, id, kinds, ctx = {}) {
    const existing = await this.getRecords(client, table, [id]);
    if (!existing[0]) return null;
    const before = existing[0].data;
    await client.query('DELETE FROM records WHERE table_name = ? AND id = ?', [table, id]);
    // keep the before-image: LIVE SELECT DELETE pushes need a payload object
    await this.appendChange(client, table, id, 'DELETE', before);
    await this.fireEvents(client, table, id, 'DELETE', before, undefined, ctx, kinds, 0);
    return { action: 'DELETE', before };
  }

  /** Bulk insert used by the migration importer (bypasses events/defaults). */
  async bulkImport(client, table, records) {
    const kinds = new Map();
    const values = [];
    const chunks = [];
    for (const rec of records) {
      const normalized = normalizeIn(rec.data, table, '', kinds);
      chunks.push('(?, ?, ?)');
      values.push(table, rec.id, JSON.stringify(normalized));
    }
    if (chunks.length === 0) return 0;
    await client.query(
      `INSERT INTO records (table_name, id, data) VALUES ${chunks.join(', ')} AS new
       ON DUPLICATE KEY UPDATE data = new.data`,
      values
    );
    await this.persistKinds(client, kinds);
    return records.length;
  }
}

export { REMOVED, RID_PATH_RE, jsonPath, INIT_SQL };
