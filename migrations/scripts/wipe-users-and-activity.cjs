#!/usr/bin/env node
'use strict';

/**
 * Wipe users, roles and user-linked activity data — one-off bootstrap reset.
 *
 * Deletes (by logical table_name inside the `records` store):
 *   user, user_role                          — accounts & roles
 *   order, order_item, order_item_kitchen, order_payment, order_tax,
 *   order_discount, order_coupon, order_extras, order_meta, order_print,
 *   order_refund, order_merge, order_split, order_void, order_number_seq
 *   coupon_redemption                        — sales history
 *   time_entry, time_entry_break, day_closing, payroll_period, payroll_run,
 *   payroll_snapshot, shift, scheduled_shift, shift_swap_request — HR history
 *   self_order_checkout                      — customer checkout drafts
 *   audit_log, tracking, security_alerts, revoked_session — system history
 *   sync_event, sync_accepted_operation      — sync event log
 * and resets `sync_event_seq` (counter restarts at 1 on next push).
 *
 * KEEPS operational setup: menu, category, menu_item, tax, payment_type,
 * printer, floor, floor_table, kitchen, workflow, settings, inventory… and
 * `_schema_migration` + `change_log` (schema history / live watermark).
 *
 * Idempotent: safe to run repeatedly (deletes what is there, 0 rows ok).
 * Refuses to run without --yes. BACKUP FIRST: mysqldump into backups/mysql/.
 *
 * Flags:
 *   --yes         required — confirms the destructive run
 *   --fresh-sync  additionally TRUNCATE `change_log` (live/sync watermark
 *                 restarts from 1) and clear the `tracking_events` mirror —
 *                 for a full factory reset of sync/analytics state
 *
 * Usage:
 *   node migrations/scripts/wipe-users-and-activity.cjs --yes
 *   node migrations/scripts/wipe-users-and-activity.cjs --yes --fresh-sync
 * Env: MYSQL_HOST/PORT/USER/PASSWORD/DB (defaults from repo .env are NOT read —
 *      pass explicitly or run with dotenv-style env exported).
 */

const fs = require('node:fs');
const path = require('node:path');

const WIPE_TABLES = [
  'user', 'user_role',
  'order', 'order_item', 'order_item_kitchen', 'order_payment', 'order_tax',
  'order_discount', 'order_coupon', 'order_extras', 'order_meta',
  'order_print', 'order_refund', 'order_merge', 'order_split', 'order_void',
  'order_number_seq',
  'coupon_redemption',
  'time_entry', 'time_entry_break', 'day_closing',
  'payroll_period', 'payroll_run', 'payroll_snapshot',
  'shift', 'scheduled_shift', 'shift_swap_request',
  'self_order_checkout',
  'audit_log', 'tracking', 'security_alerts', 'revoked_session',
  'sync_event', 'sync_accepted_operation',
];

function loadEnv() {
  // Minimal .env loader (no dependency): KEY=VALUE lines, comments skipped.
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}

async function main() {
  if (!process.argv.includes('--yes')) {
    console.error('Refusing to run without --yes (this deletes real data). Backup first: mysqldump into backups/mysql/');
    process.exit(1);
  }
  loadEnv();
  const DB = {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_HOST_PORT ?? 3307),
    database: process.env.MYSQL_DB ?? 'restaurant_manager',
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
  };
  if (!DB.user || !DB.password) {
    console.error('MYSQL_USER / MYSQL_PASSWORD missing (set them in .env)');
    process.exit(1);
  }
  const require2 = require('node:module').createRequire(path.join(__dirname, '..', '..', 'dbproxy', 'package.json'));
  const mysql = require2('mysql2/promise');
  const pool = mysql.createPool({ ...DB, connectionLimit: 4 });

  const placeholders = WIPE_TABLES.map(() => '?').join(', ');
  const [beforeRows] = await pool.query(
    `SELECT table_name, COUNT(*) AS n FROM records WHERE table_name IN (${placeholders}) GROUP BY table_name`,
    WIPE_TABLES,
  );
  const before = new Map(beforeRows.map((r) => [r.table_name, r.n]));
  const totalBefore = beforeRows.reduce((a, r) => a + r.n, 0);
  console.log(`Before: ${totalBefore} rows across ${before.size} logical tables`);

  const [res] = await pool.query(`DELETE FROM records WHERE table_name IN (${placeholders})`, WIPE_TABLES);
  console.log(`Deleted: ${res.affectedRows} rows`);

  if (process.argv.includes('--fresh-sync')) {
    const [cl] = await pool.query('TRUNCATE TABLE change_log');
    const [te] = await pool.query('DELETE FROM tracking_events');
    console.log(`Fresh sync: change_log truncated, tracking_events cleared (${te.affectedRows} rows)`);
  }

  // reset the sync event counter (next push starts from 1 again)
  const [seqRes] = await pool.query(`DELETE FROM records WHERE table_name = 'sync_event_seq'`);
  console.log(`Reset sync_event_seq: ${seqRes.affectedRows} row(s) removed`);

  const [afterRows] = await pool.query(
    `SELECT table_name, COUNT(*) AS n FROM records WHERE table_name IN (${placeholders}) GROUP BY table_name`,
    WIPE_TABLES,
  );
  const after = afterRows.reduce((a, r) => a + r.n, 0);
  console.log(`After: ${after} rows (must be 0)`);
  if (after !== 0) {
    console.error('VERIFY FAILED — rows remain:', afterRows);
    process.exit(1);
  }
  // Report what was kept for the record
  const [kept] = await pool.query(
    `SELECT COUNT(*) AS n FROM records WHERE table_name IN ('menu','menu_item','category','tax','payment_type','printer','floor','floor_table','kitchen','setting','_schema_migration')`,
  );
  console.log(`Kept (setup/catalog/schema): ${kept[0].n} rows`);
  console.log('OK — bootstrap wipe complete. The app now has no users: login with PIN 0000 to create the admin.');
  await pool.end();
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
