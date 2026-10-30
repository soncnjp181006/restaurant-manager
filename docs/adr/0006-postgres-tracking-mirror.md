# ADR 0006: PostgreSQL as an analytical mirror of the tracking log — only that part

## Status

Accepted — 2026-10-30

## Context

SurrealDB is the system of record (ADR 0001, ADR 0002). One table does not fit
that shape well: `tracking`. It is append-mostly, written by every sidecar
client through `tracking-api`, and read back with `SELECT * FROM tracking` in
the activity report, the order-lifecycle report, the sales dashboard, the cash
audit and order detail. Analytical queries over it (grouping by `page`/`module`
over a date range) are the kind of work a relational engine with a real query
planner does better, and SQL is what analysts and BI tools already speak.

Two constraints narrow the design:

1. **Nothing already written may change meaning.** `migrations/` (47-entry
   runner plan + the `.surql` files) and the Surreal permissions are off-limits.
2. **Every existing read path must keep working.** Reports read `tracking` from
   SurrealDB; moving those reads would mean rewriting SurrealQL in six screens
   and the AI schema description for no user-visible gain.

So the ask "use PostgreSQL" can only be honest as a *partial* adoption.

## Decision

1. **Scope: the tracking mirror only.** `tracking-api` additionally writes each
   ingested event into a PostgreSQL table `tracking_events`. Orders, menu,
   inventory, HR, accounting, sessions, PosStore outbox — all stay in SurrealDB.
2. **SurrealDB stays authoritative.** `tracking.service.js` performs the same
   `CREATE type::record` / `CREATE type::table` query as before and returns the
   same value to the route. The mirror happens after that write and its outcome
   is not part of the API response.
3. **Opt-in by environment.** `TRACKING_PG_URL` (libpq URL) or
   `TRACKING_PG_HOST/PORT/DB/USER/PASS` enable it; blank means no `pg.Pool` is
   ever constructed and no connection is attempted. Nothing to turn off later.
4. **A mirror failure cannot fail ingestion.** `writeTrackingEvent()` returns
   `{ written, reason }` instead of throwing. The service logs the reason and
   increments a counter that `GET /health` exposes as `pgMirror` /
   `pgMirrorFailures`, so a silently dead mirror is visible to operators.
5. **Idempotent, non-destructive DDL.** `CREATE TABLE IF NOT EXISTS` plus two
   indexes (`created_at`, `(module, created_at)`) mirror the Surreal index set in
   `2026_08_30_hot_path_indexes.surql`. Applied on first use; no migration
   framework, nothing in `migrations/`.
6. **Key semantics follow Surreal.** A client id matching `^[a-zA-Z0-9_-]{1,128}$`
   becomes `tracking_id` and is upserted (`ON CONFLICT DO UPDATE`) because
   Surreal's `CREATE type::record` overwrites. Anything else gets a generated
   UUID, and the rejected raw value is preserved inside the `payload` jsonb so
   the copy loses no information.
7. **Local infra is a separate compose file** (`docker-compose.analytics.yml`),
   not a service in `docker-compose.yml`. Compose interpolates `${VAR:?}` for
   every service in a file even when a profile hides it, so required mirror
   credentials in the main file would break `docker compose up` for every
   developer who does not run Postgres. The mirror container publishes on
   loopback only, matching the gateway precedent.

## Consequences

- Reports do **not** read Postgres. Adding SQL analytics is a separate, later
  decision; today the mirror exists so that data is available in a relational
  form, not because a screen consumes it.
- Dual-write means the two copies can diverge when Postgres is down. The
  divergence is one-directional and detectable (`pgMirrorFailures`), and the
  Surreal copy remains complete, so a rebuild is possible by replaying from
  `tracking`.
- `pg` is a new dependency of `tracking-api` only — the browser bundle and the
  other five sidecars are untouched.
- The `tracking_events` table is disposable: dropping it and restarting
  `tracking-api` re-creates it, and no app behaviour depends on it existing.

## Verification

- `npm run test:tracking` (`node --test tracking-api/src`) — 26 pass, 2 skip
  when no PostgreSQL is configured; the skips are visible in the reporter, not
  hidden.
- Against a live `postgres:16-alpine` container, all 28 pass, including
  `tracking-api/src/postgres-store.test.js` (env gating, id policy, unsafe-id
  rejection, unreachable-host failure accounting, retry after a failed
  bootstrap) and `tracking-api/src/services/tracking.service.test.js` (Surreal
  query unchanged, unchanged route result, mirror row read back with
  `page`/`user_id`/`module` columns and the nested `payload` jsonb, upsert
  overwrite on a repeated client id).
- `docker compose config -q` on the default file: Postgres absent, stack
  renders. Merged with `docker-compose.analytics.yml` and no credentials:
  fails with "Set TRACKING_PG_USER in .env". Merged with credentials: renders
  `TRACKING_PG_URL: postgresql://…@postgres:5432/tracking`.
