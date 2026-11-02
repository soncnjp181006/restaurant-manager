/**
 * Statement executor: runs parsed SurrealQL ASTs against the PostgreSQL
 * store, reproducing SurrealDB result semantics (arrays of records, ONLY
 * singular results, FETCH hydration, GROUP/ORDER/SPLIT, LIVE SELECT uuids).
 */

import crypto from 'node:crypto';
import { SRid, SDateTime, SDecimal, SUuid, SDuration, STagged } from './cbor.mjs';
import { evaluate, isAggregateCall, QueryError, DTMarker, TableMarker, compareValues, getPath, looksLikeIsoDate } from './eval.mjs';
import { normalizeIn, REMOVED, RID_PATH_RE } from './store.mjs';

const RECORD_SYM = Symbol('surreal-record');

const AGG_NAMES = new Set(['math::sum', 'math::max', 'math::min', 'math::mean', 'math::average', 'math::median']);

function newRecordId() {
  // SurrealDB-style 20-char lowercase alphanumeric id
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < 20; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function resolveTarget(target, params) {
  if (!target) throw new QueryError('Missing target');
  switch (target.t) {
    case 'table':
      return { table: target.name, id: null };
    case 'rid':
      return { table: target.table, id: target.id };
    case 'param': {
      const v = params[target.name];
      if (v === undefined || v === null) throw new QueryError(`Parameter $${target.name} is not set`);
      if (v instanceof TableMarker) return { table: v.name, id: null };
      if (typeof v === 'string') {
        // The SDK sends table names as plain strings and record ids as
        // "table:id" strings — distinguish by shape.
        if (v.includes(':')) {
          const m = v.match(RID_PATH_RE);
          if (!m) throw new QueryError(`Parameter $${target.name} is not a record id: ${v}`);
          return { table: m[1], id: m[2] };
        }
        return { table: v, id: null };
      }
      if (v && typeof v === 'object' && v.table && v.id) return { table: String(v.table), id: String(v.id) };
      throw new QueryError(`Cannot resolve parameter $${target.name} as a record target`);
    }
    case 'func': {
      if (target.name === 'type::record') {
        const args = target.args.map((a) => (a.t === 'param' ? params[a.name] : a.t === 'lit' ? a.v : evaluate(a, {}, params, {})));
        if (args.length >= 2) {
          const table = String(args[0]);
          let id = String(args[1]);
          // Accept both bare ids and fully-qualified 'table:id' strings.
          if (id.startsWith(`${table}:`)) id = id.slice(table.length + 1);
          return { table, id };
        }
        const v = args[0];
        if (v === undefined || v === null) throw new QueryError('type::record received no id');
        if (typeof v === 'string') {
          const m = v.match(RID_PATH_RE);
          if (!m) throw new QueryError(`Invalid record id: ${v}`);
          return { table: m[1], id: m[2] };
        }
        if (v && typeof v === 'object' && v.table && v.id) return { table: String(v.table), id: String(v.id) };
        throw new QueryError('type::record: unsupported argument');
      }
      if (target.name === 'type::table') {
        const arg = target.args[0];
        const v = arg.t === 'param' ? params[arg.name] : arg.t === 'lit' ? arg.v : evaluate(arg, {}, params, {});
        if (typeof v !== 'string') throw new QueryError('type::table expects a table name');
        return { table: v, id: null };
      }
      throw new QueryError(`Unsupported target function '${target.name}'`);
    }
    case 'uuidlit':
      throw new QueryError('UUID literals cannot be used as record targets');
    default:
      throw new QueryError(`Unsupported target '${target.t}'`);
  }
}

/** Build the internal row shape {id: 'table:id', ...data} */
function toRow(table, id, data) {
  return { id: `${table}:${id}`, ...data, [RECORD_SYM]: { table, id } };
}

function rowParts(row) {
  const meta = row[RECORD_SYM] ?? null;
  const data = {};
  for (const [k, v] of Object.entries(row)) {
    if (k !== 'id' && k !== RECORD_SYM) data[k] = v;
  }
  return { meta, data };
}

// ---------------------------------------------------------------------------
// Encoding internal rows to wire values
// ---------------------------------------------------------------------------

function encodeValueForWire(value, table, path, kindsFor) {
  if (value === undefined) return undefined;
  if (value instanceof SRid || value instanceof SDateTime || value instanceof SDecimal || value instanceof SUuid || value instanceof SDuration || value instanceof STagged) {
    return value;
  }
  if (value instanceof DTMarker) return new SDateTime(value.iso);
  if (value instanceof TableMarker) return { __table_marker: value.name };
  if (value === null || typeof value !== 'object') {
    // Re-hydrate stored strings into their wire types using learned field kinds
    if (typeof value === 'string' && path) {
      const kind = kindsFor?.(table)?.get?.(path);
      if (kind === 'rid' && RID_PATH_RE.test(value)) {
        const m = value.match(RID_PATH_RE);
        return new SRid(m[1], m[2]);
      }
      if (kind === 'datetime' && looksLikeIsoDate(value)) return new SDateTime(value);
      if (kind === 'decimal') return new SDecimal(value);
      if (kind === 'uuid' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return new SUuid(value);
      if (kind === 'duration') return new SDuration(value);
      if (kind && kind.startsWith('tag:')) return new STagged(Number(kind.slice(4)), value);
    }
    return value;
  }
  if (value[RECORD_SYM]) {
    const meta = value[RECORD_SYM];
    const out = { id: new SRid(meta.table, meta.id) };
    for (const [k, v] of Object.entries(value)) {
      if (k === RECORD_SYM || k === 'id') continue;
      const enc = encodeValueForWire(v, meta.table, k, kindsFor);
      if (enc !== undefined) out[k] = enc;
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => encodeValueForWire(item, table, path, kindsFor)).filter((v) => v !== undefined);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const enc = encodeValueForWire(v, table, path ? `${path}.${k}` : k, kindsFor);
    if (enc !== undefined) out[k] = enc;
  }
  return out;
}

/**
 * Convert an internal row into the SDK-expected record object:
 * id becomes a RecordId; learned-kind fields are re-typed.
 */
export function encodeRow(row, kindsFor) {
  const { meta, data } = rowParts(row);
  const table = meta?.table ?? String(row.id).split(':')[0];
  const out = { id: new SRid(table, meta?.id ?? String(row.id).split(':').slice(1).join(':')) };
  for (const [k, v] of Object.entries(data)) {
    const enc = encodeValueForWire(v, table, k, kindsFor);
    if (enc !== undefined) out[k] = enc;
  }
  return out;
}

/**
 * Encode any statement result for the wire: internal rows become SDK record
 * objects, plain projection objects get datetime markers resolved, scalars
 * pass through.
 */
export function encodeResult(value, kindsFor = () => new Map()) {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) {
    const mapped = value.map((item) => encodeResult(item, kindsFor));
    return mapped.filter((v) => v !== undefined);
  }
  if (value instanceof DTMarker) return new SDateTime(value.iso);
  if (value && typeof value === 'object' && value[RECORD_SYM]) {
    return encodeRow(value, kindsFor);
  }
  if (value instanceof SRid || value instanceof SDateTime || value instanceof SDecimal || value instanceof SUuid || value instanceof SDuration || value instanceof STagged) {
    return value;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const enc = encodeResult(v, kindsFor);
      if (enc !== undefined) out[k] = enc;
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class Engine {
  constructor(store, options = {}) {
    this.store = store;
    this.logger = options.logger ?? console;
    this.liveRegistry = options.liveRegistry ?? null; // set by rpc layer
  }

  kindsForTable(table) {
    return this.store.kindsCache.get(table) ?? new Map();
  }

  /**
   * Execute a single parsed statement inside the caller's transaction.
   * Returns the raw result value (pre-wire-encoding) plus a flag describing
   * the result shape so the rpc layer can encode.
   */
  async execute(stmt, session, client, params) {
    switch (stmt.kind) {
      case 'select':
        return this.executeSelect(stmt, session, client, params);
      case 'create':
      case 'upsert':
        return this.executeCreate(stmt, session, client, params);
      case 'insert':
        return this.executeInsert(stmt, session, client, params);
      case 'update':
        return this.executeUpdate(stmt, session, client, params);
      case 'delete':
        return this.executeDelete(stmt, session, client, params);
      case 'relate':
        return this.executeRelate(stmt, session, client, params);
      case 'live':
        return this.executeLive(stmt, session, params);
      case 'kill':
        return this.executeKill(stmt, params);
      case 'define':
        return this.executeDefine(stmt, client);
      case 'remove':
        return this.executeRemove(stmt, client);
      case 'info':
        return this.executeInfo(stmt, client);
      case 'show_changes':
        return this.executeShowChanges(stmt, client, params);
      case 'return':
        return stmt.expr ? evaluate(stmt.expr, null, params, {}) : null;
      case 'use':
        return null;
      case 'let':
        session.variables.set(stmt.name, evaluate(stmt.expr, null, params, {}));
        return null;
      case 'sleep':
        await new Promise((resolve) => setTimeout(resolve, Math.min(stmt.ms, 10_000)));
        return null;
      case 'throw':
        throw new QueryError(String(evaluate(stmt.expr, null, params, {}) ?? 'Thrown error'));
      case 'alter':
        return null;
      default:
        throw new QueryError(`Unsupported statement kind '${stmt.kind}'`);
    }
  }

  // ---- SELECT --------------------------------------------------------------

  async executeSelect(stmt, session, client, params) {
    // Resolve FROM targets into table/id pairs
    const targets = [];
    for (const target of stmt.from) {
      const resolved = resolveTarget(target, params);
      targets.push(resolved);
    }

    // WHERE id pushdown: collect id conditions from a pure AND chain
    const idConditions = extractIdConditions(stmt.where, params);
    let candidateRows = [];
    for (const { table, id } of targets) {
      if (id) {
        const rows = await this.store.getRecords(client, table, [id]);
        for (const r of rows) candidateRows.push(toRow(table, r.id, r.data));
      } else if (idConditions) {
        const ids = idConditions.get(table);
        if (ids && ids.size > 0) {
          const rows = await this.store.getRecords(client, table, [...ids]);
          for (const r of rows) candidateRows.push(toRow(table, r.id, r.data));
        } else if (ids && ids.size === 0) {
          // IN an empty list → no rows for this table
        } else {
          const rows = await this.store.scanTable(client, table);
          for (const r of rows) candidateRows.push(toRow(table, r.id, r.data));
        }
      } else {
        const rows = await this.store.scanTable(client, table);
        for (const r of rows) candidateRows.push(toRow(table, r.id, r.data));
      }
    }

    // WHERE
    let rows = candidateRows;
    if (stmt.where) {
      rows = rows.filter((row) => {
        try {
          const v = evaluate(stmt.where, row, params, {});
          return v === true || (v !== undefined && v !== null && v !== false);
        } catch (err) {
          if (err instanceof QueryError && /not supported/i.test(err.message)) throw err;
          throw err;
        }
      });
    }

    // SPLIT
    if (stmt.split && stmt.split.length > 0) {
      rows = applySplit(rows, stmt.split);
    }

    // GROUP / aggregates / projection
    const hasAggregates = stmt.fields.some((f) => isAggregateField(f)) || (stmt.value?.mode === 'value' && false);
    const grouped = stmt.group || hasAggregates;
    let projected;
    if (grouped) {
      projected = applyGrouping(rows, stmt, params);
    } else if (stmt.value) {
      projected = applyValueProjection(rows, stmt.value, params);
    } else {
      projected = applyFieldProjection(rows, stmt.fields, params);
    }

    // ORDER BY
    if (stmt.order && stmt.order.length > 0) {
      projected = applyOrderBy(projected, stmt.order, params);
    }

    // START / LIMIT
    if (stmt.start !== undefined) {
      const start = Number(evaluate(stmt.start, null, params, {}));
      projected = projected.slice(Number.isFinite(start) ? Math.max(0, start) : 0);
    }
    if (stmt.limit !== undefined) {
      const limit = Number(evaluate(stmt.limit, null, params, {}));
      if (Number.isFinite(limit) && limit >= 0) projected = projected.slice(0, limit);
    }

    // FETCH
    if (stmt.fetch && stmt.fetch.length > 0) {
      await this.applyFetch(projected, stmt.fetch, client, params);
    }

    // ONLY
    if (stmt.only) {
      if (projected.length > 1) {
        throw new QueryError('Expected just one result, but got multiple');
      }
      return projected[0] ?? null;
    }
    return projected;
  }

  // ---- writes ---------------------------------------------------------------

  async executeCreate(stmt, session, client, params) {
    const { table, id } = resolveTarget(stmt.target, params);
    const recordId = id ?? newRecordId();

    const existingRows = await this.store.getRecords(client, table, [recordId]);
    if (stmt.kind === 'create' && existingRows.length > 0) {
      throw new QueryError(`Record '${table}:${recordId}' already exists`);
    }
    const before = existingRows[0]?.data ?? null;

    const kinds = new Map();
    const next = await this.computeWriteData(stmt, before, params, table, kinds);
    const result = await this.store.writeRecord(client, table, recordId, next, kinds, { auth: session.auth });
    const row = toRow(table, recordId, result.after);
    const out = [this.applyReturn(stmt.return, row, { after: row }, params)];
    return stmt.only ? out[0] : out;
  }

  async computeWriteData(stmt, before, params, table, kinds) {
    if (stmt.content) {
      const content = evaluate(stmt.content, before ? toRow(table, '', before) : null, params, {});
      return content ?? {};
    }
    let data = before ? { ...before } : {};
    if (stmt.merge) {
      const patch = evaluate(stmt.merge, before ? toRow(table, '', before) : null, params, {});
      const normalized = normalizeForWrite(patch, table, kinds);
      data = this.store.mergeData(data, normalized);
    }
    if (stmt.patch) {
      const ops = evaluate(stmt.patch, null, params, {});
      data = applyJsonPatch(data, Array.isArray(ops) ? ops : [ops]);
    }
    if (stmt.set) {
      for (const [path, expr] of stmt.set) {
        const value = normalizeForWrite(evaluate(expr, data ? toRow(table, '', data) : null, params, {}), table, kinds, path);
        setPathValue(data, path.parts, value === REMOVED ? undefined : value);
      }
    }
    if (stmt.unset) {
      for (const path of stmt.unset) {
        setPathValue(data, path.parts, undefined);
      }
    }
    return data;
  }

  async executeInsert(stmt, session, client, params) {
    const { table } = resolveTarget(stmt.into, params);
    let objects = [];
    if (stmt.values.mode === 'objs') {
      objects = stmt.values.objs.map((o) => evaluate(o, null, params, {})).filter(Boolean);
    } else {
      const v = evaluate(stmt.values.expr, null, params, {});
      if (Array.isArray(v)) objects = v;
      else if (v && typeof v === 'object') objects = [v];
    }
    const out = [];
    for (const raw of objects) {
      if (!raw || typeof raw !== 'object') continue;
      let recordId = null;
      let data = raw;
      if (typeof raw.id === 'string' && RID_PATH_RE.test(raw.id)) {
        recordId = raw.id.split(':').slice(1).join(':');
      }
      const kinds = new Map();
      const normalized = normalizeForWrite({ ...data }, table, kinds);
      if (recordId) {
        const existing = await this.store.getRecords(client, table, [recordId]);
        if (existing[0]) {
          if (stmt.ignore) continue;
          if (stmt.onDuplicate) {
            const before = existing[0].data;
            let next = { ...before };
            for (const [path, expr] of stmt.onDuplicate) {
              const value = normalizeForWrite(evaluate(expr, toRow(table, recordId, before), { ...params, excluded: raw }, {}), table, kinds, path);
              setPathValue(next, path.parts, value === REMOVED ? undefined : value);
            }
            await this.store.updateRecord(client, table, recordId, () => next, kinds, { auth: session.auth });
            out.push(toRow(table, recordId, next));
            continue;
          }
          throw new QueryError(`Record '${table}:${recordId}' already exists`);
        }
      }
      const finalId = recordId ?? newRecordId();
      await this.store.writeRecord(client, table, finalId, normalized, kinds, { auth: session.auth });
      const stored = await this.store.getRecords(client, table, [finalId]);
      out.push(toRow(table, finalId, stored[0].data));
    }
    return stmt.only ? out[0] ?? null : out;
  }

  async executeUpdate(stmt, session, client, params) {
    const matched = [];
    for (const target of stmt.targets) {
      const { table, id } = resolveTarget(target, params);
      if (id) {
        const rows = await this.store.getRecords(client, table, [id]);
        for (const r of rows) matched.push({ table, id: r.id, data: r.data });
      } else {
        const rows = await this.store.scanTable(client, table);
        for (const r of rows) matched.push({ table, id: r.id, data: r.data });
      }
    }
    let filtered = matched;
    if (stmt.where) {
      filtered = matched.filter(({ table, id, data }) => {
        const row = toRow(table, id, data);
        const v = evaluate(stmt.where, row, params, {});
        return v === true || (v !== undefined && v !== null && v !== false);
      });
    }
    const out = [];
    for (const { table, id, data } of filtered) {
      const kinds = new Map();
      const beforeRow = toRow(table, id, data);
      const next = await this.computeWriteData(stmt, data, params, table, kinds);
      const result = await this.store.updateRecord(client, table, id, () => next, kinds, { auth: session.auth });
      if (!result) continue;
      const row = toRow(table, id, result.after);
      out.push(this.applyReturn(stmt.return, row, { before: beforeRow, after: row }, params));
    }
    return stmt.only ? out[0] ?? null : out;
  }

  async executeDelete(stmt, session, client, params) {
    const matched = [];
    for (const target of stmt.targets) {
      const { table, id } = resolveTarget(target, params);
      if (id) {
        const rows = await this.store.getRecords(client, table, [id]);
        for (const r of rows) matched.push({ table, id: r.id, data: r.data });
      } else {
        const rows = await this.store.scanTable(client, table);
        for (const r of rows) matched.push({ table, id: r.id, data: r.data });
      }
    }
    let filtered = matched;
    if (stmt.where) {
      filtered = matched.filter(({ table, id, data }) => {
        const row = toRow(table, id, data);
        const v = evaluate(stmt.where, row, params, {});
        return v === true || (v !== undefined && v !== null && v !== false);
      });
    }
    const out = [];
    for (const { table, id, data } of filtered) {
      const kinds = new Map();
      const result = await this.store.deleteRecord(client, table, id, kinds, { auth: session.auth });
      if (!result) continue;
      const row = toRow(table, id, result.before);
      out.push(this.applyReturn(stmt.return, row, { before: row, after: null }, params));
    }
    return stmt.only ? out[0] ?? null : out;
  }

  async executeRelate(stmt, session, client, params) {
    const from = resolveTarget(stmt.from, params);
    const to = resolveTarget(stmt.to, params);
    if (!from.id || !to.id) throw new QueryError('RELATE requires concrete record ids on both sides');
    const table = stmt.edge;

    const kinds = new Map();
    let data = { in: `${from.table}:${from.id}`, out: `${to.table}:${to.id}` };

    if (stmt.unique) {
      const existing = await this.store.scanTable(client, table);
      const dup = existing.find((r) => r.data.in === data.in && r.data.out === data.out);
      if (dup) {
        const row = toRow(table, dup.id, dup.data);
        return stmt.only ? row : [row];
      }
    }

    if (stmt.content) {
      const content = evaluate(stmt.content, null, params, {});
      data = { ...data, ...(content ?? {}) };
    } else if (stmt.set) {
      for (const [path, expr] of stmt.set) {
        const value = normalizeForWrite(evaluate(expr, null, params, {}), table, kinds, path);
        setPathValue(data, path.parts, value === REMOVED ? undefined : value);
      }
    }
    const edgeId = newRecordId();
    await this.store.writeRecord(client, table, edgeId, data, kinds, { auth: session.auth });
    const stored = await this.store.getRecords(client, table, [edgeId]);
    const row = toRow(table, edgeId, stored[0].data);
    return stmt.only ? row : [row];
  }

  applyReturn(returnClause, row, context, params) {
    if (!returnClause) return row;
    if (returnClause.mode === 'none') return null;
    if (returnClause.mode === 'diff') return row;
    const scope = { ...row };
    return returnClause.exprs.map((expr) => evaluate(expr, scope, { ...params, ...context }, {}));
  }

  // ---- live -----------------------------------------------------------------

  async executeLive(stmt, session, params) {
    if (!this.liveRegistry) throw new QueryError('Live queries are not available');
    const targets = stmt.from.map((t) => resolveTarget(t, params ?? {}));
    const table = targets[0]?.table;
    if (!table) throw new QueryError('LIVE SELECT requires a table');
    // Registration happens in the rpc layer (it owns the socket sender).
    const uuid = crypto.randomUUID();
    return [new SUuid(uuid)];
  }

  async executeKill(stmt, params) {
    const id = evaluate(stmt.id, null, params, {});
    if (this.liveRegistry) this.liveRegistry.kill(String(id));
    return null;
  }

  // ---- define / remove / info ------------------------------------------------

  async executeDefine(stmt, client) {
    switch (stmt.what) {
      case 'table':
        return null;
      case 'field':
        if (stmt.default) {
          await this.store.upsertFieldDefault(client, { table: stmt.table, field: stmt.name, ast: stmt.default });
        }
        return null;
      case 'index':
        if (stmt.unique) {
          await this.store.upsertUniqueIndex(client, { name: stmt.name, table: stmt.table, fields: stmt.fields });
        }
        return null;
      case 'event':
        await this.store.upsertEvent(client, {
          name: stmt.name,
          table: stmt.table,
          whenAst: stmt.when ?? null,
          thenStatements: stmt.then ?? [],
        });
        return null;
      default:
        return null;
    }
  }

  async executeRemove(stmt, client) {
    if (stmt.what === 'table') {
      const rows = await this.store.scanTable(client, stmt.name);
      for (const row of rows) {
        await this.store.deleteRecord(client, stmt.name, row.id, new Map(), {});
      }
      return null;
    }
    if (stmt.what === 'index') {
      await this.store.removeUniqueIndex(client, stmt.name, stmt.table ?? '');
      return null;
    }
    if (stmt.what === 'field') {
      await this.store.removeFieldDefault(client, stmt.table ?? '', stmt.name);
      return null;
    }
    if (stmt.what === 'event') {
      await this.store.removeEvent(client, stmt.name, stmt.table ?? '');
      return null;
    }
    return null;
  }

  async executeInfo(stmt, client) {
    if (stmt.scope === 'db') {
      const tables = await this.store.listTables(client);
      const tableInfo = {};
      for (const t of tables) {
        tableInfo[t] = { name: t };
      }
      return {
        namespace: 'restaurant_manager',
        database: 'restaurant_manager',
        tables: tableInfo,
        users: {},
        accesses: {},
        analyzers: {},
        functions: {},
        params: {},
        models: {},
      };
    }
    if (stmt.scope === 'table') {
      const count = await this.store.countRecords(client, stmt.name);
      return { name: stmt.name, count };
    }
    return {};
  }

  async executeShowChanges(stmt, client, params) {
    const since = stmt.since ? Number(evaluate(stmt.since, null, params, {})) || 0 : 0;
    const limit = stmt.limit ? Number(evaluate(stmt.limit, null, params, {})) || 1000 : 1000;
    const changes = await this.store.getChangesSince(client, stmt.table, since, limit);
    // SurrealDB changefeed shape: one row per versionstamp with `changes`.
    // Non-delete mutations carry the full after-image under `update` (with the
    // record id embedded, as the sync-service helpers expect); deletes carry
    // `{ delete: { id } }`.
    return changes.map((c) => ({
      versionstamp: String(c.seq).padStart(20, '0'),
      changes: [
        c.action === 'DELETE'
          ? {
              key: [c.table_name, c.record_id],
              delete: { id: `${c.table_name}:${c.record_id}` },
            }
          : {
              key: [c.table_name, c.record_id],
              update: { ...(c.data ?? {}), id: `${c.table_name}:${c.record_id}` },
            },
      ],
    }));
  }

  // ---- FETCH ------------------------------------------------------------------

  async applyFetch(rows, fetchPaths, client, params) {
    for (const path of fetchPaths) {
      await this.hydratePath(rows, path.parts, client, 0);
    }
  }

  async hydratePath(rows, parts, client, depth) {
    if (parts.length === 0 || depth > 6) return;
    const locations = collectFieldLocations(rows, parts);
    if (locations.length === 0) return;

    // Gather link targets
    const targetsByTable = new Map();
    for (const loc of locations) {
      const value = loc.obj?.[loc.field];
      for (const v of Array.isArray(value) ? value : [value]) {
        if (typeof v === 'string') {
          const m = v.match(RID_PATH_RE);
          if (m) {
            if (!targetsByTable.has(m[1])) targetsByTable.set(m[1], new Set());
            targetsByTable.get(m[1]).add(m[2]);
          }
        }
      }
    }
    if (targetsByTable.size === 0) return;

    const recordsById = new Map();
    for (const [table, ids] of targetsByTable) {
      const dbRows = await this.store.getRecords(client, table, [...ids]);
      for (const r of dbRows) {
        recordsById.set(`${table}:${r.id}`, toRow(table, r.id, r.data));
      }
    }

    const hydratedRows = [];
    for (const loc of locations) {
      const value = loc.obj?.[loc.field];
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        const hydrated = value
          .map((v) => {
            if (typeof v === 'string' && recordsById.has(v)) {
              const rec = recordsById.get(v);
              hydratedRows.push(rec);
              return rec;
            }
            return v;
          })
          .filter((v) => typeof v !== 'string' || !RID_PATH_RE.test(v) || recordsById.has(v));
        // SurrealDB: FETCH of a missing record sets the field to NONE
        loc.obj[loc.field] = hydrated.length > 0 ? hydrated : undefined;
        if (hydrated.length === 0) delete loc.obj[loc.field];
      } else if (typeof value === 'string' && recordsById.has(value)) {
        const rec = recordsById.get(value);
        hydratedRows.push(rec);
        loc.obj[loc.field] = rec;
      } else if (typeof value === 'string' && RID_PATH_RE.test(value)) {
        delete loc.obj[loc.field];
      }
    }

    // Deeper paths: hydrate the remaining segments inside the freshly
    // hydrated records (supports FETCH a.b.c).
    if (parts.length > 1) {
      await this.hydratePath(hydratedRows, parts.slice(1), client, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Projection / grouping / ordering helpers
// ---------------------------------------------------------------------------

function isAggregateField(field) {
  if (field.t === 'count') return true;
  if (field.t === 'alias') return isAggregateCall(field.expr);
  return isAggregateCall(field);
}

function applyValueProjection(rows, valueSpec, params) {
  if (valueSpec.mode === 'diff') return rows;
  const out = [];
  for (const row of rows) {
    const field = valueSpec.fields[0];
    const v = evaluate(field.t === 'alias' ? field.expr : field, row, params, {});
    if (v !== undefined) out.push(v);
  }
  return out;
}

function applyFieldProjection(rows, fields, params) {
  const hasStar = fields.some((f) => f.t === 'star');
  const out = [];
  for (const row of rows) {
    if (hasStar) {
      out.push({ ...row });
      continue;
    }
    const item = {};
    for (const field of fields) {
      if (field.t === 'alias') {
        const v = evaluate(field.expr, row, params, {});
        if (v !== undefined) item[field.alias] = v;
        continue;
      }
      if (field.t === 'path') {
        const v = getPath(row, field.parts);
        if (v !== undefined) item[field.parts[field.parts.length - 1]] = v;
        continue;
      }
      const v = evaluate(field, row, params, {});
      if (v !== undefined) {
        const name = field.t === 'func' ? field.name.split('::').pop() : 'value';
        item[name] = v;
      }
    }
    out.push(item);
  }
  return out;
}

function applyGrouping(rows, stmt, params) {
  const groups = new Map();
  if (stmt.group === 'all' || !stmt.group) {
    groups.set('__all__', rows);
  } else {
    for (const row of rows) {
      const keyParts = stmt.group.map((path) => getPath(row, path.parts));
      const key = JSON.stringify(keyParts);
      if (!groups.has(key)) {
        groups.set(key, []);
        // remember key values for projection
        groups.get(key).__keys = keyParts;
      }
      groups.get(key).push(row);
    }
  }

  const out = [];
  let groupIndex = 0;
  for (const [, groupRows] of groups) {
    const item = {};
    for (const field of stmt.fields ?? []) {
      if (field.t === 'star') {
        Object.assign(item, groupRows[0] ?? {});
        continue;
      }
      if (field.t === 'count') {
        item.count = groupRows.length;
        continue;
      }
      if (field.t === 'alias') {
        item[field.alias] = evaluateInGroup(field.expr, groupRows, params);
        continue;
      }
      if (field.t === 'path') {
        const v = stmt.group
          ? (groupRows.__keys?.[stmt.group.findIndex((g) => g.parts.join('.') === field.parts.join('.'))] ?? getPath(groupRows[0], field.parts))
          : getPath(groupRows[0], field.parts);
        if (v !== undefined) item[field.parts[field.parts.length - 1]] = v;
        continue;
      }
      if (field.t === 'func') {
        const name = field.name.split('::').pop();
        item[name] = evaluateInGroup(field, groupRows, params);
        continue;
      }
      item.value = evaluateInGroup(field, groupRows, params);
    }
    out.push(item);
    groupIndex += 1;
  }
  void groupIndex;
  return out;
}

function evaluateInGroup(expr, groupRows, params) {
  if (expr.t === 'count') return groupRows.length;
  if (expr.t === 'func' && AGG_NAMES.has(expr.name)) {
    const values = groupRows.map((row) => evaluate(expr.args[0], row, params, {})).filter((v) => v !== undefined && v !== null);
    const nums = values.map((v) => Number(v)).filter((n) => !Number.isNaN(n));
    if (expr.name === 'math::sum') return nums.reduce((a, b) => a + b, 0);
    if (expr.name === 'math::max') return nums.length ? Math.max(...nums) : undefined;
    if (expr.name === 'math::min') return nums.length ? Math.min(...nums) : undefined;
    if (expr.name === 'math::mean' || expr.name === 'math::average') {
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : undefined;
    }
    if (expr.name === 'math::median') {
      if (!nums.length) return undefined;
      const sorted = [...nums].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
  }
  // non-aggregate: evaluate on the first row of the group
  return evaluate(expr, groupRows[0], params, {});
}

function applyOrderBy(rows, order, params) {
  const keyed = rows.map((row) => ({
    row,
    keys: order.map(({ expr, numeric }) => {
      let v = evaluate(expr, row, params, {});
      if (numeric && typeof v === 'string') {
        const n = Number(v);
        if (!Number.isNaN(n)) v = n;
      }
      return v;
    }),
  }));
  keyed.sort((a, b) => {
    for (let i = 0; i < order.length; i += 1) {
      const cmp = compareValues(a.keys[i], b.keys[i]);
      if (cmp !== 0) return order[i].dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
  return keyed.map((x) => x.row);
}

function applySplit(rows, splitPaths) {
  let current = rows;
  for (const path of splitPaths) {
    const next = [];
    for (const row of current) {
      const value = getPath(row, path.parts);
      if (Array.isArray(value)) {
        for (const element of value) {
          const clone = { ...row };
          setPathValue(clone, path.parts, element);
          next.push(clone);
        }
      } else {
        next.push(row);
      }
    }
    current = next;
  }
  return current;
}

/** Walk rows to the parent objects holding the final path segment. */
function collectFieldLocations(rows, parts) {
  let current = rows.map((row) => ({ obj: row, field: parts[0] }));
  for (let depth = 0; depth < parts.length - 1; depth += 1) {
    const next = [];
    for (const loc of current) {
      const v = loc.obj?.[loc.field];
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const el of v) {
          if (el && typeof el === 'object') next.push({ obj: el, field: parts[depth + 1] });
        }
      } else if (typeof v === 'object') {
        next.push({ obj: v, field: parts[depth + 1] });
      }
    }
    current = next;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** Extract `id = X` / `id IN [...]` conditions from a pure-AND where tree.
 * Returns Map(table → Set(ids)) when the whole tree is AND-based, null when
 * the tree contains OR/NOT (fall back to scan), and a Map with table→empty
 * set when id IN [] makes the result empty. */
export function extractIdConditions(where, params) {
  if (!where) return null;
  let sawId = false;
  const tables = new Map();

  const ridToParts = (v) => {
    if (typeof v === 'string') {
      const m = v.match(RID_PATH_RE);
      return m ? { table: m[1], id: m[2] } : null;
    }
    if (v && typeof v === 'object' && v.table && v.id) return { table: String(v.table), id: String(v.id) };
    return null;
  };

  const walk = (node) => {
    if (!node) return false;
    if (node.t === 'bin' && node.op === 'and') return walk(node.l) && walk(node.r);
    if (node.t === 'bin' && node.op === '=') {
      const isIdLeft = node.l.t === 'path' && node.l.parts.length === 1 && node.l.parts[0] === 'id';
      const isIdRight = node.r.t === 'path' && node.r.parts.length === 1 && node.r.parts[0] === 'id';
      if (isIdLeft || isIdRight) {
        const valueNode = isIdLeft ? node.r : node.l;
        const v = valueNode.t === 'param' ? params[valueNode.name] : valueNode.t === 'lit' ? valueNode.v : undefined;
        const parts = ridToParts(v);
        if (parts) {
          sawId = true;
          if (!tables.has(parts.table)) tables.set(parts.table, new Set());
          tables.get(parts.table).add(parts.id);
          return true;
        }
        return false;
      }
      return false;
    }
    if (node.t === 'bin' && (node.op === 'in' || node.op === '!in')) {
      const isIdLeft = node.l.t === 'path' && node.l.parts.length === 1 && node.l.parts[0] === 'id';
      if (isIdLeft && node.op === 'in') {
        const valueNode = node.r;
        const v = valueNode.t === 'param' ? params[valueNode.name] : valueNode.t === 'lit' ? valueNode.v : undefined;
        if (Array.isArray(v)) {
          sawId = true;
          for (const item of v) {
            const parts = ridToParts(item);
            if (!parts) return false;
            if (!tables.has(parts.table)) tables.set(parts.table, new Set());
            tables.get(parts.table).add(parts.id);
          }
          return true;
        }
        return false;
      }
      return false;
    }
    return false;
  };

  const ok = walk(where);
  if (!ok || !sawId) return null;
  return tables;
}

export function setPathValue(obj, parts, value) {
  let current = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const next = current[part];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part];
  }
  const last = parts[parts.length - 1];
  if (value === undefined) {
    delete current[last];
  } else {
    current[last] = value;
  }
}

/** Normalize an evaluated value for storage (markers → stored forms). */
export function normalizeForWrite(value, table, kinds, path = null) {
  return normalizeIn(value, table, path, kinds);
}

function applyJsonPatch(data, ops) {
  let out = structuredClone(data);
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    const path = String(op.path ?? '').split('/').filter(Boolean).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    switch (op.op) {
      case 'add':
      case 'replace':
        if (path.length) setPathValue(out, path, op.value);
        break;
      case 'remove':
        if (path.length) setPathValue(out, path, undefined);
        break;
      default:
        break;
    }
  }
  return out;
}

export { RECORD_SYM, toRow, DTMarker, TableMarker, SDateTime, SRid, SDecimal, SUuid, SDuration, STagged };
