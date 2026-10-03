// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      // The launch website: a standalone static site, deployed separately,
      // with its own conventions — not part of any workspace tsconfig, so
      // the type-aware rules have no program to resolve its scripts in.
      'website/**',
      '**/*.config.ts',
      '**/*.config.js',
      // Build and CI scripts — plain Node ES modules run directly by npm or
      // by a workflow, deliberately outside every tsconfig for the same
      // reason: `projectService` has no program to resolve them in, and the
      // type-aware rules cannot run without one. They ship in no artefact.
      '**/scripts/**/*.mjs',
      '**/scripts/**/*.cjs',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Auto-discovers the nearest tsconfig.json per linted file — the
        // correct replacement for `project: true` in a multi-package
        // workspace (each package owns its own tsconfig.json).
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
    },
  },
  {
    // Browser assets: the dashboard page's ES modules and the VS Code
    // extension's webview script. Both run in a browser with no build step,
    // so there is no TypeScript program for the type-aware rules to resolve
    // them in. They were previously ignored outright — which meant a helper
    // used without being imported shipped happily and crashed the view the
    // first time somebody opened it. `no-undef` catches exactly that, and
    // needs no type information.
    files: ['**/src/dashboard/static/**/*.js', '**/packages/vscode/media/**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: false },
    },
    rules: {
      'no-undef': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
);
