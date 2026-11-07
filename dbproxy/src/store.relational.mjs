/**
 * Relational MySQL persistence for the data service.
 *
 * Drop-in replacement for MySqlStore: the wire protocol and SurrealQL engine
 * are unchanged, but a record is no longer stored as one JSON blob. Each
 * business table is a real MySQL table (`id` = record key), array fields are
 * child tables (`<table>__<field>`) and nested/schemaless values go to a
 * typed key/value table (`<table>__attrs`). No column is JSON.
 *
 * The mapping is discovered from INFORMATION_SCHEMA at startup (columns, FK
 * targets, child tables), so the generated schema in migrations/relational/
 * stays the single source of truth for structure.
 *
 * Metadata tables (field_kinds, unique_indexes, field_defaults, event_defs,
 * change_log) keep their shape: they hold dbproxy's own bookkeeping and the
 * before/after images the sync protocol reads — not business records.
 */

import { MySqlStore, INIT_SQL, REMOVED, normalizeIn } from './store.mjs';
import { QueryError } from './eval.mjs';

const META_TABLES = new Set([
  'records',
  'field_kinds',
  'unique_indexes',
  'field_defaults',
  'event_defs',
  'change_log',
  'tracking_events',
]);

const ATTRIBUTES = 'attrs';

function qid(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function fit(name) {
  if (name.length <= 64) return name;
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${name.slice(0, 54)}_${h.toString(16).padStart(8, '0').slice(0, 8)}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function splitRef(value) {
  const m = String(value).match(/^([A-Za-z_][A-Za-z0-9_]*):(.+)$/s);
  return m ? { table: m[1], key: m[2] } : null;
}

function parsePath(path) {
  const tokens = [];
  let current = '';
  for (let i = 0; i < path.length; i += 1) {
    const ch = path[i];
    if (ch === '.') {
      if (current) tokens.push({ type: 'key', value: current });
      current = '';
    } else if (ch === '[') {
      if (current) tokens.push({ type: 'key', value: current });
      current = '';
      const end = path.indexOf(']', i);
      tokens.push({ type: 'index', value: Number(path.slice(i + 1, end)) });
      i = end;
    } else {
      current += ch;
    }
  }
  if (current) tokens.push({ type: 'key', value: current });
  return tokens;
}

function decodeAttrRows(rows, into) {
  for (const row of rows) {
    const tokens = parsePath(row.path);
    if (tokens.length === 0) continue;
    let value;
    if (row.kind === 'null') value = null;
    else if (row.kind === 'string') value = row.value_text;
    else if (row.kind === 'number') value = Number(row.value_number);
    else if (row.kind === 'boolean') value = Boolean(row.value_bool);
    else if (row.kind === 'array') value = [];
    else if (row.kind === 'object') value = {};
    else continue;

    let node = into;
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const token = tokens[i];
      const next = tokens[i + 1];
      if (node[token.value] === undefined) node[token.value] = next.type === 'index' ? [] : {};
      node = node[token.value];
    }
    node[tokens[tokens.length - 1].value] = value;
  }
  return into;
}

function encodeAttrValue(prefix, value, rows) {
  if (value === null || value === undefined) {
    rows.push([prefix, 'null', null, null, null]);
    return;
  }
  if (typeof value === 'string') {
    rows.push([prefix, 'string', value, null, null]);
    return;
  }
  if (typeof value === 'number') {
    rows.push([prefix, 'number', null, value, null]);
    return;
  }
  if (typeof value === 'boolean') {
    rows.push([prefix, 'boolean', null, null, value ? 1 : 0]);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push([prefix, 'array', null, null, null]);
      return;
    }
    value.forEach((item, i) => encodeAttrValue(`${prefix}[${i}]`, item, rows));
    return;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      rows.push([prefix, 'object', null, null, null]);
      return;
    }
    for (const key of keys) encodeAttrValue(prefix ? `${prefix}.${key}` : key, value[key], rows);
  }
}

export class RelationalStore extends MySqlStore {
  constructor(pool, logger = console) {
    super(pool, logger);
    this.schema = new Map(); // table -> {columns, refs, arrays, attrs}
    this.businessTables = new Set();
  }

  async init() {
    const client = await this.pool.getConnection();
    try {
      for (const ddl of INIT_SQL) {
        if (/CREATE TABLE IF NOT EXISTS records\b/.test(ddl)) continue;
        await client.query(ddl);
      }
      await this.loadSchema(client);
      // Create the key/value side table for every record table up front: DDL
      // inside a write transaction would implicitly commit and drop the
      // engine's SAVEPOINT, so nothing may be created lazily at write time.
      for (const table of this.businessTables) await this.ensureAttrs(client, table);
    } finally {
      client.release();
    }
    await this.loadKinds();
    this.deriveKinds();
  }

