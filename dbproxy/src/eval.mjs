/**
 * SurrealQL expression evaluator. Works on the normalized internal value
 * model: record links are "table:id" strings, datetimes are ISO-8601 UTC
 * strings, NONE is `undefined`. Executes the subset of functions and
 * operators the application actually uses.
 */

import bcrypt from 'bcryptjs';
import { SRid } from './cbor.mjs';

/** Marker for datetime values produced by time::* functions on the write path. */
export class DTMarker {
  constructor(iso) {
    this.iso = iso;
  }
}

/** Marker for table literals produced by type::table(). */
export class TableMarker {
  constructor(name) {
    this.name = name;
  }
}

export class QueryError extends Error {
  constructor(message, code = 'query') {
    super(message);
    this.code = code;
  }
}

export const NONE = Symbol('surreal-none');
const NONE_LITERAL = 'NONE';

export function isNone(v) {
  return v === undefined || v === NONE;
}

// ---------------------------------------------------------------------------
// Value comparison & coercion
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

export function looksLikeIsoDate(v) {
  return typeof v === 'string' && ISO_DATE_RE.test(v) && !Number.isNaN(Date.parse(v));
}

function typeRank(v) {
  if (v === undefined || v === NONE) return 0;
  if (v === null) return 1;
  if (typeof v === 'boolean') return 2;
  if (typeof v === 'number') return 3;
  if (typeof v === 'string') return 4;
  if (Array.isArray(v)) return 5;
  return 6;
}

/** Surreal-like total order: none < null < bool < number < string < array < object */
export function compareValues(a, b) {
  if (a instanceof DTMarker) a = a.iso;
  if (b instanceof DTMarker) b = b.iso;
  // Record ids compare by their string form regardless of representation
  if (a instanceof SRid) a = a.toString();
  if (b instanceof SRid) b = b.toString();
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  switch (ra) {
    case 0:
    case 1:
      return 0;
    case 2:
      return (a === b ? 0 : a ? 1 : -1);
    case 3: {
      const na = Number(a);
      const nb = Number(b);
      return na === nb ? 0 : na < nb ? -1 : 1;
    }
    case 4: {
      // datetimes compare chronologically
      if (looksLikeIsoDate(a) && looksLikeIsoDate(b)) {
        const da = Date.parse(a);
        const db = Date.parse(b);
        return da === db ? 0 : da < db ? -1 : 1;
      }
      return a < b ? -1 : a > b ? 1 : 0;
    }
    case 5: {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i += 1) {
        const c = compareValues(a[i], b[i]);
        if (c !== 0) return c;
      }
      return a.length - b.length;
    }
    default: {
      const sa = JSON.stringify(a);
      const sb = JSON.stringify(b);
      return sa === sb ? 0 : sa < sb ? -1 : 1;
    }
  }
}

export function deepEqual(a, b) {
  if (a instanceof SRid) a = a.toString();
  if (b instanceof SRid) b = b.toString();
  if (a === undefined || a === NONE) return b === undefined || b === NONE;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) {
    // numeric cross-type
    if (typeof a === 'number' && typeof b === 'string' && b !== '' && !Number.isNaN(Number(b))) return a === Number(b);
    if (typeof b === 'number' && typeof a === 'string' && a !== '' && !Number.isNaN(Number(a))) return b === Number(a);
    return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return a === b;
}

function isTruthy(v) {
  if (v === undefined || v === NONE || v === null || v === false) return false;
  return true;
}

function toArray(v) {
  return Array.isArray(v) ? v : [v];
}

function containsOp(container, needle) {
  if (Array.isArray(container)) {
    return container.some((item) => deepEqual(item, needle));
  }
  if (typeof container === 'string' && typeof needle === 'string') {
    return container.includes(needle);
  }
  if (container !== null && typeof container === 'object') {
    return Object.values(container).some((item) => deepEqual(item, needle));
  }
  return false;
}

function insideOp(value, container) {
  return containsOp(container, value);
}

// ---------------------------------------------------------------------------
// Path access (with Surreal's automatic array flattening)
// ---------------------------------------------------------------------------

