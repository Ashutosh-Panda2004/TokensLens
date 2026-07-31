import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * Reading a file inside the hook's latency budget, safely.
 *
 * Two constraints collide here. The path came from the agent, so it is
 * untrusted and must not be allowed to escape the workspace. And the read
 * happens on every tool call, so it must not blow a 50 ms budget on a
 * 200 MB file.
 */

/**
 * Above this, the file is not hashed and the guard declines to have an
 * opinion. Reading and hashing 2 MB costs a few milliseconds; reading a
 * large binary costs the whole budget, and a guard that makes the agent
 * slower than the waste it prevents is a net loss.
 */
export const MAX_HASH_BYTES = 2 * 1024 * 1024;

export interface FileFingerprint {
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly lineCount: number;
}

/**
 * Resolves an agent-supplied path against a root, refusing anything that
 * escapes it.
 *
 * Deliberately a local check rather than `shared/safe.ts`'s
 * `assertContained`: that one throws, and inside a hook a throw is a
 * failure mode rather than a control-flow tool. The containment rule is the
 * same, including the `root + sep` anchor that stops `/a/b` admitting
 * `/a/b-evil`.
 */
export function resolveWithinRoot(root: string, candidate: string): string | undefined {
  let resolved: string;
  try {
    resolved = resolve(root, candidate);
  } catch {
    return undefined;
  }

  const rootResolved = resolve(root);
  const contained = resolved === rootResolved || resolved.startsWith(rootResolved + sep);
  return contained ? resolved : undefined;
}

/**
 * Hashes a file's content, or a line range of it.
 *
 * Returns `undefined` for anything unreadable, too large, or not a regular
 * file. Every one of those is a reason for the guard to stay out of the way,
 * not a reason to fail.
 */
export function fingerprintFile(
  absolutePath: string,
  startLine?: number,
  endLine?: number,
): FileFingerprint | undefined {
  let sizeBytes: number;
  try {
    const stats = statSync(absolutePath);
    if (!stats.isFile()) return undefined;
    sizeBytes = stats.size;
  } catch {
    return undefined;
  }

  if (sizeBytes > MAX_HASH_BYTES) return undefined;

  let contents: string;
  try {
    contents = readFileSync(absolutePath, 'utf8');
  } catch {
    return undefined;
  }

  const lines = contents.split('\n');
  const selected =
    startLine === undefined && endLine === undefined
      ? contents
      : lines.slice(Math.max(0, (startLine ?? 1) - 1), endLine ?? lines.length).join('\n');

  return {
    contentHash: createHash('sha256').update(selected, 'utf8').digest('hex').slice(0, 16),
    sizeBytes,
    lineCount: lines.length,
  };
}

/** Size in bytes without reading the file, for the payload guard's estimate. */
export function fileSize(absolutePath: string): number | undefined {
  try {
    const stats = statSync(absolutePath);
    return stats.isFile() ? stats.size : undefined;
  } catch {
    return undefined;
  }
}
