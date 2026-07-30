# tokenlens

The `tokenlens` CLI/core — credit ledger, waste attribution, simulation, and policy compiler for
GitHub Copilot in VS Code. See [`../../DEVELOPMENT-PLAN.md`](../../DEVELOPMENT-PLAN.md) for the
full phase-by-phase build plan.

## Phase D0 status

Foundation only: provenance types, error taxonomy, logger, config/io helpers, a security
baseline, and a CLI shell where every planned command is registered but not yet implemented
(each reports `NotImplementedError` naming the phase that ships it — run `tokenlens --help` to
see the full roadmap).

## Scripts

| Command | Effect |
|---|---|
| `npm run build -w tokenlens` | Compile to `dist/` (tsup — dual ESM/CJS library, ESM-only CLI bin) |
| `npm test -w tokenlens` | Run the test suite once |
| `npm run test:watch -w tokenlens` | Run tests in watch mode |
| `npm run test:coverage -w tokenlens` | Run tests with V8 coverage |
| `npm run typecheck -w tokenlens` | `tsc --noEmit` |
| `npm run lint -w tokenlens` | ESLint over `src/` and `tests/` |
