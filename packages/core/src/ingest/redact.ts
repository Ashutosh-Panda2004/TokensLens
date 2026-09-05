import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathExists } from '../shared/io.js';
import { tokenLensDir } from '../shared/config.js';

const SALT_FILE_NAME = 'salt';
const HASH_LENGTH_HEX_CHARS = 16;

/** Absolute path to the per-install salt file inside `.tokenlens/`. */
export function saltFilePath(cwd: string = process.cwd()): string {
  return join(tokenLensDir(cwd), SALT_FILE_NAME);
}

/**
 * Loads the per-install redaction salt, generating and persisting one on
 * first use. **Deliberately per-install, not per-run**: the same real path
 * must hash to the same value across repeated ingests on one machine (so
 * later phases can detect "this file was re-read"), but a different
 * install (different machine or user) produces different hashes for the
 * same path — an org-wide rollup (Phase D5) never sees a value stable
 * enough to brute-force or correlate across users.
 */
export async function loadOrCreateInstallSalt(cwd: string = process.cwd()): Promise<string> {
  const filePath = saltFilePath(cwd);
  if (await pathExists(filePath)) {
    return (await readFile(filePath, 'utf8')).trim();
  }

  const salt = randomBytes(32).toString('hex');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, salt, 'utf8');
  return salt;
}

/**
 * Reduces a path to the one form both sides of every join agree on.
 *
 * ## The defect this exists to fix
 *
 * D12 wired W7's join between the journal's edits and git's commit history,
 * both of which were already hashing paths with the same per-install salt. It
 * detected nothing, on a corpus full of abandoned work, and abstained silently.
 * The reason was that the two sides were hashing *different strings for the same
 * file*: the journal records what the agent wrote — `c:\Users\me\proj\src\a.ts`,
 * or a `file:///` URI — while `git log --numstat` emits a repository-relative
 * POSIX path. Same file, same salt, two hashes, no join, ever.
 *
 * A salted hash is opaque by design, so nothing about the mismatch was visible:
 * the detector saw zero overlap and correctly concluded it could not judge. That
 * is the failure mode this whole codebase is built to avoid — a wrong answer
 * that looks like a cautious one.
 *
 * ## What is normalised, and why each
 *
 * - **URI scheme and percent-encoding** — `file:///c%3A/x` and `c:\x` are one file.
 * - **Separators** — Windows journals use `\`, git always emits `/`.
 * - **Case** — Windows and macOS are case-insensitive, so `SRC/A.ts` and
 *   `src/a.ts` are the same file, and a case difference must not fork the hash.
 *   On Linux this over-merges in the rare case of two paths differing only in
 *   case; that is a knowingly accepted trade, and it fails towards *joining*
 *   rather than towards a silent zero.
 * - **Leading slash before a drive letter** — `/c:/x` is what URI parsing leaves
 *   behind.
 *
 * Applied inside {@link hashPath}, so no caller can forget it.
 */
export function canonicalisePath(rawPath: string): string {
  let path = rawPath.trim();

  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(path);
  if (scheme) path = path.slice(scheme[0].length);

  if (path.includes('%')) {
    try {
      path = decodeURIComponent(path);
    } catch {
      // A stray `%` that is not an escape sequence. The raw form is still a
      // usable key; it simply will not match a percent-encoded twin.
    }
  }

  path = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  path = path.replace(/^\/(?=[a-z]:)/i, '');

  return path.toLowerCase();
}

/**
 * Deterministically hashes `rawPath` given `salt`. Pure — no filesystem
 * access — so callers can test it without touching disk; only
 * {@link loadOrCreateInstallSalt} deals with persistence.
 *
 * The path is canonicalised first ({@link canonicalisePath}) so that the same
 * file hashes identically however it was spelled. Changing this function
 * invalidates every stored hash, which is why doing so carries a migration that
 * clears the ingest cache — see `migrations.ts` v4.
 */
export function hashPath(rawPath: string, salt: string): string {
  return createHash('sha256')
    .update(salt, 'utf8')
    .update(canonicalisePath(rawPath), 'utf8')
    .digest('hex')
    .slice(0, HASH_LENGTH_HEX_CHARS);
}
