import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickBooksProvider } from '@/integrations/providers/accounting/quickbooks/provider.ts';

/**
 * Ledgers synced before the rename already contain an item named "POSR Sale".
 * Lookups must try the new name first and reuse the legacy item instead of
 * creating a second, duplicated item on the customer's QuickBooks ledger.
 */
const { qboState } = vi.hoisted(() => {
  const state = {
    items: [] as Array<{ Id: string; Name: string; Type: string }>,
    calls: [] as Array<{ method: string; path: string; body?: any; query?: any }>,
  };
  return { qboState: state };
});

vi.mock('@/integrations/providers/accounting/quickbooks/client-bridge.ts', () => ({
  proxyQboRequest: async (params: any) => {
    qboState.calls.push(params);
    if (params.method === 'POST' && params.path === '/item') {
      return { Item: { Id: 'CREATED-1' } };
    }
    if (params.path === '/query') {
      const sql = String(params.query?.query ?? '');
      if (sql.includes('FROM Item')) {
        return { QueryResponse: { Item: qboState.items } };
      }
      if (sql.includes('FROM Account')) {
        return { QueryResponse: { Account: [{ Id: 'ACC-1', Name: 'Sales', AccountType: 'Income' }] } };
      }
      return { QueryResponse: {} };
    }
    return {};
  },
  refreshToken: async () => {},
  getConnectionStatus: async () => ({ connected: true }),
}));

/** Fake Surreal client: returns entity-mapping rows and accepts config writes. */
const createFakeDb = (mappingRows: any[]) => {
  const queries: Array<{ sql: string; parameters?: Record<string, unknown> }> = [];
  return {
    queries,
    query: async (sql: string, parameters?: Record<string, unknown>) => {
      queries.push({ sql, parameters });
      if (sql.includes('FROM integration_entity_mapping')) return [mappingRows];
      if (sql.includes('FROM setting')) return [[{ id: 'setting:1' }]];
      return [[]];
    },
    create: async () => ({}),
    merge: async () => ({}),
  };
};

const providerFor = (raw: Record<string, unknown> = { tenantId: 'realm-1' }) => {
  const provider = new QuickBooksProvider();
  provider.setConfigLoader(async () => raw);
  return provider;
};

const createdItemBodies = () =>
  qboState.calls
    .filter((c) => c.method === 'POST' && c.path === '/item')
    .map((c) => c.body);

describe('legacy "POSR Sale" item compatibility', () => {
  beforeEach(() => {
    qboState.items = [];
    qboState.calls = [];
  });

  it('reuses the legacy-named item during initial sync instead of creating one', async () => {
    qboState.items = [
      { Id: '500', Name: 'Burger', Type: 'Service' },
      { Id: '900', Name: 'POSR Sale', Type: 'Service' },
    ];

    const result = await (providerFor() as any).adapter.importMasterData({ tenantId: 'realm-1' });

    expect(result.saleItemId).toBe('900');
    expect(createdItemBodies()).toHaveLength(0);
  });

  it('prefers the new name when both names exist on the ledger', async () => {
    qboState.items = [
      { Id: '900', Name: 'POSR Sale', Type: 'Service' },
      { Id: '950', Name: 'Restaurant Manager Sale', Type: 'Service' },
    ];

    const result = await (providerFor() as any).adapter.importMasterData({ tenantId: 'realm-1' });

    expect(result.saleItemId).toBe('950');
    expect(createdItemBodies()).toHaveLength(0);
  });

  it('creates the item under the new name when neither name exists', async () => {
    qboState.items = [{ Id: '500', Name: 'Burger', Type: 'Service' }];

    const result = await (providerFor() as any).adapter.importMasterData({ tenantId: 'realm-1' });

    expect(result.saleItemId).toBe('CREATED-1');
    expect(createdItemBodies()).toEqual([
      expect.objectContaining({ Name: 'Restaurant Manager Sale', Type: 'Service' }),
    ]);
  });

  it('reuses an entity-mapping row saved under the legacy item name', async () => {
    const db = createFakeDb([{ external_id: '900', external_payload: { name: 'POSR Sale' } }]);
    const provider = providerFor();
    provider.setDbLoader(() => db as any);

    const saleItemId = await (provider as any).resolveSaleItemId('realm-1', await provider.getConfigParsed());

    expect(saleItemId).toBe('900');
    expect(createdItemBodies()).toHaveLength(0);
    // the resolved id is cached back onto the provider config
    expect(db.queries.some((q) => q.sql.includes('UPDATE'))).toBe(true);
  });

  it('reuses a live QBO item found by the legacy name', async () => {
    qboState.items = [{ Id: '900', Name: 'POSR Sale', Type: 'Service' }];
    const provider = providerFor();

    const saleItemId = await (provider as any).resolveSaleItemId('realm-1', await provider.getConfigParsed());

    expect(saleItemId).toBe('900');
    expect(createdItemBodies()).toHaveLength(0);
  });
});
