import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, relative } from 'node:path';

/**
 * Forbidden import edges (DEVELOPMENT-PLAN.md rule AI-3 / §0.2 AI rules).
 *
 * Written declaratively in D0, before any of these directories existed, so
 * that populating them in a later phase started enforcing the rule with no
 * change here. All three now match real files.
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

/**
 * Constraint H-3: a runtime guard makes **zero network calls and zero model
 * calls**.
 *
 * Enforced here rather than promised in a comment, because this is the one
 * claim that has to survive a security review. A hook is a subprocess the
 * agent runs on every tool call, on a developer's machine, with their
 * credentials — if it could reach the network, every other privacy
 * guarantee in this product would rest on trust rather than on structure.
 *
 * Bare specifiers are checked separately from relative ones because the
 * dangerous imports here are all built-ins.
 */
const FORBIDDEN_PACKAGES: readonly {
  fromPrefix: string;
  packages: readonly string[];
  reason: string;
}[] = [
  {
    fromPrefix: 'src/hooks',
    packages: [
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dgram',
      'http',
      'https',
      'undici',
      'axios',
      'node-fetch',
    ],
    reason:
      'H-3: a runtime guard makes zero network calls. It runs per tool call, inside a 50ms budget.',
  },
  {
    fromPrefix: 'src/mcp',
    packages: ['node:http', 'node:https', 'node:net', 'node:tls', 'undici', 'axios', 'node-fetch'],
    reason:
      'The budget-guard MCP server speaks stdio to a local agent and has no reason to open a socket.',
  },
  {
    fromPrefix: 'src/advice',
    packages: [
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dgram',
      'http',
      'https',
      'undici',
      'axios',
      'node-fetch',
    ],
    reason:
      'D11: the advice catalogue is a compiled-in dataset, never a live lookup. Freshness is a ' +
      'CI concern that opens an issue; it is not a reason for the binary to acquire the ability ' +
      'to fetch. Local-only is a property here, not a promise.',
  },
  {
    fromPrefix: 'src/contribute',
    packages: [
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dgram',
      'http',
      'https',
      'undici',
      'axios',
      'node-fetch',
    ],
    reason:
      'The sharing feature is the one place a network call would be most tempting and most ' +
      'damaging: it is the module whose whole purpose is data leaving, so it is the module ' +
      'whose inability to send it must be checkable. A contribution is written to a local ' +
      'outbox and stops; transport is a separate act the user can read before performing.',
  },
];

/** `fetch` needs no import, so the ban has to be checked in the source text too. */
const FETCH_PATTERN = /\bfetch\s*\(/;

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

  it('never opens a socket from a runtime guard or the MCP server', () => {
    const violations: string[] = [];

    for (const file of collectSourceFiles(SRC_ROOT)) {
      const packageRelativeFile = toPackageRelative(file);
      const rules = FORBIDDEN_PACKAGES.filter((rule) =>
        packageRelativeFile.startsWith(rule.fromPrefix),
      );
      if (rules.length === 0) continue;

      const source = readFileSync(file, 'utf8');
      const specifiers = extractImportSpecifiers(source);

      for (const rule of rules) {
        for (const specifier of specifiers) {
          if (rule.packages.includes(specifier)) {
            violations.push(`${packageRelativeFile} imports "${specifier}": ${rule.reason}`);
          }
        }
        // Strip comments before looking for `fetch(`, so prose about not
        // calling it does not read as calling it.
        const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        if (FETCH_PATTERN.test(code)) {
          violations.push(`${packageRelativeFile} calls fetch(): ${rule.reason}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
