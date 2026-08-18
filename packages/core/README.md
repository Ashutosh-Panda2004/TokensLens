# tokenlens

The `tokenlens` CLI/core — credit ledger, waste attribution, simulation, and policy compiler for
GitHub Copilot in VS Code. See the [root README](../../README.md) for the full command reference
and phase-by-phase status.

## Status

All phases (D0 through D10) are implemented — run `tokenlens --help` for the full command list.

## Scripts

| Command | Effect |
|---|---|
| `npm run build -w tokenlens` | Compile to `dist/` (tsup — dual ESM/CJS library, ESM-only CLI bin) |
| `npm test -w tokenlens` | Run the test suite once |
| `npm run test:watch -w tokenlens` | Run tests in watch mode |
| `npm run test:coverage -w tokenlens` | Run tests with V8 coverage |
| `npm run typecheck -w tokenlens` | `tsc --noEmit` |
| `npm run lint -w tokenlens` | ESLint over `src/` and `tests/` |
