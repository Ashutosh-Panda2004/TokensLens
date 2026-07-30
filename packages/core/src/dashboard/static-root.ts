import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locates the `static/` directory holding the dashboard's HTML/CSS/JS
 * assets. Tried as two candidates because this module is bundled
 * (tsup) into the CLI entry at `dist/cli/index.js`, one directory
 * deeper than the built static assets at `dist/dashboard/static/`
 * (copied there by `scripts/copy-static.mjs`) — but the same relative
 * path also happens to resolve correctly when run unbuilt from
 * `src/cli/` during development, so one lookup chain covers both.
 *
 * This module is deliberately never exported from the public library
 * barrel (`src/index.ts`) — only from the CLI's own command wiring —
 * because it relies on `import.meta.url`, which is only safe in the
 * ESM-only CLI bundle, not the dual ESM/CJS library bundle (see
 * `tsup.config.ts`).
 */
export function resolveDashboardStaticRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'dashboard', 'static'), join(here, '..', 'dashboard', 'static')];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Could not locate the dashboard static assets directory. Looked in: ${candidates.join(', ')}`,
    );
  }
  return found;
}
