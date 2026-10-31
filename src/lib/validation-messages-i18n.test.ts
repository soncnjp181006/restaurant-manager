import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Validation messages must resolve the CURRENT language, not the language that
 * happened to be active when the module was imported.
 *
 * Two failure modes were live on a Vietnamese terminal:
 *  - hardcoded English literals: `.required("This is required")` (96 sites)
 *  - module-scope i18n.t: `.required(i18n.t(<validation key>))`, evaluated
 *    once at import time while i18n still served the English bundle (88 sites)
 * Both freeze English into every form. Fix: `() => i18n.t(<validation key>)`,
 * which yup evaluates per validation.
 *
 * This gate also checks that every `validation:` key referenced in the app exists
 * in both locale files, so a renamed key cannot silently fall back to English.
 */

const SRC = path.resolve(__dirname, '..');
const SELF = 'validation-messages-i18n.test.ts';
const VALIDATORS = ['required', 'typeError', 'min', 'max', 'oneOf', 'matches', 'length', 'email'];

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (/\.test\./.test(entry)) continue;
      if (entry === SELF) continue;
      files.push(abs);
    }
  };
  walk(SRC);
  return files;
}

const files = sourceFiles().map((abs) => ({
  file: path.relative(SRC, abs).replace(/\\/g, '/'),
  text: readFileSync(abs, 'utf8'),
}));

describe('locale files', () => {
  const LOCALES = path.join(SRC, 'locales');
  const namespaces = readdirSync(path.join(LOCALES, 'en')).filter((f) => f.endsWith('.json'));

  const flatten = (value: unknown, prefix = ''): string[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      flatten(child, prefix ? `${prefix}.${key}` : key)
    );
  };

  it('parses every en and vi namespace', () => {
    const broken: string[] = [];
    for (const lang of ['en', 'vi']) {
      for (const file of readdirSync(path.join(LOCALES, lang)).filter((f) => f.endsWith('.json'))) {
        try {
          JSON.parse(readFileSync(path.join(LOCALES, lang, file), 'utf8'));
        } catch (error) {
          broken.push(`${lang}/${file}: ${(error as Error).message}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('keeps en and vi key-for-key identical in every namespace', () => {
    const drift: string[] = [];
    for (const file of namespaces) {
      const en = new Set(flatten(JSON.parse(readFileSync(path.join(LOCALES, 'en', file), 'utf8'))));
      const viPath = path.join(LOCALES, 'vi', file);
      if (!existsSync(viPath)) {
        drift.push(`vi/${file}: missing file`);
        continue;
      }
      const vi = new Set(flatten(JSON.parse(readFileSync(viPath, 'utf8'))));
      for (const key of en) if (!vi.has(key)) drift.push(`vi/${file}: ${key}`);
      for (const key of vi) if (!en.has(key)) drift.push(`en/${file}: ${key}`);
    }
    expect(drift).toEqual([]);
  });
});

describe('validation messages are localized at call time', () => {
  it('no validator uses a hardcoded English sentence', () => {
    const offenders: string[] = [];
    for (const { file, text } of files) {
      for (const validator of VALIDATORS) {
        const re = new RegExp(`\\.${validator}\\(\\s*(['"])([^'"\\\\]*[A-Za-z][^'"\\\\]*)\\1`, 'g');
        for (const match of text.matchAll(re)) {
          const message = match[2];
          // Any alphabetic message counts — "Required" (single word) was the one
          // that slipped through an earlier two-word rule across 66 HR sites.
          if (/^[A-Za-z][A-Za-z ,.'?!…%-]{2,}$/.test(message)) {
            offenders.push(`${file}: .${validator}(${message})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no validator freezes i18n.t at module load', () => {
    const offenders: string[] = [];
    for (const { file, text } of files) {
      for (const validator of ['required', 'typeError', 'min', 'max', 'oneOf', 'matches', 'length', 'email']) {
        if (new RegExp(`\\.${validator}\\(\\s*i18n\\.t\\(`).test(text)) {
          offenders.push(`${file}: .${validator}(i18n.t(...))`);
        }
      }
      // `.min(1, i18n.t('validation:required'))` freezes the language just like the
      // first-argument form; the message has to be a lazy function.
      if (/\.(?:min|max|oneOf|matches|length)\(\s*[^,()]+,\s*i18n\.t\(/.test(text)) {
        offenders.push(`${file}: .min(…, i18n.t(...))`);
      }
      // `.test(<name>, i18n.t(<validation key>))` freezes too.
      if (/\.test\(\s*['"][^'"]+['"]\s*,\s*i18n\.t\(/.test(text)) {
        offenders.push(`${file}: .test(…, i18n.t(...))`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no validator takes its message from a second-argument literal', () => {
    // `.min(1, "Add at least one item")` and `.test("name", "Invalid …")` were
    // invisible to the first-argument scan above and stayed English.
    const offenders: string[] = [];
    for (const { file, text } of files) {
      for (const match of text.matchAll(/\.(?:min|max)\(\s*\d+\s*,\s*(['"])([^'"]*[A-Za-z][^'"]*)\1/g)) {
        if (match[2].trim().split(/\s+/).length >= 1 && !match[2].startsWith('validation:')) {
          offenders.push(`${file}: .${match[0].slice(0, 60)}`);
        }
      }
      for (const match of text.matchAll(/\.test\(\s*(['"])[^'"]+\1\s*,\s*(['"])([^'"]*[A-Za-z][^'"]*)\2/g)) {
        offenders.push(`${file}: .test(..., ${match[3].slice(0, 50)})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no createError() carries a hardcoded message', () => {
    // `this.createError({ message: "Invoice number already exists" })` inside a
    // custom test body is invisible to the argument scans above.
    const offenders: string[] = [];
    for (const { file, text } of files) {
      for (const match of text.matchAll(/createError\(\{[^}]*message:\s*(['"])([^'"]+)\1/g)) {
        offenders.push(`${file}: ${match[2].slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no toast carries a hardcoded sentence', () => {
    // `toast.success("Purchase approved")` / template strings bypass every JSX scanner.
    const offenders: string[] = [];
    for (const { file, text } of files) {
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        const match = /toast\.(?:success|error|info|warning)\(\s*(['"`])([^'"`]{6,})\1/.exec(line);
        if (match) offenders.push(`${file}: ${match[2].slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every referenced validation key exists in en and vi', () => {
    const locales = ['en', 'vi'].map((lang) =>
      JSON.parse(readFileSync(path.join(SRC, 'locales', lang, 'validation.json'), 'utf8')) as Record<string, string>
    );
    const referenced = new Set<string>();
    for (const { text } of files) {
      for (const match of text.matchAll(/i18n\.t\(\s*['"]validation:([\w.]+)['"]/g)) {
        referenced.add(match[1]);
      }
    }
    expect(referenced.size).toBeGreaterThan(0);
    const missing = [...referenced].flatMap((key) =>
      locales
        .map((dict, index) => (dict[key] ? null : `${['en', 'vi'][index]}: validation.${key}`))
        .filter((entry): entry is string => entry !== null)
    );
    expect(missing).toEqual([]);
  });
});
