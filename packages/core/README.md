# @tokenslens/core

The `tokenlens` CLI/core — credit ledger, waste attribution, simulation, and policy compiler for
GitHub Copilot in VS Code. See the [root README](../../README.md) for the full command reference
and phase-by-phase status.

## Status

All phases (D0 through D10) are implemented — run `tokenlens --help` for the full command list.

## Scripts

| Command                                     | Effect                                                             |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `npm run build -w @tokenslens/core`         | Compile to `dist/` (tsup — dual ESM/CJS library, ESM-only CLI bin) |
| `npm test -w @tokenslens/core`              | Run behavioral tests once                                         |
| `npm run test:performance -w @tokenslens/core` | Run isolated hook CPU-budget checks                            |
| `npm run test:watch -w @tokenslens/core`    | Run tests in watch mode                                            |
| `npm run test:coverage -w @tokenslens/core` | Run tests with V8 coverage                                         |
| `npm run typecheck -w @tokenslens/core`     | `tsc --noEmit`                                                     |
| `npm run lint -w @tokenslens/core`          | ESLint over `src/` and `tests/`                                    |
