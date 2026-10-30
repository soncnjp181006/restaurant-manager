import { beforeEach, describe, expect, it } from 'vitest';
import { clear, createStore, entries, get, set } from 'idb-keyval';
import {
  AI_REPORT_FORMAT_KEY,
  AI_REPORT_HISTORY_KEY,
  AI_REPORT_PROMPT_KEY,
} from '@/lib/ai.report.storage.ts';
import { POS_STORE_DB_NAME, PosStoreDatabase, getPosStoreDatabase } from '@/infrastructure/pos-store/db.ts';
import { LEGACY_STORAGE_NAMES, migrateLegacyStorage } from '@/lib/legacy-storage.ts';

/**
 * Every assertion below spells the NEW names out as literals instead of reading
 * them from the module under test. That is the negative control: if a new name
 * is mistyped or "improved" (e.g. `restaurant-manager-terminal-posstore`), the
 * copy lands somewhere the app never reads and these tests go red.
 */

const LEGACY_POSSTORE_DB = 'posr-terminal-posstore';

class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

let local = new MemoryStorage();
let session = new MemoryStorage();

function installStorages(): void {
  local = new MemoryStorage();
  session = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: local, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: session, configurable: true, writable: true });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

async function listDatabaseNames(): Promise<string[]> {
  const databases = await indexedDB.databases();
  return databases.map((database) => database.name ?? '');
}

async function seedLegacyPosStore(): Promise<void> {
  const legacy = new PosStoreDatabase(LEGACY_POSSTORE_DB);
  await legacy.table('orders').clear();
  await legacy.table('catalog').clear();
  await legacy.table('orders').bulkPut([
    { id: 'order-1', status: 'open', server_version: 1 },
    { id: 'order-2', status: 'closed', server_version: 2 },
  ]);
  await legacy.table('catalog').bulkPut([{ id: 'item-1', table: 'menu_item' }]);
  legacy.close();
}

beforeEach(() => {
  installStorages();
});

describe('legacy brand migration — cold browser', () => {
  it('does nothing when no legacy data exists', async () => {
    const before = await listDatabaseNames();

    await migrateLegacyStorage();

    expect(local.keys()).toEqual([]);
    expect(session.keys()).toEqual([]);
    // Probing must not create the retired databases either.
    const after = await listDatabaseNames();
    expect(after.filter((name) => name.startsWith('posr'))).toEqual([]);
    expect(after.sort()).toEqual(before.sort());
  });
});

describe('legacy brand migration — web storage', () => {
  it('copies legacy keys to the new names and keeps the old ones', async () => {
    local.setItem('posr_docs_tableless_leak_recovered', '1');
    local.setItem('posr-ai-report-history', '[{"prompt":"sales","format":"table"}]');
    local.setItem('posr-db-connected-once', '1');
    session.setItem('posr-ai-report-prompt', 'draft prompt');
    session.setItem('posr-ai-report-format', 'chart');

    await migrateLegacyStorage();

    expect(local.getItem('restaurant_manager_docs_tableless_leak_recovered')).toBe('1');
    expect(local.getItem('restaurant-manager-ai-report-history')).toBe('[{"prompt":"sales","format":"table"}]');
    expect(local.getItem('restaurant-manager-db-connected-once')).toBe('1');
    expect(session.getItem('restaurant-manager-ai-report-prompt')).toBe('draft prompt');
    expect(session.getItem('restaurant-manager-ai-report-format')).toBe('chart');
    // The previous brand copy is never deleted.
    expect(local.getItem('posr_docs_tableless_leak_recovered')).toBe('1');
    expect(local.getItem('posr-ai-report-history')).toBe('[{"prompt":"sales","format":"table"}]');
  });

  it('never overwrites a new key that already holds a value (second run)', async () => {
    local.setItem('posr-ai-report-history', '[{"prompt":"old"}]');
    await migrateLegacyStorage();
    // The user works on the copied value, then the pass runs again.
    local.setItem('restaurant-manager-ai-report-history', '[{"prompt":"edited after rename"}]');
    local.setItem('posr_docs_tableless_leak_recovered', '1');

    await migrateLegacyStorage();

    expect(local.getItem('restaurant-manager-ai-report-history')).toBe('[{"prompt":"edited after rename"}]');
    expect(local.getItem('restaurant_manager_docs_tableless_leak_recovered')).toBe('1');
  });

  it('does not invent new names beyond the contract mapping', async () => {
    local.setItem('posr_docs_tableless_leak_recovered', '1');
    await migrateLegacyStorage();
    // Plausible-but-wrong variants must stay empty.
    expect(local.getItem('restaurant-manager_docs_tableless_leak_recovered')).toBeNull();
    expect(local.getItem('restaurant-manager-ai-report-history')).toBeNull();
    expect(local.getItem('posr_docs_tableless_leak_recovered')).toBe('1');
  });
});

