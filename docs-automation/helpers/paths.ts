import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, '../..');
export const GUIDE_ROOT = path.join(REPO_ROOT, 'docs/user-guide');
/** Shared legacy root (prefer per-lang subfolders under this). */
export const IMAGES_ROOT = path.join(GUIDE_ROOT, 'images');
export const LOCALES_DIR = path.join(GUIDE_ROOT, 'locales');
export const DIST_DIR = path.join(GUIDE_ROOT, 'dist');

/** App language codes used by i18n / Settings. */
export const DOCS_GUIDE_LANGS = [
  { code: 'en', folder: 'en', dir: 'ltr' },
  { code: 'vi', folder: 'vi', dir: 'ltr' },
] as const;

export type DocsGuideLangCode = (typeof DOCS_GUIDE_LANGS)[number]['code'];

/** Active capture/assemble language code (e.g. `vi`). Default English. */
export function docsGuideLangCode(): string {
  const raw = (process.env.DOCS_GUIDE_LANG || 'en').trim();
  const found = DOCS_GUIDE_LANGS.find(
    (l) => l.code === raw || l.folder === raw || l.folder === raw.toLowerCase()
  );
  return found?.code ?? 'en';
}

export function docsGuideLangFolder(code = docsGuideLangCode()): string {
  const found = DOCS_GUIDE_LANGS.find(
    (l) => l.code === code || l.folder === code || l.folder === code.toLowerCase()
  );
  return found?.folder ?? 'en';
}

/** Per-language screenshot directory: docs/user-guide/images/{en|es|…}/ */
export function imagesDirForLang(codeOrFolder?: string): string {
  const folder = docsGuideLangFolder(codeOrFolder || docsGuideLangCode());
  return path.join(IMAGES_ROOT, folder);
}

/** @deprecated Prefer imagesDirForLang — kept for callers expecting a single dir. */
export const IMAGES_DIR = imagesDirForLang();
