-- Delivery is removed as a feature: no screen, no print job, no schema field.
--
-- Scope (idempotent — safe to re-run, and a no-op on a fresh database where
-- latest.surql no longer declares any of this):
--   1. `order.delivery` — stored value dropped, then the field definition.
--   2. `extra.delivery` — the "delivery only" service-charge flag (dynamic field
--      on the SCHEMALESS `extra` table, so only the stored value needs dropping).
--   3. `setting` rows: the delivery configuration keys are deleted; `map_center`
--      is renamed to `forecast_location` because the demand-forecast report still
--      needs a restaurant coordinate for its weather driver. Renaming keeps that
--      data instead of destroying a non-delivery feature.
--   4. print configuration: the "Delivery Print" row and the `copies.delivery`
--      entry inside the `print_options` row.
--   5. demo rows: the Delivery order type, the Delivery/Rider roles, the Rider user.
--
-- NOT done here, and why:
--   - `REMOVE FUNCTION fn::delivery_menu` — dbproxy's parser rejects `::` in that
--     position, and the proxy never stored the function (DEFINE FUNCTION is a
--     no-op there), so there is nothing to remove on the MySQL runtime. Databases
--     that ran 2026_09_05 on real SurrealDB keep an unused function; nothing in
--     the app calls it any more.
--   - delivery/rider tokens still inside stored `user_role.roles` arrays — a
--     SurrealQL expression cannot filter an array element here, so
--     backfill-strip-delivery-role-modules.cjs does it. Those tokens are already
--     inert: the permission list is built from access.rules, which no longer
--     defines them.

-- 1. order ---------------------------------------------------------------------
UPDATE order UNSET delivery WHERE delivery != NONE;
REMOVE FIELD delivery ON order;

-- 2. extra ---------------------------------------------------------------------
UPDATE extra UNSET delivery WHERE delivery != NONE;

-- 3. settings ------------------------------------------------------------------
UPDATE setting SET key = 'forecast_location' WHERE key = 'map_center';

DELETE FROM setting WHERE key IN [
  'enable_delivery',
  'delivery_charges',
  'minimum_order',
  'delivery_timing',
  'delivery_menu',
  'delivery_time',
  'delivery_banners'
];

-- 4. print configuration -------------------------------------------------------
DELETE FROM setting WHERE key = 'Delivery Print';
UPDATE setting UNSET value.copies.delivery WHERE key = 'print_options';

-- 5. demo rows -----------------------------------------------------------------
DELETE FROM order_type WHERE name = 'Delivery';
DELETE FROM user_role WHERE name IN ['Delivery', 'Rider', 'Riders'];
DELETE FROM user WHERE first_name = 'Rider';
