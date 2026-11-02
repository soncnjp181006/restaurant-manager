/**
 * LIVE SELECT support: subscriptions are registered per connection; a change
 * dispatcher polls the durable change_log (written by every data mutation)
 * and pushes SDK-format live messages `{result: {id, action, record, result}}`
 * to matching subscribers. A small poll interval keeps latency low while
 * LISTEN/NOTIFY-style wakeups remain an option for later tuning.
 */

import { SRid, SUuid } from './cbor.mjs';
import { toRow, encodeRow } from './engine.mjs';
import { evaluate, QueryError } from './eval.mjs';

const ACTIONS = new Set(['CREATE', 'UPDATE', 'DELETE']);

export class LiveRegistry {
  constructor(store, options = {}) {
    this.store = store;
    this.pollMs = options.pollMs ?? Number(process.env.DB_LIVE_POLL_MS ?? 250);
    this.logger = options.logger ?? console;
    this.subscriptions = new Map(); // uuid -> {table, where, send}
    this.lastSeq = 0;
    this.timer = null;
    this.dispatching = false;
  }

  register(uuid, { table, where, params, send, startSeq }) {
    // Subscribers only receive changes AFTER their registration point.
    this.subscriptions.set(uuid, { table, where, params: params ?? {}, send, startSeq: startSeq ?? this.lastSeq, createdAt: Date.now() });
  }

  kill(uuid) {
    this.subscriptions.delete(uuid);
  }

  pruneDead() {
    for (const [uuid, sub] of this.subscriptions) {
      if (sub.closed) this.subscriptions.delete(uuid);
    }
  }

  async start() {
    await this.rewind();
    this.timer = setInterval(() => {
      this.dispatch().catch((err) => {
        this.logger.error?.('[live] dispatch failed:', err.message);
      });
    }, this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async rewind() {
    // Start dispatching from "now" — subscribers receive only new changes.
    try {
      const client = await this.store.pool.connect();
      try {
        this.lastSeq = await this.store.getMaxSeq(client);
      } finally {
        client.release();
      }
    } catch (err) {
      this.logger.error?.('[live] rewind failed:', err.message);
    }
  }

  /** Push new change_log rows to matching subscriptions. */
  async dispatch() {
    if (this.dispatching || this.subscriptions.size === 0) return;
    this.dispatching = true;
    try {
      this.pruneDead();
      const client = await this.store.pool.connect();
      let changes;
      try {
        changes = await this.store.getAllChangesSince(client, this.lastSeq, 500);
      } finally {
        client.release();
      }
      if (changes.length === 0) return;
      for (const change of changes) {
        if (process.env.DB_DEBUG_LIVE) {
        }
        this.lastSeq = Math.max(this.lastSeq, Number(change.seq));
        for (const [uuid, sub] of this.subscriptions) {
          // Only changes written after this subscription registered.
          if (Number(change.seq) <= (sub.startSeq ?? 0)) continue;
          if (sub.table !== change.table_name) continue;
          const action = change.action;
          if (!ACTIONS.has(action)) continue;
          if (process.env.DB_DEBUG_LIVE) {
          }
          try {
            // SurrealDB live DELETE messages still carry the before-image object
            let payload = null;
            if (change.data) {
              const row = toRow(change.table_name, change.record_id, change.data);
              if (sub.where) {
                const match = evaluate(sub.where, row, sub.params, {});
                if (!(match === true || (match !== undefined && match !== null && match !== false))) continue;
              }
              payload = encodeRow(row, (table) => this.store.kindsForTable(table));
            }
            if (process.env.DB_DEBUG_LIVE) {
            }
            sub.send({
              result: {
                id: new SUuid(uuid),
                action,
                record: new SRid(change.table_name, change.record_id),
                result: payload,
              },
            });
          } catch (err) {
            if (process.env.DB_DEBUG_LIVE) {
            }
            if (err instanceof QueryError) {
              this.logger.warn?.(`[live] subscription ${uuid} filter error: ${err.message}`);
            } else {
              throw err;
            }
          }
        }
      }
    } finally {
      this.dispatching = false;
    }
  }
}
