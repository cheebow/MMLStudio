import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'public', 'test-results', 'playwright-report'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The engine must stay independent of React, DOM and audio libraries (SPEC 4.1 / 7).
    files: ['src/engine/**/*.ts'],
    languageOptions: { globals: { ...globals.es2023 } },
    rules: {
      'no-restricted-imports': ['error', { patterns: ['react', 'react-*', 'spessasynth_*', '@codemirror/*', '../audio/*', '../ui/*', '../*/**'] }],
      'no-restricted-globals': ['error', 'window', 'document', 'AudioContext', 'fetch', 'localStorage', 'navigator'],
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}'],
    languageOptions: { globals: globals.node },
  },
);
