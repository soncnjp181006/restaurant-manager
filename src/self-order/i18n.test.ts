import { describe, expect, it } from 'vitest';
import { interpolate, pickSelfOrderLang, resolveSelfOrderLang, selfOrderDictionaries } from './i18n';

/**
 * The QR self-order page is a separate entry point (its own HTML + module graph)
 * and used to be English-only. These tests pin the parts that are easy to break:
 * language resolution order and dictionary parity, so a new string cannot ship in
 * English only.
 */
describe('self-order language', () => {
  it('honours ?lang= before anything else', () => {
    expect(resolveSelfOrderLang('?t=abc&lang=vi')).toBe('vi');
    expect(resolveSelfOrderLang('?lang=en')).toBe('en');
  });

  it('resolution order: query beats stored, stored beats browser, vi browser wins over en', () => {
    expect(pickSelfOrderLang({ query: 'vi', stored: 'en', browser: 'en-US' })).toBe('vi');
    expect(pickSelfOrderLang({ query: null, stored: 'vi', browser: 'en-US' })).toBe('vi');
    expect(pickSelfOrderLang({ query: 'fr', stored: 'en', browser: 'vi-VN' })).toBe('en');
    expect(pickSelfOrderLang({ query: null, stored: null, browser: 'vi-VN' })).toBe('vi');
    expect(pickSelfOrderLang({ query: null, stored: null, browser: 'en-GB' })).toBe('en');
    expect(pickSelfOrderLang({})).toBe('en');
  });

  it('keeps en and vi key-for-key identical', () => {
    const { en, vi } = selfOrderDictionaries();
    expect(Object.keys(vi).sort()).toEqual(Object.keys(en).sort());
  });

  it('has no empty Vietnamese entry and keeps brand names', () => {
    const { en, vi } = selfOrderDictionaries();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(vi[key].trim().length, `vi.${key} is empty`).toBeGreaterThan(0);
    }
    // Brand names intentionally stay as-is in both dictionaries.
    expect(vi.paypalNotSetup).toContain('PayPal');
  });

  it('interpolates placeholders and leaves unknown ones alone', () => {
    expect(interpolate('Đã thêm {name} vào đơn', { name: 'Phở' })).toBe('Đã thêm Phở vào đơn');
    expect(interpolate('Chọn {count}', { count: 2 })).toBe('Chọn 2');
    expect(interpolate('Xin chào {who}', {})).toBe('Xin chào {who}');
    expect(interpolate('no vars')).toBe('no vars');
  });
});
