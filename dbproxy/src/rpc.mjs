/**
 * WebSocket RPC server speaking the SurrealDB /rpc wire protocol (subprotocol
 * "cbor", CBOR-encoded JSON-RPC frames as produced by the `surrealdb` JS SDK
 * v2). Every statement is executed against PostgreSQL via engine.mjs.
 *
 * Supported RPC methods: ping, version, use, info, signin, signup,
 * authenticate, invalidate, let, unset, query, begin, commit, cancel, kill.
 */

import { WebSocketServer } from 'ws';
import crypto from 'node:crypto';
import { cborEncode, cborDecode, SRid, SDateTime, SDecimal, SUuid, SDuration, SNone, SSet, STable, STagged } from './cbor.mjs';
import { Engine, resolveTarget, encodeResult } from './engine.mjs';
import { parse, parseDurationLiteral } from './parser.mjs';
import { QueryError, DTMarker, TableMarker } from './eval.mjs';

/** Normalize CBOR-decoded parameter values into evaluator-friendly form.
 * Record ids and datetimes keep their sentinels (SRid / DTMarker) so the
 * write path can learn field kinds; everything else converts to plain JS. */
export function normalizeParams(value) {
  if (value instanceof SRid) return value;
  if (value instanceof SDateTime) return new DTMarker(value.iso);
  if (value instanceof SDecimal) return value.str;
  if (value instanceof SUuid) return value.str;
  if (value instanceof SDuration) {
    try {
      return parseDurationLiteral(value.str);
    } catch {
      return value.str;
    }
  }
  if (value instanceof STable) return new TableMarker(value.name);
  if (value instanceof SNone || value === undefined) return undefined;
  if (value instanceof SSet) return normalizeParams(value.items);
  if (value instanceof STagged) return normalizeParams(value.value);
  if (Array.isArray(value)) return value.map((v) => normalizeParams(v)).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const n = normalizeParams(v);
      if (n !== undefined) out[k] = n;
    }
    return out;
  }
  return value;
}

const VERSION_STRING = process.env.DB_VERSION_STRING ?? 'surrealdb-3.0.5';

function nowMicros() {
  const ns = process.hrtime.bigint();
  return Number(ns / 1000n) / 1000;
}

function rpcErrorPayload(err) {
  if (err instanceof QueryError) {
    return { code: -32003, kind: 'Query', message: err.message };
  }
  if (err && typeof err === 'object' && err.kind) {
    return { code: err.code ?? -32000, kind: err.kind, message: err.message };
  }
  return { code: -32000, kind: 'Internal', message: err?.message ?? String(err) };
}

export class RpcServer {
  constructor({ store, auth, liveRegistry, logger = console }) {
    this.store = store;
    this.auth = auth;
    this.liveRegistry = liveRegistry;
    this.logger = logger;
    this.engine = new Engine(store, { logger, liveRegistry });
    this.wss = null;
  }

  listen({ port, host }) {
    this.wss = new WebSocketServer({
      port,
      host,
      handleProtocols: (protocols) => {
        // The SDK opens sockets with subprotocol "cbor"
        if (protocols.has('cbor')) return 'cbor';
        return false;
      },
    });
    this.wss.on('connection', (ws) => {
      this.attachConnection(ws);
    });
    this.wss.on('error', (err) => {
      this.logger.error?.('[rpc] server error:', err.message);
    });
    return this.wss;
  }

