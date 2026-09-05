import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Unbounded worker creation caused RPC timeouts on loaded developer
    // machines even while every assertion passed. Four workers retain file
    // parallelism without starving Vitest's coordinator; the CPU benchmark
    // overrides this to one fork in its dedicated script.
    maxWorkers: 4,
    minWorkers: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      // cli/index.ts and index.ts are pure wiring with no logic of their
      // own (see their own file comments). cli/commands/*.ts + context.ts
      // are thin glue over buildLedger/forecastBudget/getRequestById/
      // ingestAllDiscovered — all independently covered — that call
      // ingestAllDiscovered() with the *real* machine's discovery roots;
      // testing them directly would mean either scanning this machine's
      // real Copilot history in CI or adding CLI-only test seams to
      // production wiring purely to satisfy coverage. Exercised instead
      // by a manual end-to-end smoke test against real session data
      // (see DEVELOPMENT-PLAN.md Phase D1 sign-off).
      exclude: ['src/cli/index.ts', 'src/index.ts', 'src/cli/commands/**', 'src/cli/context.ts'],
    },
  },
  resolve: {
    conditions: ['node'],
  },
});
