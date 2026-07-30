/**
 * Single source of truth for the version `tokenlens --version` prints.
 * Kept in sync with this package's `package.json` `version` field —
 * enforced by `tests/version.test.ts`, not by reading the file at runtime
 * (which would require brittle ESM/CJS-aware path resolution for no real
 * benefit over a plain constant).
 */
export const VERSION = '0.1.0';