function accessPart(current, part) {
  if (current === undefined || current === NONE || current === null) return undefined;
  if (Array.isArray(current)) {
    const out = [];
    for (const item of current) {
      const v = accessPart(item, part);
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  if (typeof current === 'object') {
    return current[part];
  }
  return undefined;
}

export function getPath(row, parts) {
  let current = row;
  for (const part of parts) {
    current = accessPart(current, part);
    if (current === undefined) return undefined;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

const AGGREGATE_FUNCS = new Set([
  'math::sum', 'math::max', 'math::min', 'math::mean', 'math::average',
  'math::median', 'math::mode', 'count',
]);

export function isAggregateCall(node) {
  if (!node) return false;
  if (node.t === 'count') return true;
  if (node.t === 'func' && AGGREGATE_FUNCS.has(node.name)) return true;
  return false;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return NaN;
}

function parseDateish(v) {
  if (v instanceof DTMarker) return new Date(v.iso);
  if (looksLikeIsoDate(v)) return new Date(v);
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v * (v > 1e12 ? 1 : 1000));
  return null;
}

function formatDateTime(date, fmt) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const map = {
    '%Y': String(date.getUTCFullYear()),
    '%m': pad(date.getUTCMonth() + 1),
    '%d': pad(date.getUTCDate()),
    '%H': pad(date.getUTCHours()),
    '%M': pad(date.getUTCMinutes()),
    '%S': pad(date.getUTCSeconds()),
    '%3f': pad(date.getUTCMilliseconds(), 3),
  };
  return fmt.replace(/%Y|%m|%d|%H|%M|%S|%3f/g, (tok) => map[tok] ?? tok);
}

function callFunction(name, args, ctx) {
  switch (name) {
    case 'time::now':
      return new DTMarker(new Date().toISOString());
    case 'time::unix': {
      const v = args[0];
      if (v === undefined || v === NONE || v === null) return Math.floor(Date.now() / 1000);
      const d = parseDateish(v);
      return d ? Math.floor(d.getTime() / 1000) : undefined;
    }
    case 'time::format': {
      // time::format($fmt) or time::format($fmt, $datetime)
      const fmt = args[0];
      const target = args.length > 1 ? args[1] : new Date();
      const d = target instanceof Date ? target : parseDateish(target);
      if (!d || Number.isNaN(d.getTime())) return undefined;
      return formatDateTime(d, String(fmt));
    }
    case 'time::min':
    case 'time::max': {
      const items = args.flat().filter((v) => v !== undefined).map(parseDateish).filter(Boolean);
      if (items.length === 0) return undefined;
      const best = items.reduce((acc, d) => {
        if (acc === null) return d;
        const cmp = name === 'time::min' ? (d < acc ? d : acc) : d > acc ? d : acc;
        return cmp;
      }, null);
      return new DTMarker(best.toISOString());
    }
    case 'math::sum':
    case 'math::max':
    case 'math::min':
    case 'math::mean':
    case 'math::average': {
      const items = args.flat().filter((v) => v !== undefined && v !== null).map(toNumber).filter((n) => !Number.isNaN(n));
      if (items.length === 0) return undefined;
      if (name === 'math::sum') return items.reduce((a, b) => a + b, 0);
      if (name === 'math::max') return Math.max(...items);
      if (name === 'math::min') return Math.min(...items);
      return items.reduce((a, b) => a + b, 0) / items.length;
    }
    case 'math::abs':
      return Math.abs(toNumber(args[0]));
    case 'math::floor':
      return Math.floor(toNumber(args[0]));
    case 'math::ceil':
      return Math.ceil(toNumber(args[0]));
    case 'math::round':
      return Math.round(toNumber(args[0]));
    case 'string::lowercase':
      return typeof args[0] === 'string' ? args[0].toLowerCase() : args[0];
    case 'string::uppercase':
      return typeof args[0] === 'string' ? args[0].toUpperCase() : args[0];
    case 'string::contains':
      return typeof args[0] === 'string' && typeof args[1] === 'string' ? args[0].includes(args[1]) : false;
    case 'string::starts_with':
      return typeof args[0] === 'string' && typeof args[1] === 'string' ? args[0].startsWith(args[1]) : false;
    case 'string::ends_with':
      return typeof args[0] === 'string' && typeof args[1] === 'string' ? args[0].endsWith(args[1]) : false;
    case 'string::concat': {
      const parts = (args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map((v) => (v === undefined || v === NONE || v === null ? '' : String(v)));
      return parts.join('');
    }
    case 'string::join': {
      const sep = args[0];
      const parts = args.slice(1).flat().filter((v) => v !== undefined && v !== NONE && v !== null).map(String);
      return parts.join(String(sep));
    }
    case 'string::len':
      return typeof args[0] === 'string' ? args[0].length : undefined;
    case 'string::trim':
      return typeof args[0] === 'string' ? args[0].trim() : args[0];
    case 'string::slice':
      return typeof args[0] === 'string' ? args[0].slice(args[1], args[2]) : args[0];
    case 'array::union': {
      const out = [];
      for (const item of args.flat(1)) {
        if (item === undefined || item === NONE) continue;
        if (!out.some((x) => deepEqual(x, item))) out.push(item);
      }
      return out;
    }
    case 'array::distinct': {
      const out = [];
      for (const item of toArray(args[0])) {
        if (!out.some((x) => deepEqual(x, item))) out.push(item);
      }
      return out;
    }
    case 'array::flatten':
      return args.flat(2).filter((v) => v !== undefined);
    case 'array::len':
    case 'count': {
      // count($array) / count($field): count non-none values
      const v = args[0];
      if (Array.isArray(v)) return v.filter((x) => x !== undefined && x !== NONE).length;
      if (v === undefined || v === NONE || v === null) return 0;
      return 1;
    }
    case 'array::any':
      return toArray(args[0]).some(isTruthy);
    case 'array::all':
      return toArray(args[0]).every(isTruthy);
    case 'array::add': {
      const arr = Array.isArray(args[0]) ? [...args[0]] : [];
      const value = args[1];
      if (!arr.some((x) => deepEqual(x, value))) arr.push(value);
      return arr;
    }
    case 'array::remove': {
      const arr = Array.isArray(args[0]) ? [...args[0]] : [];
      const value = args[1];
      return arr.filter((x) => !deepEqual(x, value));
    }
    case 'object::keys':
      return args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? Object.keys(args[0]) : [];
    case 'object::values':
      return args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? Object.values(args[0]) : [];
    case 'object::len':
      return args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) ? Object.keys(args[0]).length : 0;
    case 'type::record': {
      // type::record($id) | type::record($table, $id) | type::record(thing)
      if (args.length >= 2) return `${args[0]}:${args[1]}`;
      const v = args[0];
      if (v === undefined || v === NONE || v === null) return undefined;
      return String(v);
    }
    case 'type::table': {
      const v = args[0];
      if (v === undefined || v === NONE || v === null) return undefined;
      return new TableMarker(String(v));
    }
    case 'type::field':
      return ctx?.row ? getPath(ctx.row, [String(args[0])]) : undefined;
    case 'type::fields':
      return ctx?.row ? getPath(ctx.row, toArray(args[0]).map(String)) : undefined;
    case 'type::string':
      return args[0] === undefined || args[0] === NONE ? undefined : String(args[0]);
    case 'type::number':
      return toNumber(args[0]);
    case 'type::bool':
      return isTruthy(args[0]);
    case 'type::is_array':
      return Array.isArray(args[0]);
    case 'type::is_none':
      return args[0] === undefined || args[0] === NONE;
    case 'type::is_null':
      return args[0] === null;
    case 'type::is_record':
      return typeof args[0] === 'string' && /^[A-Za-z_][A-Za-z0-9_]*:/.test(args[0]);
    case 'crypto::bcrypt::generate': {
      const cost = Number(args[1]) || 10;
      return bcrypt.hashSync(String(args[0]), cost);
    }
    case 'crypto::bcrypt::compare': {
      // crypto::bcrypt::compare(hash, candidate)
      const hash = args[0];
      const candidate = args[1];
      if (typeof hash !== 'string' || !hash.startsWith('$2')) return false;
      try {
        return bcrypt.compareSync(String(candidate ?? ''), hash);
      } catch {
        return false;
      }
    }
    case 'rand::uuid':
    case 'rand::uuid::v4':
      return cryptoRandomUuid();
    case 'rand::int':
      return Math.floor(Math.random() * (Number(args[1]) - Number(args[0]) + 1)) + Number(args[0]);
    case 'rand::float':
      return Math.random() * (Number(args[1]) - Number(args[0])) + Number(args[0]);
    case 'rand::string': {
      const len = Number(args[0]) || 20;
      let out = '';
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      for (let i = 0; i < len; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
      return out;
    }
    case 'record::id': {
      const v = String(args[0] ?? '');
      const idx = v.indexOf(':');
      return idx === -1 ? v : v.slice(idx + 1);
    }
    case 'record::table': {
      const v = String(args[0] ?? '');
      const idx = v.indexOf(':');
      return idx === -1 ? v : v.slice(0, idx);
    }
    case 'record::tb':
      return callFunction('record::table', args, ctx);
    default:
      throw new QueryError(`Function '${name}' is not supported by the MySQL data service`);
  }
}

function cryptoRandomUuid() {
  return globalThis.crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Casts
// ---------------------------------------------------------------------------

function applyCast(type, value) {
  if (value === NONE || value === undefined) return undefined;
  switch (type) {
    case 'string':
      if (typeof value === 'object' && value !== null) return JSON.stringify(value);
      return String(value);
    case 'number':
    case 'int':
    case 'float':
    case 'decimal': {
      const n = toNumber(value);
      return Number.isNaN(n) ? undefined : n;
    }
    case 'bool':
    case 'boolean':
      return isTruthy(value);
    case 'datetime': {
      const d = parseDateish(value) ?? (typeof value === 'string' ? new Date(value) : null);
      if (!d || Number.isNaN(d.getTime())) return undefined;
      return new DTMarker(d.toISOString());
    }
    case 'record': {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object' && value.id !== undefined) return String(value.id);
      return undefined;
    }
    default: {
      if (type.startsWith('array<') && type.endsWith('>')) {
        const inner = type.slice(6, -1);
        const arr = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [value];
        return arr.map((item) => applyCast(inner, item)).filter((v) => v !== undefined);
      }
      if (type.startsWith('option<') && type.endsWith('>')) {
        return applyCast(type.slice(7, -1), value);
      }
      return value;
    }
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * @param {object} node expression AST
 * @param {object} row record row ({id: 'table:id', ...data}) — may be null for pure expressions
 * @param {object} params query bindings
 * @param {object} ctx extras: { variables, now }
 */
export function evaluate(node, row, params = {}, ctx = {}) {
  switch (node.t) {
    case 'lit':
      return node.v === NONE_LITERAL ? NONE : node.v;
    case 'uuid':
      return node.v;
    case 'dur':
      return { __duration: node.ms, str: node.str };
    case 'param': {
      const value = params[node.name];
      return value === NONE ? NONE : value;
    }
    case 'path':
      return row ? getPath(row, node.parts) : undefined;
    case 'get':
      return accessPart(evaluate(node.base, row, params, ctx), node.name);
    case 'optpath':
      return accessPart(evaluate(node.base, row, params, ctx), node.name);
    case 'allpath': {
      const base = evaluate(node.base, row, params, ctx);
      if (Array.isArray(base)) return base;
      if (base === undefined || base === NONE || base === null) return [];
      return [base];
    }
    case 'wherepath': {
      const base = evaluate(node.base, row, params, ctx);
      if (!Array.isArray(base)) return base;
      return base.filter((item) => isTruthy(evaluate(node.where, item, params, ctx)));
    }
    case 'index': {
      const base = evaluate(node.base, row, params, ctx);
      const idx = evaluate(node.idx, row, params, ctx);
      if (base === undefined || base === NONE || base === null) return undefined;
      if (Array.isArray(base)) {
        const i = toNumber(idx);
        return Number.isInteger(i) ? base[i < 0 ? base.length + i : i] : undefined;
      }
      if (typeof base === 'object') return base[String(idx)];
      return undefined;
    }
    case 'arr':
      return node.items.map((item) => normalizeEvaluated(evaluate(item, row, params, ctx)));
    case 'obj': {
      const out = {};
      for (const [key, expr] of node.entries) {
        const v = normalizeEvaluated(evaluate(expr, row, params, ctx));
        if (v === NONE || v === undefined) continue; // NONE fields are omitted
        out[key] = v;
      }
      return out;
    }
    case 'cast':
      return applyCast(node.type, evaluate(node.e, row, params, ctx));
    case 'if': {
      if (isTruthy(evaluate(node.cond, row, params, ctx))) return evaluate(node.then, row, params, ctx);
      for (const { cond, then } of node.elifs) {
        if (isTruthy(evaluate(cond, row, params, ctx))) return evaluate(then, row, params, ctx);
      }
      return node.else ? evaluate(node.else, row, params, ctx) : NONE;
    }
    case 'un':
      if (node.op === 'neg') {
        const v = evaluate(node.e, row, params, ctx);
        return -toNumber(v);
      }
      if (node.op === 'not') {
        return !isTruthy(evaluate(node.e, row, params, ctx));
      }
      return undefined;
    case 'isnone': {
      const v = evaluate(node.e, row, params, ctx);
      const isNoneValue = v === undefined || v === NONE;
      return node.neg ? !isNoneValue : isNoneValue;
    }
    case 'isnull': {
      const v = evaluate(node.e, row, params, ctx);
      const isNull = v === null;
      return node.neg ? !isNull : isNull;
    }
    case 'bin':
      return evaluateBinary(node, row, params, ctx);
    case 'count':
      // scalar context (no group) — handled by executor in group context
      return row ? 1 : 0;
    case 'func': {
      const args = node.args.map((a) => evaluate(a, row, params, ctx));
      return callFunction(node.name, args, { row });
    }
    default:
      throw new QueryError(`Unsupported expression node '${node.t}'`);
  }
}

function evaluateBinary(node, row, params, ctx) {
  const { op } = node;
  // short-circuit
  if (op === 'and') {
    return isTruthy(evaluate(node.l, row, params, ctx)) && isTruthy(evaluate(node.r, row, params, ctx));
  }
  if (op === 'or') {
    return isTruthy(evaluate(node.l, row, params, ctx)) || isTruthy(evaluate(node.r, row, params, ctx));
  }
  const l = evaluate(node.l, row, params, ctx);
  const r = evaluate(node.r, row, params, ctx);
  switch (op) {
    case '=':
      return deepEqual(l, r);
    case '!=':
      return !deepEqual(l, r);
    case '<':
      return compareValues(l, r) < 0;
    case '<=':
      return compareValues(l, r) <= 0;
    case '>':
      return compareValues(l, r) > 0;
    case '>=':
      return compareValues(l, r) >= 0;
    case 'in':
      return insideOp(l, r);
    case '!in':
      return !insideOp(l, r);
    case 'contains':
      return containsOp(l, r);
    case '!contains':
      return !containsOp(l, r);
    case 'containsall':
      return Array.isArray(r) && r.every((item) => containsOp(l, item));
    case 'containsany':
      return Array.isArray(r) && r.some((item) => containsOp(l, item));
    case 'containsnone':
      return !(Array.isArray(r) && r.some((item) => containsOp(l, item)));
    case 'inside':
      return insideOp(l, r);
    case '!inside':
      return !insideOp(l, r);
    case 'allinside':
      return Array.isArray(l) && l.every((item) => insideOp(item, r));
    case 'anyinside':
      return Array.isArray(l) && l.some((item) => insideOp(item, r));
    case 'noneinside':
      return !(Array.isArray(l) && l.some((item) => insideOp(item, r)));
    case 'intersects':
      throw new QueryError('INTERSECTS is not supported');
    case '~':
      return typeof l === 'string' && typeof r === 'string' && l.toLowerCase().includes(r.toLowerCase());
    case '+':
      return addValues(l, r);
    case '-':
      return subValues(l, r);
    case '*':
      return toNumber(l) * toNumber(r);
    case '/':
      return toNumber(l) / toNumber(r);
    case '%':
      return toNumber(l) % toNumber(r);
    case '??':
      return l ?? r;
    default:
      throw new QueryError(`Unsupported operator '${op}'`);
  }
}

function addValues(l, r) {
  const lIso = l instanceof DTMarker ? l.iso : l;
  const rIso = r instanceof DTMarker ? r.iso : r;
  if (l === undefined || l === NONE || r === undefined || r === NONE) return NONE;
  if (looksLikeIsoDate(lIso) && r && typeof r === 'object' && '__duration' in r) {
    return new DTMarker(new Date(Date.parse(lIso) + r.__duration).toISOString());
  }
  if (lIso && typeof lIso === 'object' && '__duration' in lIso && rIso && typeof rIso === 'object' && '__duration' in rIso) {
    return { __duration: lIso.__duration + rIso.__duration, str: `${lIso.__duration + rIso.__duration}ms` };
  }
  if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
  if (typeof lIso === 'string' && typeof rIso === 'string') return lIso + rIso;
  return toNumber(lIso) + toNumber(rIso);
}

function subValues(l, r) {
  const lIso = l instanceof DTMarker ? l.iso : l;
  const rIso = r instanceof DTMarker ? r.iso : r;
  if (l === undefined || l === NONE || r === undefined || r === NONE) return NONE;
  if (looksLikeIsoDate(lIso) && rIso && typeof rIso === 'object' && '__duration' in rIso) {
    return new DTMarker(new Date(Date.parse(lIso) - rIso.__duration).toISOString());
  }
  if (looksLikeIsoDate(lIso) && looksLikeIsoDate(rIso)) {
    return { __duration: Date.parse(lIso) - Date.parse(rIso), str: 'ms' };
  }
  if (lIso && typeof lIso === 'object' && '__duration' in lIso && rIso && typeof rIso === 'object' && '__duration' in rIso) {
    return { __duration: lIso.__duration - rIso.__duration, str: `${lIso.__duration - rIso.__duration}ms` };
  }
  return toNumber(lIso) - toNumber(rIso);
}

/** Post-process evaluated values that carry markers into storage-normalizable form. */
export function normalizeEvaluated(v) {
  if (v instanceof DTMarker) return v;
  if (v && typeof v === 'object' && '__duration' in v) {
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => (x instanceof DTMarker || (x && typeof x === 'object') ? normalizeEvaluated(x) : x));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined || val === NONE) continue;
      out[k] = val instanceof DTMarker || (val && typeof val === 'object') ? normalizeEvaluated(val) : val;
    }
    return out;
  }
  return v;
}
