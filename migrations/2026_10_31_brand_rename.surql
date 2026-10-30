-- Brand rename: no identifier may still carry the old project name.
--
-- Scope of this patch (all idempotent — safe to re-run, and a no-op on a fresh
-- install where 2026_08_03 has already created the new names):
--   1. `posr_id` -> `local_id` on integration_entity_mapping (+ its UNIQUE index)
--      and on integration_sync_failure.
--   2. Stored config value `posr_to_external` -> `local_to_external` inside
--      integration_provider_config.values. The app also normalises the legacy
--      value on read, so a database that has not been patched yet still works.
--
-- The SurrealDB namespace/database name itself (`posr` -> `restaurant_manager`)
-- is NOT renamed here: SurrealDB has no RENAME NAMESPACE, so that move needs a
-- data export/import. Run `node scripts/rename-surreal-namespace.mjs` for it.

-- 1. integration_entity_mapping -------------------------------------------------
DEFINE FIELD IF NOT EXISTS local_id ON integration_entity_mapping TYPE string;

-- The old field is `TYPE string`, and Surreal rejects both `SET x = NONE` and
-- `UNSET x` while that type stands ("Expected string but found NONE"). Relaxing
-- it to an option first, then UNSET, then REMOVE is the sequence that actually
-- clears the stored value — measured on a live surrealdb:v3.0.5 against both a
-- SCHEMALESS and a SCHEMAFULL table. `REMOVE FIELD` alone does NOT strip values
-- already written on a SCHEMALESS or SCHEMAFULL row.
DEFINE FIELD OVERWRITE posr_id ON integration_entity_mapping TYPE option<string | null>;

UPDATE integration_entity_mapping
  SET local_id = posr_id
  WHERE local_id = NONE AND posr_id != NONE;

UPDATE integration_entity_mapping UNSET posr_id WHERE posr_id != NONE;
REMOVE FIELD IF EXISTS posr_id ON integration_entity_mapping;
REMOVE INDEX IF EXISTS idx_entity_mapping_posr ON integration_entity_mapping;

DEFINE INDEX IF NOT EXISTS idx_entity_mapping_local ON integration_entity_mapping
  FIELDS provider_id, tenant_id, entity_type, local_id UNIQUE;

-- 2. integration_sync_failure --------------------------------------------------
DEFINE FIELD IF NOT EXISTS local_id ON integration_sync_failure TYPE string;
DEFINE FIELD OVERWRITE posr_id ON integration_sync_failure TYPE option<string | null>;

UPDATE integration_sync_failure
  SET local_id = posr_id
  WHERE local_id = NONE AND posr_id != NONE;

UPDATE integration_sync_failure UNSET posr_id WHERE posr_id != NONE;
REMOVE FIELD IF EXISTS posr_id ON integration_sync_failure;

-- 3. Stored sync-direction enum ------------------------------------------------
UPDATE integration_provider_config
  SET values.syncDirection = 'local_to_external'
  WHERE values.syncDirection = 'posr_to_external';
