import { describe, expect, it } from 'vitest';
import { getTableLabel } from './table.ts';

describe('getTableLabel', () => {
  it('joins name and number with a space', () => {
    expect(getTableLabel({ name: 'Bàn', number: '2' })).toBe('Bàn 2');
  });

  it('does not repeat a number the name already ends with', () => {
    // "Bàn 1" + number "1" used to render as "Bàn 11".
    expect(getTableLabel({ name: 'Bàn 1', number: '1' })).toBe('Bàn 1');
  });

  it('accepts numeric and missing parts', () => {
    expect(getTableLabel({ name: 'Bàn', number: 3 })).toBe('Bàn 3');
    expect(getTableLabel({ name: 'Bàn', number: null })).toBe('Bàn');
    expect(getTableLabel({ name: null, number: '7' })).toBe('7');
    expect(getTableLabel(undefined)).toBe('');
  });

  it('keeps a number that only partially overlaps the name', () => {
    expect(getTableLabel({ name: 'Tầng 1', number: '11' })).toBe('Tầng 1 11');
  });
});
