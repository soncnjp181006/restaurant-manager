# ADR 0006: MySQL as an analytical mirror of the tracking log — only that part

## Status

Accepted — 2026-10-30 (as a PostgreSQL mirror). Amended 2026-11-03: the engine is
**MySQL**. The scope decision — mirror *only* the tracking log, keep the store
authoritative for every read — still stands; it is the storage engine underneath
that moved, first for the whole system of record ([docs/MIGRATION-MYSQL.md](../MIGRATION-MYSQL.md))
and therefore for this table too.

## Context

The system of record is the `records` JSON store behind `dbproxy` (ADR 0001,
ADR 0002, and since 2026-11-03 that store is MySQL). One table does not fit that
shape well: `tracking`. It is append-mostly, written by every sidecar client
through `tracking-api`, and read back with `SELECT * FROM tracking` in the
activity report, the order-lifecycle report, the sales dashboard, the cash audit
and order detail. Analytical queries over it (grouping by `page`/`module` over a
date range) are the kind of work a relational engine with a real query planner
does better, and SQL is what analysts and BI tools already speak.

Two constraints narrow the design:

1. **Nothing already written may change meaning.** `migrations/` (47-entry
   runner plan + the `.surql` files) and the record permissions are off-limits.
2. **Every existing read path must keep working.** Reports read `tracking`
   through the proxy; moving those reads would mean rewriting SurrealQL in six
   screens and the AI schema description for no user-visible gain.

So the ask "use a relational engine for analytics" can only be honest as a
*partial* adoption: one extra table, written on the side.

## Decision

1. **Scope: the tracking mirror only.** `tracking-api` additionally writes each
   ingested event into a MySQL table `tracking_events`. Orders, menu, inventory,
   HR, accounting, sessions, local outbox — all stay in the `records` store.
2. **The store stays authoritative.** `tracking.service.js` performs the same
   `CREATE type::record` / `CREATE type::table` query as before and returns the
   same value to the route. The mirror happens after that write and its outcome
   is not part of the API response.
3. **Opt-in by environment.** `TRACKING_MYSQL_URL` (a `mysql://` URL) or
   `TRACKING_MYSQL_HOST/PORT/DB/USER/PASS` enable it; blank means no pool is
   ever constructed and no connection is attempted. Nothing to turn off later.
   There is no schema/`search_path` variable: in MySQL the database a mirror
   table lives in is `TRACKING_MYSQL_DB` (or the URL path).
4. **A mirror failure cannot fail ingestion.** `writeTrackingEvent()` returns
   `{ written, reason }` instead of throwing. The service logs the reason and
   increments a counter that `GET /health` exposes as `mysqlMirror` /
   `mysqlMirrorFailures`, so a silently dead mirror is visible to operators.
5. **Idempotent, non-destructive DDL.** One `CREATE TABLE IF NOT EXISTS` that
   carries both indexes inline (`created_at`, `(module, created_at)` — MySQL has
   no `CREATE INDEX IF NOT EXISTS`), mirroring the index set in
   `2026_08_30_hot_path_indexes.surql`. Applied on first use; no migration
   framework, nothing in `migrations/`.
6. **Key semantics follow the record store.** A client id matching
   `^[a-zA-Z0-9_-]{1,128}$` becomes `tracking_id` and is upserted
   (`ON DUPLICATE KEY UPDATE`) because `CREATE type::record` overwrites. Anything
   else gets a generated UUID, and the rejected raw value is preserved inside the
   `payload` JSON column so the copy loses no information.
7. **Local infra is a separate compose file** (`docker-compose.analytics.yml`),
   not a service in `docker-compose.yml`. Compose interpolates `${VAR:?}` for
   every service in a file even when a profile hides it, so required mirror
   credentials in the main file would break `docker compose up` for every
   developer who does not run analytics. Since the 2026-11-03 migration the main
   file already runs MySQL, so the overlay now only sets `TRACKING_MYSQL_URL` on
   the tracking service — no second database container.

## Consequences

- Reports do **not** read `tracking_events`. Adding SQL analytics is a separate,
  later decision; today the mirror exists so that data is available in a
  relational form, not because a screen consumes it.
- Dual-write means the two copies can diverge when MySQL is unreachable. The
  divergence is one-directional and detectable (`mysqlMirrorFailures`), and the
  store copy remains complete, so a rebuild is possible by replaying from
  `tracking`.
- `mysql2` is a new dependency of `tracking-api`; the browser bundle and the
  other four sidecars are untouched.
- The `tracking_events` table is disposable: dropping it and restarting
  `tracking-api` re-creates it, and no app behaviour depends on it existing.

## Verification

Original run (2026-10-30, against `postgres:16-alpine`): 28 tests, 26 pass + 2
visible skips when no database is configured, 28/28 with a live container.

Re-run after the engine switch (2026-11-03, against `mysql:8.0`):
`npm run test:tracking` → **30 pass, 0 fail, 0 skipped** — the two former skips
now execute because a live MySQL is reachable, and four extra cases cover the
URL parser (default port, percent-encoded credentials, wrong scheme, missing
database) plus the inline-index DDL.
`docker compose -f docker-compose.yml config -q` renders without any mirror
variables; adding `-f docker-compose.analytics.yml` renders
`TRACKING_MYSQL_URL: mysql://…@mysql:3306/restaurant_manager`.
