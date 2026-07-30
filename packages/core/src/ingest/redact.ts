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
 * Deterministically hashes `rawPath` given `salt`. Pure — no filesystem
 * access — so callers can test it without touching disk; only
 * {@link loadOrCreateInstallSalt} deals with persistence.
 */
export function hashPath(rawPath: string, salt: string): string {
  return createHash('sha256')
    .update(salt, 'utf8')
    .update(rawPath, 'utf8')
    .digest('hex')
    .slice(0, HASH_LENGTH_HEX_CHARS);
}