describe('legacy brand migration — idb-keyval databases', () => {
  it('moves jotai and assistant conversations into the renamed databases', async () => {
    await set('terminal', { preset: 'hybrid' }, createStore('posr-react', 'jotai-storage'));
    await set(
      'conversation:user-1',
      { entries: [{ role: 'user', content: 'hi' }], history: [], updatedAt: 'now' },
      createStore('posr-react-ai-assistant', 'keyval'),
    );

    await migrateLegacyStorage();

    expect(await get('terminal', createStore('restaurant-manager', 'jotai-storage'))).toEqual({
      preset: 'hybrid',
    });
    expect(
      await get('conversation:user-1', createStore('restaurant-manager-ai-assistant', 'keyval')),
    ).toMatchObject({ entries: [{ role: 'user', content: 'hi' }] });
    // Nothing lands on a wrong variant name, and the legacy store survives.
    expect(await get('terminal', createStore('restaurant-manager-react', 'jotai-storage'))).toBeUndefined();
    expect(await get('terminal', createStore('posr-react', 'jotai-storage'))).toEqual({ preset: 'hybrid' });

    await clear(createStore('posr-react', 'jotai-storage'));
    await clear(createStore('restaurant-manager', 'jotai-storage'));
    await clear(createStore('posr-react-ai-assistant', 'keyval'));
    await clear(createStore('restaurant-manager-ai-assistant', 'keyval'));
  });

  it('does not replace keys already written under the new integration store', async () => {
    await set('qbo', { token: 'legacy' }, createStore('posr-react-integration-secrets', 'keyval'));
    await set('qbo', { token: 'fresh' }, createStore('restaurant-manager-integration-secrets', 'keyval'));

    await migrateLegacyStorage();

    expect(await get('qbo', createStore('restaurant-manager-integration-secrets', 'keyval'))).toEqual({
      token: 'fresh',
    });
    expect(await get('qbo', createStore('posr-react-integration-secrets', 'keyval'))).toEqual({
      token: 'legacy',
    });

    await clear(createStore('posr-react-integration-secrets', 'keyval'));
    await clear(createStore('restaurant-manager-integration-secrets', 'keyval'));
  });
});

describe('legacy brand migration — Dexie PosStore', () => {
  it('uses the contracted database name', () => {
    expect(POS_STORE_DB_NAME).toBe('restaurant-terminal-posstore');
    expect(LEGACY_STORAGE_NAMES[LEGACY_POSSTORE_DB]).toBe('restaurant-terminal-posstore');
  });

  it('copies every non-empty legacy table into the new empty database', async () => {
    await seedLegacyPosStore();

    await migrateLegacyStorage();

    const probe = new PosStoreDatabase('restaurant-terminal-posstore');
    expect(await probe.table('orders').count()).toBe(2);
    expect(await probe.table('catalog').count()).toBe(1);
    expect(await probe.table('orders').get('order-1')).toMatchObject({ status: 'open' });
    probe.close();

    const legacy = new PosStoreDatabase(LEGACY_POSSTORE_DB);
    expect(await legacy.table('orders').count()).toBe(2);
    legacy.close();
  });

  it('leaves rows the terminal already wrote alone on the second run', async () => {
    const live = getPosStoreDatabase();
    expect(await live.table('orders').count()).toBe(2);

    // Offline work continues under the new name, and the old database grows too.
    await live.table('orders').put({ id: 'order-1', status: 'mutated-by-cashier', server_version: 9 });
    const legacy = new PosStoreDatabase(LEGACY_POSSTORE_DB);
    await legacy.table('orders').put({ id: 'order-3', status: 'open', server_version: 3 });
    legacy.close();

    await migrateLegacyStorage();

    expect(await live.table('orders').get('order-1')).toMatchObject({
      status: 'mutated-by-cashier',
      server_version: 9,
    });
    expect(await live.table('orders').count()).toBe(2);
    await live.table('orders').clear();
    await live.table('catalog').clear();
    await deleteDatabase(LEGACY_POSSTORE_DB);
  });
});

describe('LEGACY_STORAGE_NAMES mapping', () => {
  it('maps every retired browser name to its contracted successor', () => {
    expect(LEGACY_STORAGE_NAMES).toMatchObject({
      'posr-terminal-posstore': 'restaurant-terminal-posstore',
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
  });

  it('maps to exactly the names the app now reads', () => {
    // Drift guard: the copy is useless if the migration target and the module
    // constant ever disagree, so compare them instead of trusting either.
    expect(LEGACY_STORAGE_NAMES['posr-ai-report-history']).toBe(AI_REPORT_HISTORY_KEY);
    expect(LEGACY_STORAGE_NAMES['posr-ai-report-format']).toBe(AI_REPORT_FORMAT_KEY);
    expect(LEGACY_STORAGE_NAMES['posr-ai-report-prompt']).toBe(AI_REPORT_PROMPT_KEY);
    expect(LEGACY_STORAGE_NAMES['posr-terminal-posstore']).toBe(POS_STORE_DB_NAME);
  });

  it('does not revive legacy session tokens', () => {
    // Contract item 6: the old JWT issuer no longer verifies, so a copy would
    // resurrect an invalid token instead of forcing a clean re-login.
    expect(LEGACY_STORAGE_NAMES['posr_session_token']).toBeUndefined();
    expect(LEGACY_STORAGE_NAMES['posr_surreal_token']).toBeUndefined();
  });

  it('exposes no legacy name as a target', async () => {
    const targets = Object.values(LEGACY_STORAGE_NAMES);
    expect(targets.filter((name) => name.includes('posr'))).toEqual([]);
    expect(await entries(createStore('posr-react', 'jotai-storage'))).toEqual([]);
  });
});
