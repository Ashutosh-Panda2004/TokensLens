import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      // Both excluded files are pure wiring with no logic of their own:
      // cli/index.ts just parses argv and sets an exit code (exercised
      // through program.ts, which IS covered); index.ts is a re-export
      // barrel with nothing to execute in its own right.
      exclude: ['src/cli/index.ts', 'src/index.ts'],
    },
  },
  resolve: {
    conditions: ['node'],
  },
});
