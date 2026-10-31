import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression gate for English text leaking into the Vietnamese UI.
 *
 * Contract: operator/customer facing text comes from i18n. The scanner has four
 * passes, each added after a real leak it would have caught:
 *   1. sentences in JSX text nodes   ("No delivery orders...")
 *   2. literal attributes            placeholder="Search dishes"
 *   3. single-word labels            "Taxes", "Qty", "Notes"  (button/column labels)
 *   4. prop expressions              title={data ? `…` : "Create new supplier"}
 * Code-heavy lines (`{}`, backticks, t(...)) are skipped; labels are capitalised by
 * convention, so requiring an uppercase first letter filters out fragments like
 * `info.getValue()` without a per-file allowlist. Brands are allowed by content.
 */
const SRC = path.resolve(__dirname, '..');
const SCANNED_DIRS = ['components', 'screens'];
const ALLOWED_TEXT = new Set<string>(['PayPal', 'M-Pesa', 'Google Maps', 'FBR', 'PRA', 'OpenStreetMap']);

type Hit = { file: string; line: number; text: string; kind: string };

function tsxFiles(relative: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.endsWith('.tsx') && !/\.test\./.test(entry)) files.push(abs);
    }
  };
  walk(path.join(SRC, relative));
  return files;
}

const ALL_FILES = SCANNED_DIRS.flatMap((dir) => tsxFiles(dir).map((abs) => ({ abs })));

const labelledText = /^[A-ZÀ-Ỹ][A-Za-zÀ-ỹ0-9 ,.'’?!:&()/–—-]*$/;
const NON_LABELS = /^(px|rem|em|flex|block|text|grid|none|true|false|auto|div|span|svg|path|hr|br|td|th|tr|ul|li|p)$/i;
// A bare label line must read as prose, not as JS/JSX syntax. `{`, `[`, `$`,
// backticks or angle brackets mean the line is an expression, not a label.
const BARE_LABEL_FORBIDDEN = new Set(['=', '(', ')', '{', '}', '[', ']', '`', '$', '<', '>']);

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const { abs } of ALL_FILES) {
    const relative = path.relative(SRC, abs).replace(/\\/g, '/');
    let inBlockComment = false;
    let inImport = false;
    readFileSync(abs, 'utf8').split('\n').forEach((line, index) => {
      // Multi-line `import { … } from '…'` lists look like bare capitalised names.
      const trimmedLine = line.trim();
      if (!inImport && trimmedLine.startsWith('import') && !trimmedLine.includes('from ')) {
        inImport = true;
        return;
      }
      if (inImport) {
        if (trimmedLine.includes('from ')) inImport = false;
        return;
      }
      // Skip commented-out JSX (mockups left in the source by accident).
      const opens = line.includes('/*');
      const closes = line.includes('*/');
      if (opens || closes) {
        if (opens && !closes) inBlockComment = true;
        else if (!opens && closes) inBlockComment = false;
        // Whole line is comment when it both opens and closes, or continues one.
        if (opens || inBlockComment || closes) return;
      } else if (inBlockComment) {
        return;
      }
      // 1. sentences in JSX text nodes
      for (const match of line.matchAll(/>([^<>{}]*[A-Za-z]{3,}[^<>{}]*)</g)) {
        const text = match[1].trim();
        if (ALLOWED_TEXT.has(text) || !/\s/.test(text) || !labelledText.test(text)) continue;
        hits.push({ file: relative, line: index + 1, text, kind: 'text' });
      }
      // 2. literal attributes (sentences and single-word labels alike)
      for (const match of line.matchAll(/(placeholder|title|aria-label|alt)="([^"]+)"/g)) {
        const text = match[2];
        const isSentence = /\s/.test(text) && /^[A-Z]/.test(text);
        const isWord = /^[A-Z][A-Za-z]{2,}$/.test(text);
        if (ALLOWED_TEXT.has(text) || (!isSentence && !isWord) || !/[A-Za-z]{3,}/.test(text)) continue;
        hits.push({ file: relative, line: index + 1, text, kind: match[1] });
      }
      // 3. single-word labels (no braces on the line, not translated yet)
      if (!line.includes("t('") && !line.includes('t("') && !/[{}`]/.test(line)) {
        for (const match of line.matchAll(/>([A-Z][A-Za-z #.:&/-]{1,24})</g)) {
          const text = match[1].trim();
          if (ALLOWED_TEXT.has(text) || !labelledText.test(text) || NON_LABELS.test(text)) continue;
          hits.push({ file: relative, line: index + 1, text, kind: 'label' });
        }
      }
      // 5. inline button labels on the same line as the tag (`…> Item</Button>`)
      for (const match of line.matchAll(/>\s*([A-Z][A-Za-z]{2,})\s*<\/Button>/g)) {
        const text = match[1];
        if (ALLOWED_TEXT.has(text)) continue;
        hits.push({ file: relative, line: index + 1, text, kind: 'button' });
      }
      // 4. English literals inside prop expressions
      for (const match of line.matchAll(/(title|label|placeholder|aria-label|alt)=\{([^}]+)\}/g)) {
        const expression = match[2];
        if (/\bt\(|i18n\.t\(/.test(expression)) continue;
        for (const literal of expression.matchAll(/(["'`])([A-Z][A-Za-z0-9 ,.'’?!:&()/-]{2,60})\1/g)) {
          const text = literal[2];
          if (ALLOWED_TEXT.has(text) || !/\s/.test(text)) continue;
          hits.push({ file: relative, line: index + 1, text, kind: `${match[1]} expr` });
        }
      }
      // 5. bare JSX text on its own line (no tag, no braces) — e.g. a caret
      //    "Add item" under a button; SQL keywords are query strings, not text.
      const bare = line.trim();
      if (
        /^[A-Z][A-Za-z0-9 ,.'’?!:&;/–—-]{2,60}$/.test(bare) &&
        !Array.from(bare).some((ch) => BARE_LABEL_FORBIDDEN.has(ch)) &&
        !/[,;]\s*$/.test(bare) &&
        !/^[A-Z][a-z]+[A-Z]/.test(bare) &&
        !/^(FETCH|LIMIT|SELECT|FROM|WHERE|JOIN|GROUP|ORDER)\b/.test(bare) &&
        !bare.startsWith('//') &&
        !ALLOWED_TEXT.has(bare)
      ) {
        hits.push({ file: relative, line: index + 1, text: bare, kind: 'bare' });
      }
    });
  }
  return hits;
}

describe('no hardcoded English text in operator-facing screens', () => {
  it('every scanned area takes its user-visible text from i18n', () => {
    const report = scan().map((hit) => `${hit.file}:${hit.line} ${hit.kind} "${hit.text.slice(0, 70)}"`);
    expect(report).toEqual([]);
  });

  it('the scanner reaches the files it claims to guard', () => {
    // Guard against a broken path silently producing an empty hit list.
    expect(ALL_FILES.length).toBeGreaterThanOrEqual(400);
  });
});
