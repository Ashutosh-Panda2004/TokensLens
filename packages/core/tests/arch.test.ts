import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, relative } from 'node:path';

/**
 * Forbidden import edges (DEVELOPMENT-PLAN.md rule AI-3 / §0.2 AI rules).
 *
 * Deliberately declarative and forward-looking: `src/hooks`, `src/ledger`,
 * and `src/policy` do not exist yet in Phase D0, so every rule below is
 * currently satisfied vacuously (no files match `fromPrefix`). As those
 * directories are populated in later phases, this test starts enforcing
 * the rule against real files with zero changes required here.
 */
const FORBIDDEN_IMPORTS: readonly {
  fromPrefix: string;
  forbiddenPrefix: string;
  reason: string;
}[] = [
  {
    fromPrefix: 'src/hooks',
    forbiddenPrefix: 'src/adapters/llm',
    reason:
      'Hooks run inside a PreToolUse/PostToolUse latency budget (p99 < 50ms) — an LLM ' +
      'call is architecturally impossible there. DEVELOPMENT-PLAN.md rule AI-3.',
  },
  {
    fromPrefix: 'src/ledger',
    forbiddenPrefix: 'src/adapters/llm',
    reason:
      'The credit ledger is pure arithmetic over measured fields. DEVELOPMENT-PLAN.md rule AI-3.',
  },
  {
    fromPrefix: 'src/policy',
    forbiddenPrefix: 'src/adapters/llm',
    reason:
      'Policy emission is constraint-solving over measured data, not generation. ' +
      'DEVELOPMENT-PLAN.md rule AI-3.',
  },
];

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url));
const PACKAGE_ROOT = dirname(SRC_ROOT.replace(/[\\/]$/, ''));

function collectSourceFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (entry.isFile() && extname(entry.name) === '.ts' && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

// Matches `import ... from '...'`, `export ... from '...'`, and dynamic
// `import('...')`. Lightweight and regex-based on purpose (see note below);
// not a full AST parse.
const IMPORT_SPECIFIER_PATTERN =
  /(?:import|export)(?:[^'";]*?from)?\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function toPackageRelative(absolutePath: string): string {
  return relative(PACKAGE_ROOT, absolutePath).split('\\').join('/');
}

function resolveRelativeSpecifier(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined; // a package import, not a local module
  const resolved = join(dirname(fromFile), specifier).replace(/\.(js|ts)$/, '');
  return toPackageRelative(resolved);
}

describe('architectural import boundaries', () => {
  it('never imports a forbidden module from a module it is banned in', () => {
    // A lightweight, hand-rolled static check rather than a dependency like
    // dependency-cruiser: the rule set is tiny (three edges) and the cost
    // of a false positive (a comment or string containing "from") is a
    // quick manual review, not a maintenance burden — revisit only if that
    // stops being true.
    const violations: string[] = [];

    for (const file of collectSourceFiles(SRC_ROOT)) {
      const packageRelativeFile = toPackageRelative(file);
      const applicableRules = FORBIDDEN_IMPORTS.filter((rule) =>
        packageRelativeFile.startsWith(rule.fromPrefix),
      );
      if (applicableRules.length === 0) continue;

      const source = readFileSync(file, 'utf8');
      for (const specifier of extractImportSpecifiers(source)) {
        const resolved = resolveRelativeSpecifier(file, specifier);
        if (!resolved) continue;

        for (const rule of applicableRules) {
          if (resolved.startsWith(rule.forbiddenPrefix)) {
            violations.push(
              `${packageRelativeFile} imports "${specifier}" (resolves to ${resolved}), ` +
                `which is forbidden: ${rule.reason}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
