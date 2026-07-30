import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { logger } from './logger.js';

/** True if `filepath` exists and is accessible; false otherwise. Never throws. */
export async function pathExists(filepath: string): Promise<boolean> {
  try {
    await access(filepath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a newline-delimited JSON (JSONL) file, skipping blank and malformed
 * lines. Returns `[]` if the file does not exist.
 *
 * This is deliberately forgiving: a single corrupted tail line (e.g. from a
 * process killed mid-append) must not invalidate every earlier record in
 * what may be a large, continuously-appended telemetry file.
 */
export async function readJsonl<T>(filepath: string): Promise<T[]> {
  if (!(await pathExists(filepath))) return [];

  const raw = await readFile(filepath, 'utf8');
  const records: T[] = [];
  let lineNumber = 0;
  let skipped = 0;

  for (const line of raw.split('\n')) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      skipped += 1;
      logger.debug(`Skipping malformed JSONL line ${String(lineNumber)} in ${filepath}`);
    }
  }

  if (skipped > 0) {
    logger.warn(`Skipped ${String(skipped)} malformed line(s) while reading ${filepath}`);
  }

  return records;
}

export interface ReadJsonOptions {
  /**
   * `'warn'` (default) — log and return `fallback` on parse failure; the
   * graceful-degradation contract for bulk/telemetry data (ingest).
   * `'throw'` — propagate the parse error; for user-authored files where a
   * silent fallback would hide a mistake the user needs to know about.
   */
  onParseError?: 'warn' | 'throw';
}

/**
 * Reads and parses a JSON document, returning `fallback` if the file does
 * not exist. See {@link ReadJsonOptions.onParseError} for what happens if
 * it exists but is not valid JSON.
 */
export async function readJsonFileOrDefault<T>(
  filepath: string,
  fallback: T,
  options: ReadJsonOptions = {},
): Promise<T> {
  const onParseError = options.onParseError ?? 'warn';
  if (!(await pathExists(filepath))) return fallback;

  const raw = await readFile(filepath, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    if (onParseError === 'throw') throw error;
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`Failed to parse ${filepath}: ${reason}. Using fallback.`);
    return fallback;
  }
}

/**
 * Writes `data` as pretty-printed JSON, atomically: the payload is written
 * to a temporary file in the same directory and then renamed into place, so
 * a crash or a concurrent reader never observes a partially-written file.
 * Creates parent directories as needed.
 */
export async function writeJsonFileAtomic(filepath: string, data: unknown): Promise<void> {
  const dir = dirname(filepath);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(
    dir,
    `.${basename(filepath)}.${String(process.pid)}.${String(Date.now())}.tmp`,
  );

  try {
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(tmpPath, filepath);
  } catch (error) {
    await unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}
