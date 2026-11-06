-- Tips ("Chia tiền boa") is removed as a feature: no payment-screen input, no
-- distribution screen, no report, no print line, no schema field.
--
-- Scope (idempotent — safe to re-run, and a no-op on a fresh database where
-- latest.surql no longer declares any of this):
--   1. `order.tip`, `order.tip_amount`, `order.tip_type` — stored values dropped,
--      then the field definitions. Grand totals are no longer computed with a tip
--      component, so leaving the fields would leave money figures that nothing
--      writes and reports would still be able to select.
--   2. `payroll_snapshot.tips` — same, for snapshots already written.
--   3. `tip_distribution` and `tip_distribution_user_share` — rows deleted, then
--      the tables removed.
--   4. the `tip_distribution` `setting` row (the saved payout weights).
--   5. tips tokens still inside stored `user_role.roles` arrays are handled by
--      backfill-strip-tips-role-modules.cjs — a SurrealQL expression cannot filter
--      one element out of a stored array here. Those tokens are already inert:
--      the permission tree is built from access.rules, which no longer defines
--      `tips`, `tips.calculation`, `tips.payout`, `reports.tips`,
--      `orders.apply_tips`, `admin.tips_definition*` or `reports.tip_analytics`.
--
-- NOT done here, and why:
--   - the 'Tips' account in the chart of accounts. It was only ever a demo seed
--     row (removed from demo-data.surql), but on a database that posted journal
--     lines to it, deleting the account would leave those postings pointing at a
--     record that no longer exists and break the trial balance. Historic postings
--     keep reconciling against an account nobody posts to any more — the
--     accounting templates that referenced it are gone from the code.
--   - `service_charge` / `service_charges` fields and settings: service charge is
--     a different feature and stays exactly as it was.

-- 1. order ---------------------------------------------------------------------
UPDATE order UNSET tip WHERE tip != NONE;
UPDATE order UNSET tip_amount WHERE tip_amount != NONE;
UPDATE order UNSET tip_type WHERE tip_type != NONE;

REMOVE FIELD tip ON order;
REMOVE FIELD tip_amount ON order;
REMOVE FIELD tip_type ON order;

-- 2. payroll_snapshot ------------------------------------------------------------
UPDATE payroll_snapshot UNSET tips WHERE tips != NONE;
REMOVE FIELD tips ON payroll_snapshot;

-- 3. distribution tables ---------------------------------------------------------
DELETE FROM tip_distribution_user_share;
DELETE FROM tip_distribution;

REMOVE TABLE IF EXISTS tip_distribution_user_share;
REMOVE TABLE IF EXISTS tip_distribution;

-- 4. saved distribution weights ---------------------------------------------------
DELETE FROM setting WHERE key = 'tip_distribution';
