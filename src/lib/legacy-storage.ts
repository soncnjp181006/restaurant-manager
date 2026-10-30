import { createStore, entries, set as idbSet } from 'idb-keyval';
import {
  POS_STORE_DB_NAME,
  PosStoreDatabase,
  getPosStoreDatabase,
} from '@/infrastructure/pos-store/db.ts';

/**
 * One-shot, idempotent migration of browser state written by the previous brand
 * ("POSR"). Every `posr-*` / `posr_*` literal in this file is a name that is
 * ALREADY PHYSICALLY WRITTEN on our users' machines — in localStorage,
 * sessionStorage and in named IndexedDB databases. Those names cannot be
 * renamed in place, so this module is the single, deliberate place in the app
 * that still contains them: they are read-only source names for the copy pass.
 * Do not remove them, and do not add new `posr-*` names anywhere else.
 *
 * Rules (from scratch/rename-contract.md, "Tương thích ngược"):
 *  - copy old -> new only when the new name has no data yet;
 *  - never delete or mutate the old copy (a rollback must keep working);
 *  - never overwrite: user data written after the rename wins.
 *
 * Intentionally NOT migrated: `posr_session_token` / `posr_surreal_token`.
 * Contract item 6 accepts the forced re-login, and copying them would be worse
 * than dropping them — the stored JWT was signed with the retired
 * `posr-gateway` issuer, so reviving it only produces confusing 401 loops.
 *
 * `posr-terminal-sync-leader` is a `navigator.locks` name, not stored data: it
 * is listed in LEGACY_STORAGE_NAMES for completeness but has nothing to copy.
 */

/** Old browser-state name -> new browser-state name (contract items 6, 11). */
export const LEGACY_STORAGE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'posr-terminal-posstore': POS_STORE_DB_NAME,
  'posr-terminal-sync-leader': 'restaurant-terminal-sync-leader',
  'posr_docs_tableless_leak_recovered': 'restaurant_manager_docs_tableless_leak_recovered',
  'posr-db-connected-once': 'restaurant-manager-db-connected-once',
  'posr-ai-report-history': 'restaurant-manager-ai-report-history',
  'posr-ai-report-format': 'restaurant-manager-ai-report-format',
  'posr-ai-report-prompt': 'restaurant-manager-ai-report-prompt',
  'posr-react': 'restaurant-manager',
  'posr-react-ai-assistant': 'restaurant-manager-ai-assistant',
  'posr-react-integration-secrets': 'restaurant-manager-integration-secrets',
  'posr-react-integration-queue': 'restaurant-manager-integration-queue',
});

/** Keys already written to the user's localStorage. */
const LEGACY_LOCALSTORAGE_KEYS: readonly (readonly [string, string])[] = [
  ['posr_docs_tableless_leak_recovered', 'restaurant_manager_docs_tableless_leak_recovered'],
  ['posr-ai-report-history', 'restaurant-manager-ai-report-history'],
  ['posr-db-connected-once', 'restaurant-manager-db-connected-once'],
];

/** Keys already written to the user's sessionStorage (per-tab, still worth keeping). */
const LEGACY_SESSIONSTORAGE_KEYS: readonly (readonly [string, string])[] = [
  ['posr-ai-report-prompt', 'restaurant-manager-ai-report-prompt'],
  ['posr-ai-report-format', 'restaurant-manager-ai-report-format'],
  ['posr-db-connected-once', 'restaurant-manager-db-connected-once'],
];

/** Named IndexedDB databases written by idb-keyval: {legacy, new, store}. */
const LEGACY_KEYVAL_STORES: readonly { legacyDb: string; newDb: string; store: string }[] = [
  { legacyDb: 'posr-react', newDb: 'restaurant-manager', store: 'jotai-storage' },
  { legacyDb: 'posr-react-ai-assistant', newDb: 'restaurant-manager-ai-assistant', store: 'keyval' },
  // Owned by src/integrations/** — listed here so the data survives either way.
  { legacyDb: 'posr-react-integration-secrets', newDb: 'restaurant-manager-integration-secrets', store: 'keyval' },
  { legacyDb: 'posr-react-integration-queue', newDb: 'restaurant-manager-integration-queue', store: 'keyval' },
];

