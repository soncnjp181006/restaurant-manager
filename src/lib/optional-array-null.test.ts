import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SurrealDB 3.x cannot take a `field.*` element definition after a parent declared
 * as `none | array<T> | null` (measured on v3.0.5: "Cannot set field `x.*` ... as it
 * mismatched"), so migrations/scripts/run-prod-migrations.cjs rewrites that union to
 * `option<array<T>>` when it imports the baseline. The rewrite is not equivalent:
 * `option<array<T>>` stores as `none | array<T>` and then rejects an explicit NULL,
 * which frontend writers do send (payment_type.discounts is one). The plan entry
 * `2026_10_31_optional_array_null.surql` re-applies every nullable-array declaration
 * with OVERWRITE so the shipped schema and the stored schema agree again.
 *
 * These tests pin that relationship: a new nullable-array field that is not widened,
 * or a widened field that no schema declares nullable, fails the gate.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const WIDENING_FILE = '2026_10_31_optional_array_null.surql';
const RUNNER = 'scripts/run-prod-migrations.cjs';

const DEFINE_RE =
  /^DEFINE\s+FIELD\s+(?:IF\s+NOT\s+EXISTS\s+|OVERWRITE\s+)?([^\s]+)\s+ON\s+(?:TABLE\s+)?([^\s]+)\s+TYPE\s+(.+)$/i;

const isNullableArray = (type: string) =>
  /^none\s*\|\s*array<.+>\s*\|\s*null$/i.test(type) ||
  /^option<\s*array<.+>\s*\|\s*null\s*>$/i.test(type);

/** table.field -> nullable-array declarations, ignoring element wildcards. */
function nullableArrayFields(files: string[]) {
  const found = new Map<string, string>();
  for (const file of files) {
    const text = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('DEFINE FIELD') || !line.includes('array<')) continue;
      const m = DEFINE_RE.exec(line);
      if (!m) continue;
      const [, field, table, tail] = m;
      if (field.includes('.')) continue;
      const type = tail.split(/\s+(?:PERMISSIONS|ASSERT|DEFAULT|READONLY|FLEXIBLE|METADATA)\b/i)[0]
        .replace(/;+$/, '')
        .trim();
      if (isNullableArray(type)) found.set(`${table}.${field}`, file);
    }
  }
  return found;
}

function schemaFiles() {
  // Readdir at test time keeps the gate honest: any new .surql that declares a
  // nullable array must also be widened.
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.surql') && f !== WIDENING_FILE);
}

describe('optional array fields stay nullable in the stored schema', () => {
  const declared = nullableArrayFields(schemaFiles());
  const widened = nullableArrayFields([WIDENING_FILE]);

  it('the baseline importer still rewrites the union SurrealDB rejects', () => {
    const runner = readFileSync(path.join(MIGRATIONS_DIR, RUNNER), 'utf8');
    expect(runner).toContain('normalizeOptionalArrayTypes');
    expect(runner).toContain("'option<$1>'");
  });

  it('the widening migration is registered in the plan, after the baseline import', () => {
    const runner = readFileSync(path.join(MIGRATIONS_DIR, RUNNER), 'utf8');
    expect(runner).toContain(`file: '${WIDENING_FILE}'`);
  });

  it('every nullable-array field declared in migrations/ is widened', () => {
    const missing = [...declared.keys()].filter((key) => !widened.has(key));
    expect(missing).toEqual([]);
  });

  it('nothing is widened that no schema declares as a nullable array', () => {
    const invented = [...widened.keys()].filter((key) => !declared.has(key));
    expect(invented).toEqual([]);
  });

  it('the payment-type discounts field that broke fresh installs is covered', () => {
    // This is the exact write that failed live: `discounts: null` rejected by
    // `none | array<record<discount>>`.
    expect(declared.has('payment_type.discounts')).toBe(true);
    expect(widened.get('payment_type.discounts')).toBe(WIDENING_FILE);
  });

  it('widening statements use OVERWRITE and keep the nullable union', () => {
    const text = readFileSync(path.join(MIGRATIONS_DIR, WIDENING_FILE), 'utf8');
    const statements = text.split('\n').filter((l) => l.startsWith('DEFINE FIELD'));
    expect(statements.length).toBeGreaterThan(0);
    for (const stmt of statements) {
      expect(stmt).toMatch(/^DEFINE FIELD OVERWRITE \S+ ON \S+ TYPE none \| array<.+> \| null/);
      expect(stmt).toMatch(/;$/);
      expect(stmt).not.toMatch(/;;/);
    }
  });
});