  async loadSchema(client) {
    const [columns] = await client.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS dtype, COLUMN_TYPE AS ctype
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME, ORDINAL_POSITION`
    );
    const [fks] = await client.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS ref
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`
    );
    const refByColumn = new Map(fks.map((row) => [`${row.t}\u0000${row.c}`, row.ref]));

    const byTable = new Map();
    for (const row of columns) {
      if (!byTable.has(row.t)) byTable.set(row.t, []);
      byTable.get(row.t).push(row);
    }

    this.schema.clear();
    this.businessTables.clear();

    // Parent tables: any non-metadata table with an `id` column.
    for (const [name, cols] of byTable) {
      if (META_TABLES.has(name)) continue;
      if (!cols.some((c) => c.c === 'id')) continue;
      const entry = { columns: [], refs: new Map(), arrays: new Map(), attrs: null };
      for (const col of cols) {
        if (col.c === 'id' || col.c === 'row_created_at' || col.c === 'row_updated_at') continue;
        const ref = refByColumn.get(`${name}\u0000${col.c}`) ?? null;
        entry.columns.push({
          name: col.c,
          dtype: col.dtype,
          ctype: col.ctype,
          ref,
          isBool: col.ctype === 'tinyint(1)',
          isDatetime: ['datetime', 'timestamp', 'date'].includes(col.dtype),
        });
        if (ref) entry.refs.set(col.c, ref);
      }
      this.schema.set(name, entry);
      this.businessTables.add(name);
    }

