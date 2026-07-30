import { resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { UnsafePathError, UnsafeRefError } from './errors.js';

/**
 * Resolves `candidate` against `root` and verifies the result does not
 * escape it — the fix for audit defect D-15 (path traversal). Every
 * filesystem path TokenLens derives from session data, hook input, or
 * policy configuration must pass through here before it is read or written.
 *
 * Note the `root + sep` comparison: a naive `resolved.startsWith(root)`
 * check would wrongly accept a sibling directory that merely shares a name
 * prefix (root `/a/b` would incorrectly admit `/a/b-evil`). Anchoring on
 * the separator closes that hole.
 */
export function assertContained(root: string, candidate: string): string {
  const rootResolved = resolve(root);
  const candidateResolved = resolve(root, candidate);
  const withinRoot =
    candidateResolved === rootResolved || candidateResolved.startsWith(rootResolved + sep);

  if (!withinRoot) {
    throw new UnsafePathError(`Path "${candidate}" escapes its required root "${root}".`, {
      candidate: candidateResolved,
      root: rootResolved,
    });
  }

  return candidateResolved;
}

/**
 * Strict allowlist for git ref / branch names TokenLens may create (e.g.
 * generated policy-config PRs — PLAN.md §7 "proposer, narrowed").
 * Deliberately far stricter than what git itself permits: no shell
 * metacharacters, no `..` traversal segments, no leading `-` (which some
 * git/gh invocations would otherwise parse as a flag). The fix for audit
 * defect D-16 (branch-name injection).
 */
const SAFE_REF_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._/-]*[a-zA-Z0-9])?$/;
const FORBIDDEN_REF_SUBSTRINGS = ['..', '@{', '\\', '//'];
const MAX_REF_LENGTH = 255;

export function assertSafeRef(candidate: string): string {
  const isWellFormed =
    candidate.length > 0 &&
    candidate.length <= MAX_REF_LENGTH &&
    !candidate.startsWith('-') &&
    SAFE_REF_PATTERN.test(candidate) &&
    !FORBIDDEN_REF_SUBSTRINGS.some((substring) => candidate.includes(substring));

  if (!isWellFormed) {
    throw new UnsafeRefError(`"${candidate}" is not a safe git ref name.`, { candidate });
  }

  return candidate;
}

/**
 * Wraps untrusted text in a delimiter the text itself cannot forge, for
 * safe embedding inside a generated system message or hook payload — the
 * fix for audit defect D-14 (prompt-injection delimiters). The token is
 * random per call, so content that pre-emptively includes a fake close tag
 * does not actually close the block; only a reader who is given the real
 * (returned) token can find the true boundary.
 */
export function fenceUntrustedText(label: string, text: string): string {
  const token = randomBytes(9).toString('base64url');
  const open = `<<TOKENLENS:${label}:${token}>>`;
  const close = `<<END:${label}:${token}>>`;
  return `${open}\n${text}\n${close}`;
}