  close() {
    return new Promise((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }

  attachConnection(ws) {
    const session = {
      ns: null,
      db: null,
      auth: null,
      variables: new Map(),
      transactions: new Map(),
      closed: false,
    };

    const send = (obj) => {
      if (ws.readyState === ws.OPEN || ws.readyState === 1) {
        ws.send(cborEncode(obj));
      }
    };

    // register live subscription senders bound to this socket
    const socketSends = new Set();
    session.onClose = [];

    ws.on('message', (data) => {
      let request;
      try {
        const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
        request = cborDecode(buf);
      } catch (err) {
        this.logger.error?.('[rpc] failed to decode frame:', err.message);
        return;
      }
      this.handleRequest(request, session, send, socketSends).catch((err) => {
        this.logger.error?.('[rpc] unhandled error:', err.message);
        if (request && typeof request.id === 'string') {
          send({ id: request.id, error: rpcErrorPayload(err) });
        }
      });
    });

    ws.on('close', () => {
      session.closed = true;
      for (const cleanup of session.onClose) {
        try {
          cleanup();
        } catch {
          /* ignore */
        }
      }
      session.transactions.forEach((txn) => {
        try {
          txn.client.release();
        } catch {
          /* ignore */
        }
      });
      session.transactions.clear();
    });

    ws.on('error', () => {
      /* handled by close */
    });

    session.sendLive = (frame) => send(frame);
    session.socketSends = socketSends;
  }

  async handleRequest(request, session, send, socketSends) {
    if (!request || typeof request !== 'object') return;
    const { id, method, params } = request;
    const reply = (result) => {
      if (typeof id === 'string') send({ id, result: result ?? null });
    };
    const fail = (err) => {
      if (typeof id === 'string') send({ id, error: rpcErrorPayload(err) });
    };

    try {
      switch (method) {
        case 'ping':
          return reply(null);
        case 'version':
          return reply(VERSION_STRING);
        case 'health':
          return reply(null);
        case 'use': {
          const [ns, db] = params ?? [];
          session.ns = ns ?? session.ns;
          session.db = db ?? session.db;
          return reply({});
        }
        case 'info':
          return reply({ namespace: session.ns ?? 'restaurant_manager', database: session.db ?? 'restaurant_manager' });
        case 'signin': {
          const auth = params?.[0] ?? {};
          const token = this.auth.signin(auth);
          session.auth = { sub: 'root', login: auth.user, roles: ['owner'], typ: 'db_root' };
          return reply(token);
        }
        case 'authenticate': {
          const token = params?.[0];
          const payload = this.auth.authenticate(token);
          session.auth = {
            sub: payload.sub,
            login: payload.login,
            roles: payload.roles ?? [],
            typ: payload.typ ?? 'db_session',
          };
          return reply(null);
        }
        case 'invalidate':
          session.auth = null;
          return reply(null);
        case 'let': {
          const [name, value] = params ?? [];
          session.variables.set(name, value);
          return reply(null);
        }
        case 'unset': {
          const [name] = params ?? [];
          session.variables.delete(name);
          return reply(null);
        }
        case 'begin': {
          const uuid = crypto.randomUUID();
          const client = await this.store.pool.connect();
          await client.query('BEGIN');
          session.transactions.set(uuid, { client, savepoint: 0 });
          return reply(uuid);
        }
        case 'commit': {
          const [uuid] = params ?? [];
          const txn = session.transactions.get(uuid);
          if (!txn) throw new QueryError('Unknown transaction');
          session.transactions.delete(uuid);
          await txn.client.query('COMMIT');
          txn.client.release();
          this.liveRegistry?.dispatch().catch(() => {});
          return reply(null);
        }
        case 'cancel': {
          const [uuid] = params ?? [];
          const txn = session.transactions.get(uuid);
          if (!txn) throw new QueryError('Unknown transaction');
          session.transactions.delete(uuid);
          await txn.client.query('ROLLBACK');
          txn.client.release();
          return reply(null);
        }
        case 'query':
          return await this.handleQuery(request, session, reply, fail);
        case 'kill': {
          const uuid = params?.[0];
          this.liveRegistry?.kill(String(uuid));
          return reply(null);
        }
        default:
          throw Object.assign(new Error(`Method '${method}' is not implemented`), { kind: 'NotFound', code: -32601 });
        }
    } catch (err) {
      return fail(err);
    }
  }

  /**
   * Execute a SurrealQL batch. One PostgreSQL transaction per batch, one
   * savepoint per statement — a failing statement returns status ERR and the
   * batch continues (SurrealDB behavior), while the whole batch stays atomic
   * against crashes.
   */
  async handleQuery(request, session, reply, fail) {
    const [sql, bindings] = request.params ?? [];
    const stmtResults = [];
    const client = await this.store.pool.connect();
    let inManualTxn = false;
    let manualSavepoint = null;
    let savepointCounter = 0;
    let wrote = false;
    let committed = false;

    const effectiveParams = normalizeParams({ ...(bindings ?? {}) });
    for (const [name, value] of session.variables) {
      if (!(name in effectiveParams)) effectiveParams[name] = normalizeParams(value);
    }

    try {
      await client.query('BEGIN');
      let statements;
      try {
        statements = parse(String(sql ?? ''));
      } catch (err) {
        // SurrealDB surfaces parse errors as a single RPC error
        throw Object.assign(new Error(`There was a problem with the database: ${err.message}`), {
          kind: 'Query',
          code: -32003,
        });
      }

      for (const stmt of statements) {
        const spName = `sp_${savepointCounter++}`;
        if (stmt.kind === 'begin') {
          manualSavepoint = `manual_${savepointCounter++}`;
          await client.query(`SAVEPOINT ${manualSavepoint}`);
          inManualTxn = true;
          stmtResults.push({ time: `${nowMicros()}µs`, status: 'OK', result: null });
          continue;
        }
        if (stmt.kind === 'commit') {
          if (inManualTxn && manualSavepoint) {
            await client.query(`RELEASE SAVEPOINT ${manualSavepoint}`);
            inManualTxn = false;
            manualSavepoint = null;
          }
          stmtResults.push({ time: `${nowMicros()}µs`, status: 'OK', result: null });
          continue;
        }
        if (stmt.kind === 'cancel') {
          if (inManualTxn && manualSavepoint) {
            await client.query(`ROLLBACK TO SAVEPOINT ${manualSavepoint}`);
            inManualTxn = false;
            manualSavepoint = null;
          }
          stmtResults.push({ time: `${nowMicros()}µs`, status: 'OK', result: null });
          continue;
        }
        await client.query(`SAVEPOINT ${spName}`);
        const t0 = nowMicros();
        try {
          const result = await this.engine.execute(stmt, session, client, effectiveParams);
          const dt = nowMicros() - t0;
          wrote = wrote || ['create', 'upsert', 'insert', 'update', 'delete', 'relate'].includes(stmt.kind);
          if (stmt.kind === 'live') {
            const uuid = result?.[0]?.str;
            const resolvedTarget = resolveTarget(stmt.from[0], effectiveParams);
            if (uuid && session.sendLive && resolvedTarget?.table) {
              // Subscriptions start at the current max change_log seq so they
              // only receive changes written after this statement.
              const startSeq = await this.store.getMaxSeq(client);
              this.liveRegistry.register(uuid, {
                startSeq,
                table: resolvedTarget.table,
                where: stmt.where ?? null,
                params: effectiveParams,
                send: session.sendLive,
              });
              session.onClose.push(() => this.liveRegistry.kill(uuid));
            }
          }
          stmtResults.push({
            time: formatDuration(dt),
            status: 'OK',
            result: encodeResult(result, (table) => this.store.kindsCache.get(table) ?? new Map()),
            ...(stmt.kind === 'live' ? { type: 'live' } : {}),
          });
          await client.query(`RELEASE SAVEPOINT ${spName}`);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${spName}`);
          await client.query(`RELEASE SAVEPOINT ${spName}`);
          const dt = nowMicros() - t0;
          this.logger.warn?.(`[query] statement failed: ${err.message}`);
          stmtResults.push({ time: formatDuration(dt), status: 'ERR', result: err.message });
        }
      }

      await client.query('COMMIT');
      committed = true;
    } catch (err) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore */
        }
      }
      return fail(err);
    } finally {
      client.release();
    }

    if (wrote) {
      this.liveRegistry?.dispatch().catch(() => {});
    }
    reply(stmtResults);
  }
}

function formatDuration(micros) {
  if (micros < 1000) return `${Math.max(1, Math.round(micros))}µs`;
  if (micros < 1_000_000) return `${(micros / 1000).toFixed(3)}ms`;
  return `${(micros / 1_000_000).toFixed(3)}s`;
}
