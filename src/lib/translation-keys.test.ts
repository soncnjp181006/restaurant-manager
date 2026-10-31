import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A `t('key')` whose key is missing from the locale files renders the raw key in
 * the UI (e.g. "admin:forms.supplierOverride"). The existing gates cover English
 * text and validator keys; this one covers every literal translation key in the
 * app, resolving the namespace the same way react-i18next does:
 *   - `t(<ns>:<key>)`        → ns/key
 *   - `t('key')`             → <first namespace of the file's useTranslation> / key
 * Keys with interpolation (`${}`) are skipped: they are dynamic by design.
 */
const SRC = path.resolve(__dirname, '..');
const LOCALES = path.join(SRC, 'locales');

const dicts = new Map<string, Set<string>>();
for (const lang of ['en', 'vi']) {
  for (const file of readdirSync(path.join(LOCALES, lang)).filter((f) => f.endsWith('.json'))) {
    const ns = file.replace(/\.json$/, '');
    const flat = new Set<string>();
    const walk = (value: unknown, prefix: string) => {
      if (prefix) flat.add(prefix); // branch keys resolve too (`returnObjects: true`)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          walk(child, prefix ? `${prefix}.${key}` : key);
        }
      } else {
        flat.add(prefix);
      }
    };
    walk(JSON.parse(readFileSync(path.join(LOCALES, lang, file), 'utf8')), '');
    dicts.set(`${lang}:${ns}`, flat);
  }
}

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) { walk(abs); continue; }
      if (/\.(ts|tsx)$/.test(entry) && !/\.test\./.test(entry)) files.push(abs);
    }
  };
  walk(SRC);
  return files;
}

const has = (lang: string, ns: string, key: string) => {
  const dict = dicts.get(`${lang}:${ns}`);
  if (!dict) return true; // unknown namespace (e.g. i18n key built from data)
  return dict.has(key) || dict.has(`${key}_one`) || dict.has(`${key}_other`);
};

describe('every literal translation key exists', () => {
  it('t(\'…\') keys resolve in en and vi', () => {
    const missing: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      const namespaces = [...text.matchAll(/useTranslation\(\s*\[?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      const defaultNs = namespaces[0];
      for (const match of text.matchAll(/\bt\(\s*['"]([^'"$`]+)['"]/g)) {
        const raw = match[1];
        if (!raw || raw.startsWith('http')) continue;
        const [ns, key] = raw.includes(':') ? raw.split(':', 2) : [defaultNs, raw];
        if (!ns || !key) continue;
        if (!has('en', ns, key) || !has('vi', ns, key)) {
          missing.push(`${path.relative(SRC, file).replace(/\\/g, '/')}: ${ns}:${key}`);
        }
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
