-- 2026_10_31_optional_array_null.surql
-- Restore the declared nullability of optional array fields.
--
-- The baseline importer rewrites `none | array<T> | null` into `option<array<T>>`
-- (on SurrealDB 3.x a `field.*` wildcard cannot follow that top-level union), and
-- `option<array<T>>` prints as `none | array<T>` — it rejects an explicit NULL.
-- Frontend writers, generated from dumps that kept `. | null`, do send NULL (the
-- payment-type form sends `discounts: null`), so on every fresh database those saves
-- failed with "Couldn't coerce value for field ... Expected none | array<...> but
-- found NULL". Each declaration below re-applies the documented nullable union with
-- OVERWRITE, which SurrealDB 3.x accepts even when the element wildcard already
-- exists: NULL and [] become valid again, the element type stays enforced, and no
-- stored value is rewritten. Idempotent — safe to re-run.

-- account_journal_entry.documents (declared in migrations/latest.surql:67)
DEFINE FIELD OVERWRITE documents ON account_journal_entry TYPE none | array<record<document>> | null PERMISSIONS FULL;
-- account_journal_entry.lines (declared in migrations/latest.surql:75)
DEFINE FIELD OVERWRITE lines ON account_journal_entry TYPE none | array<record<account_journal_line>> | null PERMISSIONS FULL;
-- coupon.valid_days (declared in migrations/latest.surql:387)
DEFINE FIELD OVERWRITE valid_days ON coupon TYPE none | array<string> | null PERMISSIONS FULL;
-- customer.addresses (declared in migrations/latest.surql:414)
DEFINE FIELD OVERWRITE addresses ON customer TYPE none | array<record<customer_address>> | null PERMISSIONS FULL;
-- discount.applicable_floors (declared in migrations/latest.surql:504)
DEFINE FIELD OVERWRITE applicable_floors ON discount TYPE none | array<record<floor>> | null DEFAULT [] PERMISSIONS FULL;
-- extras.order_types (declared in migrations/latest.surql:698)
DEFINE FIELD OVERWRITE order_types ON extras TYPE none | array<record<order_type>> | null PERMISSIONS FULL;
-- extras.payment_types (declared in migrations/latest.surql:700)
DEFINE FIELD OVERWRITE payment_types ON extras TYPE none | array<record<payment_type>> | null PERMISSIONS FULL;
-- extras.tables (declared in migrations/latest.surql:702)
DEFINE FIELD OVERWRITE tables ON extras TYPE none | array<record<floor_table>> | null PERMISSIONS FULL;
-- floor_table.categories (declared in migrations/latest.surql:733)
DEFINE FIELD OVERWRITE categories ON floor_table TYPE none | array<record<category>> | null PERMISSIONS FULL;
-- floor_table.order_types (declared in migrations/latest.surql:745)
DEFINE FIELD OVERWRITE order_types ON floor_table TYPE none | array<record<order_type>> | null PERMISSIONS FULL;
-- floor_table.payment_types (declared in migrations/latest.surql:747)
DEFINE FIELD OVERWRITE payment_types ON floor_table TYPE none | array<record<payment_type>> | null PERMISSIONS FULL;
-- inventory_issue_return.documents (declared in migrations/latest.surql:1170)
DEFINE FIELD OVERWRITE documents ON inventory_issue_return TYPE none | array<record<document>> | null PERMISSIONS FULL;
-- inventory_issue.documents (declared in migrations/latest.surql:1109)
DEFINE FIELD OVERWRITE documents ON inventory_issue TYPE none | array<record<document>> | null PERMISSIONS FULL;
-- inventory_item_waste_item.documents (declared in migrations/latest.surql:1305)
DEFINE FIELD OVERWRITE documents ON inventory_item_waste_item TYPE none | array<string> | null PERMISSIONS FULL;
-- inventory_item_waste.documents (declared in migrations/latest.surql:1279)
DEFINE FIELD OVERWRITE documents ON inventory_item_waste TYPE none | array<record<document>> | null PERMISSIONS FULL;
-- inventory_item.stores (declared in migrations/latest.surql:1234)
DEFINE FIELD OVERWRITE stores ON inventory_item TYPE none | array<record<inventory_store>> | null PERMISSIONS FULL;
-- inventory_purchase_order.documents (declared in migrations/latest.surql:1463)
DEFINE FIELD OVERWRITE documents ON inventory_purchase_order TYPE none | array<record<document>> | null PERMISSIONS FULL;
-- inventory_purchase_return.documents (declared in migrations/latest.surql:1529)
DEFINE FIELD OVERWRITE documents ON inventory_purchase_return TYPE none | array<record<document>> | null PERMISSIONS FULL;
-- inventory_purchase.documents (declared in migrations/latest.surql:1386)
DEFINE FIELD OVERWRITE documents ON inventory_purchase TYPE none | array<record<document>> | null PERMISSIONS FULL;
-- inventory_supplier.payments (declared in migrations/latest.surql:1594)
DEFINE FIELD OVERWRITE payments ON inventory_supplier TYPE none | array<record<inventory_purchase_payment>> | null PERMISSIONS FULL;
-- inventory_supplier.purchases (declared in migrations/latest.surql:1597)
DEFINE FIELD OVERWRITE purchases ON inventory_supplier TYPE none | array<record<inventory_purchase>> | null PERMISSIONS FULL;
-- kitchen.printers (declared in migrations/latest.surql:1632)
DEFINE FIELD OVERWRITE printers ON kitchen TYPE none | array<record<printer>> | null PERMISSIONS FULL;
-- menu_item.items (declared in migrations/latest.surql:1956)
DEFINE FIELD OVERWRITE items ON menu_item TYPE none | array<record<menu_item_recipe>> | null PERMISSIONS FULL;
-- menu_menu_item.taxes (declared in migrations/latest.surql:2018)
DEFINE FIELD OVERWRITE taxes ON menu_menu_item TYPE none | array<record<tax>> | null PERMISSIONS FULL;
-- order_item.taxes (declared in migrations/latest.surql:2228)
DEFINE FIELD OVERWRITE taxes ON order_item TYPE none | array<record<tax>> | null PERMISSIONS FULL;
-- order.extras (declared in migrations/latest.surql:2096)
DEFINE FIELD OVERWRITE extras ON order TYPE none | array<record<order_extras>> | null PERMISSIONS FULL;
-- order.order_discounts (declared in migrations/latest.surql:2105)
DEFINE FIELD OVERWRITE order_discounts ON order TYPE none | array<record<order_discount>> | null PERMISSIONS FULL;
-- order.order_taxes (declared in migrations/latest.surql:2107)
DEFINE FIELD OVERWRITE order_taxes ON order TYPE none | array<record<order_tax>> | null PERMISSIONS FULL;
-- order.payments (declared in migrations/latest.surql:2112)
DEFINE FIELD OVERWRITE payments ON order TYPE none | array<record<order_payment>> | null PERMISSIONS FULL;
-- order.tags (declared in migrations/latest.surql:2121)
DEFINE FIELD OVERWRITE tags ON order TYPE none | array<string> | null PERMISSIONS FULL;
-- payment_type.discounts (declared in migrations/latest.surql:2420)
DEFINE FIELD OVERWRITE discounts ON payment_type TYPE none | array<record<discount>> | null PERMISSIONS FULL;
-- user.branch_ids (declared in migrations/latest.surql:3173)
DEFINE FIELD OVERWRITE branch_ids ON user TYPE none | array<string> | null PERMISSIONS FULL;
