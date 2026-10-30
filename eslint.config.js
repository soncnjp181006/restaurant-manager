import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

/**
 * Flat config replacement for the old `.eslintrc.cjs` (ESLint 9+ dropped the
 * eslintrc format, which is why `npm run lint` could not start).
 *
 * Deliberately keeps the previous ruleset rather than adopting every rule the
 * newer plugins ship:
 *  - the old run was `eslint . --ext ts,tsx`, so only .ts/.tsx are linted
 *    (JS in scripts/, docs-automation/ and the backend packages is out of scope);
 *  - eslint-plugin-react-hooks v7 `recommended` now bundles 17 rules
 *    (immutability, refs, purity, set-state-in-render, …) while the v4 config the
 *    repo pinned enabled two. Only those two are on, so this migration does not
 *    invent new failures; the strict set can be turned on as its own change.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.js',
      '**/*.cjs',
      '**/*.mjs',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // react-hooks v7 recommended, limited to the two rules the old config had.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Carried over from .eslintrc.cjs overrides.
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-useless-catch': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      // TypeScript already reports undefined identifiers (TS2304), which this
      // repo's typecheck gates on; no-undef only duplicates it for globals.
      'no-undef': 'off',
    },
  },
);
