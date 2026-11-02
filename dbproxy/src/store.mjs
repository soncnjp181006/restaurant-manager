/**
 * PostgreSQL persistence for the data service.
 *
 * Storage model: every SurrealDB table maps to rows in a single `records`
 * table — (table_name, id, data jsonb). Record links ("table:id" strings),
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
 */

import { SRid, SDateTime, SDecimal, SUuid, SDuration, SNone, SSet, STagged } from './cbor.mjs';
import { DTMarker, evaluate, QueryError, NONE } from './eval.mjs';
import fs from 'node:fs';

const RID_PATH_RE = /^([A-Za-z_][A-Za-z0-9_]*):(.+)$/s;

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS records (
  table_name text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, id)
);
CREATE INDEX IF NOT EXISTS records_table_idx ON records (table_name);
CREATE TABLE IF NOT EXISTS field_kinds (
  table_name text NOT NULL,
  field text NOT NULL,
  kind text NOT NULL,
  PRIMARY KEY (table_name, field)
);
CREATE TABLE IF NOT EXISTS change_log (
  seq bigserial PRIMARY KEY,
  table_name text NOT NULL,
  record_id text NOT NULL,
  action text NOT NULL,
  data jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS change_log_table_idx ON change_log (table_name, seq);
CREATE TABLE IF NOT EXISTS unique_indexes (
  name text PRIMARY KEY,
  table_name text NOT NULL,
  fields jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS unique_indexes_table_idx ON unique_indexes (table_name);
CREATE TABLE IF NOT EXISTS field_defaults (
  table_name text NOT NULL,
  field text NOT NULL,
  expr jsonb NOT NULL,
  PRIMARY KEY (table_name, field)
);
CREATE TABLE IF NOT EXISTS event_defs (
  name text PRIMARY KEY,
  table_name text NOT NULL,
  when_ast jsonb,
  then_statements jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS event_defs_table_idx ON event_defs (table_name);
`;

const REMOVED = Symbol('field-removed');

/** Normalize an incoming wire value into the JSONB storage model. */
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

export class PgStore {
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
    const client = await this.pool.connect();
    try {
      await client.query(INIT_SQL);
    } finally {
      client.release();
    }
    await this.loadKinds();
  }

  kindsForTable(table) {
    return this.kindsCache.get(table) ?? new Map();
  }

  async loadKinds() {
    const { rows } = await this.pool.query('SELECT table_name, field, kind FROM field_kinds');
    for (const row of rows) {
      const key = row.table_name;
      if (!this.kindsCache.has(key)) this.kindsCache.set(key, new Map());
      this.kindsCache.get(key).set(row.field, row.kind);
    }
    const [{ rows: uq }, { rows: def }, { rows: evt }] = await Promise.all([
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
        `INSERT INTO field_kinds (table_name, field, kind) VALUES ($1, $2, $3)
         ON CONFLICT (table_name, field) DO UPDATE SET kind = EXCLUDED.kind`,
        [table, field, kind]
      );
      if (!this.kindsCache.has(table)) this.kindsCache.set(table, new Map());
      this.kindsCache.get(table).set(field, kind);
    }
  }

  // ---- metadata -----------------------------------------------------------

  async upsertUniqueIndex(client, { name, table, fields }) {
    await client.query(
      `INSERT INTO unique_indexes (name, table_name, fields) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (name) DO UPDATE SET table_name = EXCLUDED.table_name, fields = EXCLUDED.fields`,
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
      `INSERT INTO field_defaults (table_name, field, expr) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (table_name, field) DO UPDATE SET expr = EXCLUDED.expr`,
      [table, field, astToJson(ast)]
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
        `INSERT INTO event_defs (name, table_name, when_ast, then_statements) VALUES ($1, $2, $3::jsonb, $4::jsonb)
         ON CONFLICT (name) DO UPDATE SET table_name = EXCLUDED.table_name, when_ast = EXCLUDED.when_ast, then_statements = EXCLUDED.then_statements`,
        // NOTE: pg serializes JS arrays as Postgres array literals, not JSON —
        // then_statements is an array, so it must be passed as a JSON string.
        [name, table, whenAst ? JSON.stringify(astToJson(whenAst)) : null, JSON.stringify(astToJson(thenStatements))]
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
    await client.query('DELETE FROM unique_indexes WHERE name = $1', [name]);
    this.uniqueCache.set(table, (this.uniqueCache.get(table) ?? []).filter((x) => x.name !== name));
  }

  async removeFieldDefault(client, table, field) {
    await client.query('DELETE FROM field_defaults WHERE table_name = $1 AND field = $2', [table, field]);
    this.defaultsCache.set(table, (this.defaultsCache.get(table) ?? []).filter((x) => x.field !== field));
  }

  async removeEvent(client, name, table) {
    await client.query('DELETE FROM event_defs WHERE name = $1', [name]);
    this.eventsCache.set(table, (this.eventsCache.get(table) ?? []).filter((x) => x.name !== name));
  }

  // ---- reads --------------------------------------------------------------

  async listTables(client) {
    const { rows } = await client.query('SELECT DISTINCT table_name FROM records ORDER BY table_name');
    return rows.map((r) => r.table_name);
  }

  async countRecords(client, table) {
    const { rows } = await client.query('SELECT count(*)::int AS n FROM records WHERE table_name = $1', [table]);
    return rows[0].n;
  }

  async getRecords(client, table, ids) {
    if (ids.length === 0) return [];
    const { rows } = await client.query(
      'SELECT id, data FROM records WHERE table_name = $1 AND id = ANY($2)',
      [table, ids]
    );
    return rows;
  }

  async scanTable(client, table) {
    const { rows } = await client.query('SELECT id, data FROM records WHERE table_name = $1', [table]);
    return rows;
  }

  async scanTables(client, tables) {
    const { rows } = await client.query(
      'SELECT table_name, id, data FROM records WHERE table_name = ANY($1)',
      [tables]
    );
    return rows;
  }

  async getMaxSeq(client) {
    const { rows } = await client.query('SELECT COALESCE(max(seq), 0)::bigint AS max FROM change_log');
    return Number(rows[0].max);
  }

  async getChangesSince(client, table, sinceSeq, limit) {
    const { rows } = await client.query(
      'SELECT seq, table_name, record_id, action, data, at FROM change_log WHERE seq > $1 AND table_name = $2 ORDER BY seq ASC LIMIT $3',
      [sinceSeq, table, limit]
    );
    return rows;
  }

  async getAllChangesSince(client, sinceSeq, limit) {
    const { rows } = await client.query(
      'SELECT seq, table_name, record_id, action, data, at FROM change_log WHERE seq > $1 ORDER BY seq ASC LIMIT $2',
      [sinceSeq, limit]
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
        'INSERT INTO records (table_name, id, data) VALUES ($1, $2, $3::jsonb)',
        [table, id, JSON.stringify(finalData)]
      );
    } else {
      await client.query(
        'UPDATE records SET data = $3::jsonb, updated_at = now() WHERE table_name = $1 AND id = $2',
        [table, id, JSON.stringify(finalData)]
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
      const sql = `SELECT id FROM records WHERE table_name = $1 AND id <> $2 AND (${unique.fields
        .map((_, i) => `data->>$${i + 3} = $${i + 3 + unique.fields.length}`)
        .join(' AND ')}) LIMIT 1`;
      const params = [table, id, ...unique.fields, ...values];
      const { rows } = await client.query(sql, params);
      if (rows.length > 0) {
        throw new QueryError(
          `Unique index '${unique.name}' violated on table '${table}' (fields: ${unique.fields.join(', ')}) — existing record '${rows[0].id}'`,
          'unique'
        );
      }
    }
  }

  async appendChange(client, table, id, action, data) {
    const { rows } = await client.query(
      'INSERT INTO change_log (table_name, record_id, action, data) VALUES ($1, $2, $3, $4::jsonb) RETURNING seq',
      [table, id, action, data ? JSON.stringify(data) : null]
    );
    return Number(rows[0].seq);
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
      'UPDATE records SET data = $3::jsonb, updated_at = now() WHERE table_name = $1 AND id = $2',
      [table, id, JSON.stringify(after)]
    );
    await this.appendChange(client, table, id, 'UPDATE', after);
    await this.fireEvents(client, table, id, 'UPDATE', before, after, ctx, kinds, 0);
    return { action: 'UPDATE', before, after };
  }

  async deleteRecord(client, table, id, kinds, ctx = {}) {
    const existing = await this.getRecords(client, table, [id]);
    if (!existing[0]) return null;
    const before = existing[0].data;
    await client.query('DELETE FROM records WHERE table_name = $1 AND id = $2', [table, id]);
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
    let p = 1;
    for (const rec of records) {
      const normalized = normalizeIn(rec.data, table, '', kinds);
      values.push(table, rec.id, JSON.stringify(normalized));
      chunks.push(`($${p}, $${p + 1}, $${p + 2}::jsonb)`);
      p += 3;
    }
    if (chunks.length === 0) return 0;
    await client.query(
      `INSERT INTO records (table_name, id, data) VALUES ${chunks.join(', ')}
       ON CONFLICT (table_name, id) DO UPDATE SET data = EXCLUDED.data`,
      values
    );
    await this.persistKinds(client, kinds);
    return records.length;
  }
}

export { REMOVED, RID_PATH_RE };
