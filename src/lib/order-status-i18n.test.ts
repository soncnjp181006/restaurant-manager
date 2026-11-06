import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OrderStatus } from '@/api/model/order';
import { OrderVoidReason } from '@/api/model/order_void';
import { ORDER_STATUS_I18N_KEY, VOID_REASON_I18N_KEY } from '@/lib/order';

/**
 * Raw enum values used to leak into the UI: `OrderStatus.Pending` had no entry in
 * the translation map (and no locale key), so chips and dropdowns rendered
 * "Pending" in English on a Vietnamese terminal. Every enum member must map to a
 * key, and every key must exist in both locale files.
 */
describe('order statuses are localized', () => {
  const locales = ['en', 'vi'].map((lang) =>
    JSON.parse(readFileSync(path.resolve(__dirname, '../locales', lang, 'orders.json'), 'utf8')) as {
      status: Record<string, string>;
      voidReasons: Record<string, string>;
    }
  );

  it('every OrderStatus has an i18n key', () => {
    const missing = Object.values(OrderStatus).filter((status) => !ORDER_STATUS_I18N_KEY[status]);
    expect(missing).toEqual([]);
  });

  it('every status key exists in en and vi', () => {
    const missing = Object.entries(ORDER_STATUS_I18N_KEY).flatMap(([status, key]) =>
      locales
        // Keys are namespaced ("orders:status.paid") — strip the namespace too.
        .map((dict, index) => (dict.status[key!.replace('orders:status.', '')] ? null : `${['en', 'vi'][index]}: ${String(status)} -> ${key}`))
        .filter((entry): entry is string => entry !== null)
    );
    expect(missing).toEqual([]);
  });

  it('every void reason has a locale string in both languages', () => {
    const missing = Object.values(OrderVoidReason).flatMap((reason) => {
      const key = VOID_REASON_I18N_KEY[reason]?.replace('orders:voidReasons.', '');
      return locales
        .map((dict, index) => (key && dict.voidReasons[key] ? null : `${['en', 'vi'][index]}: voidReasons.${String(reason)}`))
        .filter((entry): entry is string => entry !== null);
    });
    expect(missing).toEqual([]);
  });

  it('purchase order statuses have report filter labels in both languages', () => {
    const keys = ['poStatusDraft', 'poStatusPendingApproval', 'poStatusApproved', 'poStatusFulfilled'];
    const missing = keys.flatMap((key) =>
      ['en', 'vi'].flatMap((lang) => {
        const dict = JSON.parse(
          readFileSync(path.resolve(__dirname, '../locales', lang, 'reports.json'), 'utf8')
        ) as { filters: Record<string, string> };
        return dict.filters[key] ? [] : [`${lang}: filters.${key}`];
      })
    );
    expect(missing).toEqual([]);
  });
});