    // Child tables (`<parent>__<field>`), plus the free-form attrs table.
    for (const [name, cols] of byTable) {
      if (META_TABLES.has(name) || !name.includes('__')) continue;
      const parent = name.slice(0, name.indexOf('__'));
      const field = name.slice(name.indexOf('__') + 2);
      const parentEntry = this.schema.get(parent);
      if (!parentEntry) continue;
      const ref = refByColumn.get(`${name}\u0000ref_id`) ?? null;
      const has = (c) => cols.some((col) => col.c === c);
      if (field === ATTRIBUTES) {
        parentEntry.attrs = name;
        continue;
      }
      parentEntry.arrays.set(field, {
        table: name,
        field,
        kind: ref ? 'ref' : has('value_number') ? 'number' : has('value_bool') ? 'boolean' : 'string',
        ref,
      });
    }
  }

  /** Feed schema-derived wire kinds into the engine's re-hydration cache. */
  deriveKinds() {
    for (const [table, entry] of this.schema) {
      if (!this.kindsCache.has(table)) this.kindsCache.set(table, new Map());
      const kinds = this.kindsCache.get(table);
      for (const column of entry.columns) {
        if (column.ref) kinds.set(column.name, 'rid');
        if (column.isDatetime) kinds.set(column.name, 'datetime');
      }
    }
  }

  async ensureAttrs(client, table) {
    const entry = this.schema.get(table);
    if (!entry) return null;
    if (entry.attrs) return entry.attrs;
    const attrs = fit(`${table}__${ATTRIBUTES}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${qid(attrs)} (
         parent_id varchar(512) COLLATE utf8mb4_bin NOT NULL,
         path varchar(255) COLLATE utf8mb4_bin NOT NULL,
         kind varchar(16) COLLATE utf8mb4_bin NOT NULL,
         value_text longtext COLLATE utf8mb4_bin NULL,
         value_number double NULL,
         value_bool tinyint(1) NULL,
         PRIMARY KEY (parent_id, path),
         CONSTRAINT ${qid(fit(`${attrs}_parent_fk`))} FOREIGN KEY (parent_id)
           REFERENCES ${qid(table)} (id) ON DELETE CASCADE ON UPDATE CASCADE
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
    );
    entry.attrs = attrs;
    return attrs;
  }

  /** Write-time guard: never issue DDL (it would end the caller's transaction). */
  attrsFor(table) {
    const entry = this.schema.get(table);
    return entry?.attrs ?? null;
  }

  // ---- record encoding ----------------------------------------------------

  rowToData(table, row) {
    const entry = this.schema.get(table);
    const data = {};
    if (!entry) return data;
    for (const column of entry.columns) {
      const value = row[column.name];
      if (value === null || value === undefined) continue;
      if (column.ref) data[column.name] = `${column.ref}:${value}`;
      else if (column.isDatetime) data[column.name] = value instanceof Date ? value.toISOString() : String(value);
      else if (column.isBool) data[column.name] = Boolean(value);
      else data[column.name] = value;
    }
    return data;
  }

  async hydrate(client, table, rows) {
    const entry = this.schema.get(table);
    if (!entry || rows.length === 0) return rows.map((row) => ({ id: row.id, data: this.rowToData(table, row) }));
    const ids = rows.map((row) => row.id);
    const out = new Map(rows.map((row) => [row.id, { id: row.id, data: this.rowToData(table, row) }]));

    for (const array of entry.arrays.values()) {
      const [childRows] = await client.query(
        `SELECT * FROM ${qid(array.table)} WHERE parent_id IN (${ids.map(() => '?').join(', ')}) ORDER BY parent_id, ord`,
        ids
      );
      for (const child of childRows) {
        const target = out.get(child.parent_id);
        if (!target) continue;
        if (!Array.isArray(target.data[array.field])) target.data[array.field] = [];
        if (array.kind === 'ref') target.data[array.field].push(`${array.ref}:${child.ref_id}`);
        else if (array.kind === 'number') target.data[array.field].push(Number(child.value_number));
        else if (array.kind === 'boolean') target.data[array.field].push(Boolean(child.value_bool));
        else target.data[array.field].push(child.value_text);
      }
    }

    if (entry.attrs) {
      const [attrRows] = await client.query(
        `SELECT * FROM ${qid(entry.attrs)} WHERE parent_id IN (${ids.map(() => '?').join(', ')})`,
        ids
      );
      for (const target of out.values()) decodeAttrRows(attrRows.filter((r) => r.parent_id === target.id), target.data);
    }

    return rows.map((row) => out.get(row.id));
  }

  async saveRecord(client, table, id, data) {
    const entry = this.schema.get(table);
    if (!entry) throw new QueryError(`Unknown table '${table}' in relational layout`, 'table');

    const columns = [];
    const values = [];
    const arrays = new Map();
    const attrs = [];

    for (const [key, value] of Object.entries(data)) {
      if (value === REMOVED) continue;
      const column = entry.columns.find((c) => c.name === key);
      if (column) {
        columns.push(column);
        if (value === null || value === undefined) values.push(null);
        else if (column.ref) values.push(splitRef(value)?.key ?? value);
        else if (column.isDatetime) values.push(new Date(value));
        else if (column.isBool) values.push(value ? 1 : 0);
        else values.push(value);
        continue;
      }
      const array = entry.arrays.get(key);
      if (array && Array.isArray(value)) {
        arrays.set(key, value);
        continue;
      }
      if (value === null || typeof value === 'object') {
        encodeAttrValue(key, value, attrs);
        continue;
      }
      // A scalar the generated schema does not know (new field from a client).
      if (this.attrsFor(table)) encodeAttrValue(key, value, attrs);
    }

    const insertColumns = ['id', ...columns.map((c) => c.name)];
    const insertValues = [id, ...values];
    // Always an upsert: a record whose only values live in `__attrs` would
    // otherwise hit a duplicate primary key on UPDATE.
    const updates = [
      '`row_updated_at` = CURRENT_TIMESTAMP(3)',
      ...columns.map((c) => `${qid(c.name)} = VALUES(${qid(c.name)})`),
    ].join(', ');
    await client.query(
      `INSERT INTO ${qid(table)} (${insertColumns.map(qid).join(', ')}) VALUES (?)` +
        ` ON DUPLICATE KEY UPDATE ${updates}`,
      [insertValues]
    );

    for (const [field, value] of arrays) {
      const array = entry.arrays.get(field);
      await client.query(`DELETE FROM ${qid(array.table)} WHERE parent_id = ?`, [id]);
      if (value.length === 0) continue;
      const valueColumn =
        array.kind === 'ref'
          ? 'ref_id'
          : array.kind === 'number'
            ? 'value_number'
            : array.kind === 'boolean'
              ? 'value_bool'
              : 'value_text';
      const rows = value.map((item, ord) => {
        let stored = item;
        if (array.kind === 'ref') stored = splitRef(item)?.key ?? item;
        else if (array.kind === 'number') stored = Number(item);
        else if (array.kind === 'boolean') stored = item ? 1 : 0;
        return [id, ord, stored];
      });
      await client.query(
        `INSERT INTO ${qid(array.table)} (parent_id, ord, ${qid(valueColumn)}) VALUES ?`,
        [rows]
      );
    }

    if (attrs.length > 0 && this.attrsFor(table)) {
      const attrsTable = this.attrsFor(table);
      await client.query(`DELETE FROM ${qid(attrsTable)} WHERE parent_id = ?`, [id]);
      await client.query(
        `INSERT INTO ${qid(attrsTable)} (parent_id, path, kind, value_text, value_number, value_bool) VALUES ?`,
        [attrs.map((row) => [id, ...row])]
      );
    } else if (entry.attrs) {
      await client.query(`DELETE FROM ${qid(entry.attrs)} WHERE parent_id = ?`, [id]);
    }
  }

  // ---- reads --------------------------------------------------------------

  async listTables() {
    return [...this.businessTables].sort();
  }

  async countRecords(client, table) {
    if (!this.schema.has(table)) return 0;
    const [rows] = await client.query(`SELECT COUNT(*) AS n FROM ${qid(table)}`);
    return Number(rows[0].n);
  }

  async getRecords(client, table, ids) {
    if (ids.length === 0 || !this.schema.has(table)) return [];
    const [rows] = await client.query(
      `SELECT * FROM ${qid(table)} WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ids
    );
    return this.hydrate(client, table, rows);
  }

  async scanTable(client, table) {
    if (!this.schema.has(table)) return [];
    const [rows] = await client.query(`SELECT * FROM ${qid(table)}`);
    return this.hydrate(client, table, rows);
  }

  async scanTables(client, tables) {
    const out = [];
    for (const table of tables) {
      if (!this.schema.has(table)) continue;
      const [rows] = await client.query(`SELECT * FROM ${qid(table)}`);
      out.push(...(await this.hydrate(client, table, rows)));
    }
    return out;
  }

  // ---- writes -------------------------------------------------------------

  async writeRecord(client, table, id, rawData, kinds, ctx = {}) {
    const data = normalizeIn(rawData, table, '', kinds);
    const existing = await this.getRecords(client, table, [id]);
    const before = existing[0]?.data ?? null;
    const isCreate = !existing[0];

    let finalData = data;
    if (isCreate) finalData = await this.applyDefaults(client, table, data);

    await this.enforceUnique(client, table, id, finalData);
    await this.persistKinds(client, kinds);
    await this.saveRecord(client, table, id, finalData);

    const action = isCreate ? 'CREATE' : 'UPDATE';
    await this.appendChange(client, table, id, action, finalData);
    if (process.env.DB_DISABLE_EVENTS !== '1') {
      await this.fireEvents(client, table, id, action, before, finalData, ctx, kinds, 0);
    }
    return { action, before, after: finalData };
  }

  async updateRecord(client, table, id, transform, kinds, ctx = {}) {
    const existing = await this.getRecords(client, table, [id]);
    if (!existing[0]) return null;
    const before = existing[0].data;
    const after = transform(before);
    if (after === null) return this.deleteRecord(client, table, id, kinds, ctx);
    await this.enforceUnique(client, table, id, after);
    await this.persistKinds(client, kinds);
    await this.saveRecord(client, table, id, after);
    await this.appendChange(client, table, id, 'UPDATE', after);
    await this.fireEvents(client, table, id, 'UPDATE', before, after, ctx, kinds, 0);
    return { action: 'UPDATE', before, after };
  }

  async deleteRecord(client, table, id, kinds, ctx = {}) {
    const existing = await this.getRecords(client, table, [id]);
    if (!existing[0]) return null;
    const before = existing[0].data;
    await client.query(`DELETE FROM ${qid(table)} WHERE id = ?`, [id]);
    await this.appendChange(client, table, id, 'DELETE', before);
    await this.fireEvents(client, table, id, 'DELETE', before, undefined, ctx, kinds, 0);
    return { action: 'DELETE', before };
  }

  async bulkImport(client, table, records) {
    const kinds = new Map();
    for (const record of records) {
      const normalized = normalizeIn(record.data, table, '', kinds);
      await this.saveRecord(client, table, record.id, normalized);
    }
    await this.persistKinds(client, kinds);
    return records.length;
  }

  /** UNIQUE checks against real columns (skipped for non-column fields). */
  async enforceUnique(client, table, id, data) {
    const uniques = this.uniqueCache.get(table) ?? [];
    const entry = this.schema.get(table);
    if (!entry) return;
    for (const unique of uniques) {
      const values = unique.fields.map((f) => data[f]);
      if (values.some((v) => v === undefined || v === null)) continue;
      const columns = unique.fields.map((f) => entry.columns.find((c) => c.name === f));
      if (columns.some((c) => !c)) continue;
      const sql =
        `SELECT id FROM ${qid(table)} WHERE id <> ? AND ` +
        columns.map((c) => `${qid(c.name)} = ?`).join(' AND ') +
        ' LIMIT 1';
      const params = [
        id,
        ...columns.map((c) => {
          const v = data[c.name];
          if (c.ref) return splitRef(v)?.key ?? v;
          if (c.isBool) return v ? 1 : 0;
          if (c.isDatetime) return new Date(v);
          return v;
        }),
      ];
      const [rows] = await client.query(sql, params);
      if (rows.length > 0) {
        throw new QueryError(
          `Unique index '${unique.name}' violated on table '${table}' (fields: ${unique.fields.join(', ')}) — existing record '${rows[0].id}'`,
          'unique'
        );
      }
    }
  }
}
