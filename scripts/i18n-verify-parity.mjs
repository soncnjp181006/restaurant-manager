#!/usr/bin/env node
/**
 * Verifies locale JSON files match English key structure.
 * Run: node scripts/i18n-verify-parity.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const LOCALES_DIR = path.join(ROOT, 'src/locales');
const BASE_LANG = 'en';

const NAMESPACES = fs
  .readdirSync(path.join(LOCALES_DIR, BASE_LANG))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''));

const LANG_DIRS = fs.readdirSync(LOCALES_DIR).filter((d) => {
  const full = path.join(LOCALES_DIR, d);
  return fs.statSync(full).isDirectory() && d !== BASE_LANG;
});

function flatten(obj, prefix = '') {
  const entries = new Map();
  for (const [key, value] of Object.entries(obj)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      entries.set(pathKey, 'string');
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of flatten(value, pathKey)) {
        entries.set(k, v);
      }
    } else {
      entries.set(pathKey, typeof value);
    }
  }
  return entries;
}

function loadJson(lang, ns) {
  const file = path.join(LOCALES_DIR, lang, `${ns}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing file: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

let failed = false;

/**
 * The app ships exactly these UI languages. Adding a language is a deliberate
 * three-way change: create src/locales/<code>/, list it in
 * src/lib/languages.ts SUPPORTED_LANGUAGES, and add it here.
 */
const EXPECTED_LANGS = ['en', 'vi'];

const declaredLangs = [...fs
  .readFileSync(path.join(ROOT, 'src', 'lib', 'languages.ts'), 'utf8')
  .matchAll(/code:\s*'([a-zA-Z-]+)'/g)].map((m) => m[1]).sort();

const foldersOnDisk = fs
  .readdirSync(LOCALES_DIR)
  .filter((d) => fs.statSync(path.join(LOCALES_DIR, d)).isDirectory())
  .sort();

const unexpected = foldersOnDisk.filter((d) => !EXPECTED_LANGS.includes(d));
const absent = EXPECTED_LANGS.filter((d) => !foldersOnDisk.includes(d));
const undeclared = foldersOnDisk.filter((d) => !declaredLangs.includes(d));

if (unexpected.length || absent.length || undeclared.length) {
  failed = true;
  console.error('\nLocale set mismatch:');
  if (absent.length) console.error(`  expected locale folders missing: ${absent.join(', ')}`);
  if (unexpected.length) console.error(`  locale folders not in EXPECTED_LANGS: ${unexpected.join(', ')}`);
  if (undeclared.length) console.error(`  locale folders not declared in src/lib/languages.ts: ${undeclared.join(', ')}`);
}

for (const lang of LANG_DIRS.sort()) {
  for (const ns of NAMESPACES) {
    const base = flatten(loadJson(BASE_LANG, ns));
    const target = flatten(loadJson(lang, ns));

    const missing = [...base.keys()].filter((k) => !target.has(k));
    const extra = [...target.keys()].filter((k) => !base.has(k));
    const typeMismatch = [...base.keys()].filter(
      (k) => target.has(k) && base.get(k) !== target.get(k),
    );

    if (missing.length || extra.length || typeMismatch.length) {
      failed = true;
      console.error(`\n${lang}/${ns}.json:`);
      if (missing.length) console.error(`  missing keys (${missing.length}):`, missing.slice(0, 10).join(', '), missing.length > 10 ? '...' : '');
      if (extra.length) console.error(`  extra keys (${extra.length}):`, extra.slice(0, 10).join(', '), extra.length > 10 ? '...' : '');
      if (typeMismatch.length) console.error(`  type mismatch (${typeMismatch.length}):`, typeMismatch.slice(0, 10).join(', '), typeMismatch.length > 10 ? '...' : '');
    }
  }
}

if (failed) {
  console.error('\nLocale parity check FAILED.');
  process.exit(1);
}

console.log(`Locale parity OK for ${LANG_DIRS.length} languages × ${NAMESPACES.length} namespaces.`);
