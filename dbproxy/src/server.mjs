/**
 * Restaurant Manager — PostgreSQL data service.
 *
 * Replaces the SurrealDB server: speaks the same /rpc WebSocket wire protocol
 * (so the `surrealdb` JS SDK clients in the app keep working unchanged) while
 * persisting 100% of data in PostgreSQL.
 */

import pg from 'pg';
import { PgStore } from './store.mjs';
import { DbAuth } from './auth.mjs';
import { LiveRegistry } from './live.mjs';
import { RpcServer } from './rpc.mjs';

const {
  DB_HOST = '127.0.0.1',
  DB_PORT = '5432',
  DB_NAME = 'restaurant_manager',
  DB_USER,
  DB_PASS,
  DB_SSL,
  DBPROXY_PORT = '8000',
  DBPROXY_HOST = '0.0.0.0',
  DB_LIVE_POLL_MS,
} = process.env;

if (!DB_USER || !DB_PASS) {
  console.error('[dbproxy] DB_USER and DB_PASS are required and have no default');
  process.exit(1);
}

const logger = {
  info: (...args) => console.log('[dbproxy]', ...args),
  warn: (...args) => console.warn('[dbproxy]', ...args),
  error: (...args) => console.error('[dbproxy]', ...args),
};

const pool = new pg.Pool({
  host: DB_HOST,
  port: Number(DB_PORT),
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASS,
  max: Number(process.env.DB_POOL_MAX ?? 20),
  ssl: DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  const store = new PgStore(pool, logger);
  const t0 = Date.now();
  await store.init();
  logger.info(`PostgreSQL store ready (schema initialized in ${Date.now() - t0}ms)`);

  const auth = new DbAuth();
  const liveRegistry = new LiveRegistry(store, { logger, pollMs: DB_LIVE_POLL_MS ? Number(DB_LIVE_POLL_MS) : undefined });
  await liveRegistry.start();

  const rpc = new RpcServer({ store, auth, liveRegistry, logger });
  const port = Number(DBPROXY_PORT);
  const host = DBPROXY_HOST;
  rpc.listen({ port, host });
  logger.info(`DB RPC listening on ws://${host}:${port}/rpc (PostgreSQL-backed)`);

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down`);
    liveRegistry.stop();
    await rpc.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('fatal:', err);
  process.exit(1);
});