/** Legacy Dexie (PosStore) database name. */
const LEGACY_POSSTORE_DB = 'posr-terminal-posstore';

function storageOf(kind: 'local' | 'session'): Storage | null {
  try {
    const candidate = kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
    return candidate ?? null;
  } catch {
    // Private mode / disabled storage / plain node.
    return null;
  }
}

/** true only when the named IndexedDB database is already on disk. */
async function indexedDbExists(name: string): Promise<boolean> {
  const factory: IDBFactory | undefined = typeof indexedDB !== 'undefined' ? indexedDB : undefined;
  if (!factory) return false;
  if (typeof factory.databases !== 'function') return true; // cannot probe -> try, guarded below
  try {
    const databases = await factory.databases();
    return databases.some((database) => database.name === name);
  } catch {
    return true;
  }
}

/** Copy one storage entry unless the new name already holds a value. */
function copyStorageEntry(storage: Storage, from: string, to: string): void {
  try {
    if (storage.getItem(to) !== null) return;
    const raw = storage.getItem(from);
    if (raw === null) return;
    storage.setItem(to, raw);
  } catch {
    // Unreadable entry (quota, private mode) — the app falls back to defaults.
  }
}

async function migrateStorage(
  kind: 'local' | 'session',
  pairs: readonly (readonly [string, string])[],
): Promise<void> {
  const storage = storageOf(kind);
  if (!storage) return;
  for (const [from, to] of pairs) copyStorageEntry(storage, from, to);
}

/**
 * Dexie copy: open the legacy PosStore database under its old name and move each
 * non-empty table into the live database, table by table, only where the target
 * table is still empty. The legacy database keeps all of its rows.
 */
async function migratePosStore(): Promise<void> {
  if (!(await indexedDbExists(LEGACY_POSSTORE_DB))) return;

  const legacy = new PosStoreDatabase(LEGACY_POSSTORE_DB);
  const target = getPosStoreDatabase();
  try {
    for (const table of legacy.tables) {
      const rows = await table.toArray();
      if (rows.length === 0) continue;
      const incoming = target.tables.find((candidate) => candidate.name === table.name);
      if (!incoming) continue;
      if ((await incoming.count()) > 0) continue; // new database already in use
      await incoming.bulkPut(rows);
    }
  } catch {
    // Legacy schema too old / store missing: the sync engine re-downloads on boot.
  } finally {
    legacy.close();
  }
}

/** idb-keyval copy: per key, write only keys the new store does not have yet. */
async function migrateKeyvalDatabases(): Promise<void> {
  for (const { legacyDb, newDb, store } of LEGACY_KEYVAL_STORES) {
    if (!(await indexedDbExists(legacyDb))) continue;
    const source = createStore(legacyDb, store);
    const target = createStore(newDb, store);
    try {
      const legacyEntries = await entries(source);
      if (legacyEntries.length === 0) continue;
      const existingKeys = new Set((await entries(target)).map(([key]) => key));
      for (const [key, value] of legacyEntries) {
        if (existingKeys.has(key)) continue;
        await idbSet(key, value, target);
      }
    } catch {
      // Unreadable legacy store — leave the new store at its defaults.
    }
  }
}

let inFlight: Promise<void> | null = null;

/**
 * Runs the whole copy pass once. Concurrent calls share the same pass, and a
 * later call is harmless: every copy is skipped when the new name already has
 * data, so nothing is ever overwritten or deleted.
 */
export function migrateLegacyStorage(): Promise<void> {
  if (!inFlight) {
    inFlight = (async () => {
      await migrateStorage('local', LEGACY_LOCALSTORAGE_KEYS);
      await migrateStorage('session', LEGACY_SESSIONSTORAGE_KEYS);
      await migrateKeyvalDatabases();
      await migratePosStore();
    })()
      .catch((error) => {
        // Boot must never depend on a legacy copy succeeding.
        console.warn('[legacy-storage] brand rename migration skipped', error);
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}
