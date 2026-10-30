#!/usr/bin/env node
/**
 * Compares one locale namespace against the English baseline.
 * Usage: node scripts/i18n-check-pair.mjs <lang> [<ns>|all]
 *
 * Fails (exit 1) when: key sets differ, array lengths differ, type differs,
 * interpolation tokens are lost, or CJK codepoints leaked into values.
 * Informational: count of values identical to English.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = path.join(here, '..', 'src', 'locales');
const BASE = 'en';

const lang = process.argv[2];
const nsArg = process.argv[3] || 'all';
if (!lang) {
  console.error('usage: node scripts/i18n-check-pair.mjs <lang> [<ns>|all]');
  process.exit(2);
}
const langDir = path.join(LOCALES, lang);
if (!fs.existsSync(langDir)) {
  console.error(`FAIL  missing folder src/locales/${lang}`);
  process.exit(1);
}

const allNs = fs
  .readdirSync(path.join(LOCALES, BASE))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''));
const targetNs = nsArg === 'all' ? allNs : [nsArg];

const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const TOKEN = /(\{\{[^}]*\}\}|%\{[^}]*\})/g;
const tokens = (s) => (typeof s === 'string' ? (s.match(TOKEN) || []).sort().join(',') : '');

const kindOf = (v) => (Array.isArray(v) ? 'array' : v && typeof v === 'object' ? 'object' : typeof v);

const flatten = (obj, prefix, out) => {
  for (const [k, v] of Object.entries(obj)) {
    const kp = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, kp, out);
    else out.set(kp, { kind: kindOf(v), value: v });
  }
  return out;
};

const leafTotal = (obj) => {
  let n = 0;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) n += leafTotal(v);
    else n += 1;
  }
  return n;
};

let structural = 0;
let sameAsEn = 0;
let leaves = 0;

for (const ns of targetNs) {
  const enPath = path.join(LOCALES, BASE, `${ns}.json`);
  const lgPath = path.join(LOCALES, lang, `${ns}.json`);
  if (!fs.existsSync(lgPath)) {
    console.error(`FAIL  src/locales/${lang}/${ns}.json does not exist`);
    structural += 1;
    continue;
  }
  let en, lg;
  try {
    en = JSON.parse(fs.readFileSync(enPath, 'utf8'));
    lg = JSON.parse(fs.readFileSync(lgPath, 'utf8'));
  } catch (e) {
    console.error(`FAIL  ${lang}/${ns}.json invalid JSON: ${e.message}`);
    structural += 1;
    continue;
  }
  const a = flatten(en, '', new Map());
  const b = flatten(lg, '', new Map());
  leaves += leafTotal(lg);

  const missing = [...a.keys()].filter((k) => !b.has(k));
  const extra = [...b.keys()].filter((k) => !a.has(k));
  const typeBad = [...a.keys()].filter((k) => b.has(k) && a.get(k).kind !== b.get(k).kind);
  const lenBad = [...a.keys()].filter(
    (k) => b.has(k) && a.get(k).kind === 'array' && a.get(k).value.length !== b.get(k).value.length,
  );
  const tokBad = [...a.keys()].filter(
    (k) => b.has(k) && a.get(k).kind === 'string' && tokens(a.get(k).value) !== tokens(b.get(k).value),
  );
  const cjk = [...b.keys()].filter((k) => {
    const v = b.get(k).value;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return CJK.test(s);
  });
  const untouched = [...a.keys()].filter(
    (k) => b.has(k) && a.get(k).kind === 'string' && a.get(k).value === b.get(k).value,
  );
  sameAsEn += untouched.length;

  const problems = [
    missing.length && `missing ${missing.length}: ${missing.slice(0, 5).join(', ')}`,
    extra.length && `extra ${extra.length}: ${extra.slice(0, 5).join(', ')}`,
    typeBad.length && `type ${typeBad.length}: ${typeBad.slice(0, 3).join(', ')}`,
    lenBad.length && `arrayLen ${lenBad.length}: ${lenBad.slice(0, 3).join(', ')}`,
    tokBad.length && `tokens ${tokBad.length}: ${tokBad.slice(0, 3).join(', ')}`,
    cjk.length && `CJK ${cjk.length}: ${cjk.slice(0, 3).join(', ')}`,
  ].filter(Boolean);

  if (problems.length) {
    structural += problems.length;
    console.log(`FAIL  ${lang}/${ns}: ${problems.join(' | ')}`);
  } else {
    console.log(`ok    ${lang}/${ns}: ${leafTotal(lg)} leaf keys, ${untouched.length} identical to en`);
  }
}

console.log(
  `\n${lang}: ${targetNs.length} namespace(s), ${leaves} leaf keys, ${sameAsEn} identical to en (informational), structural problems: ${structural}`,
);
console.log(structural === 0 ? 'PAIR CHECK PASSED' : 'PAIR CHECK FAILED');
process.exit(structural === 0 ? 0 : 1);
