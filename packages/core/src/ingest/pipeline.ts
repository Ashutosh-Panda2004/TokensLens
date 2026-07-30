import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { discoverChatSessionDirs } from './discovery.js';
import { parseJournalBuffer } from './reader.js';
import { normaliseJournal } from './normalise.js';
import { loadOrCreateInstallSalt } from './redact.js';
import { getIngestedFileState, recordIngestedFile, saveTurnRecords } from '../store/database.js';
import { SchemaDriftError } from '../shared/errors.js';

export interface IngestFileResult {
  readonly file: string;
  readonly skippedUnchanged: boolean;
  readonly recordCount: number;
  readonly driftErrors: readonly SchemaDriftError[];
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Ingests one journal file, end to end: read → parse/replay → normalise
 * → persist. Skips the read entirely when the file's mtime, size, *and*
 * content hash all match the last recorded ingest (Phase D1.7) — mtime
 * and size are compared first since they're free (already have `stat`),
 * the hash is the tie-breaker for filesystems with coarse mtime
 * resolution.
 *
 * Never throws for a *drift* reason — a file-level failure (e.g. no
 * snapshot line at all) is folded into the returned `driftErrors`, the
 * same place a per-request failure lands, so every file this function is
 * called on always contributes exactly one `IngestFileResult` to the
 * caller's summary. It still throws for genuine I/O failures (the file
 * disappearing mid-read, a permissions error, etc.) — those are not data
 * problems and should not be silently absorbed.
 *
 * A file that fails at the whole-document level is still recorded as
 * "ingested" at its current mtime/hash: retrying it forever would be
 * pointless (it will only ever succeed again if its content changes,
 * which the unchanged-check already detects).
 *
 * Exported at file granularity (not just as part of the "ingest
 * everything" sweep) because it's what makes ingest independently
 * testable against a single fixture file, with no discovery involved.
 */
export async function ingestFile(
  db: Database.Database,
  filePath: string,
  salt: string,
): Promise<IngestFileResult> {
  const stats = await stat(filePath);
  const buffer = await readFile(filePath);
  const contentHash = sha256(buffer);

  const previous = getIngestedFileState(db, filePath);
  const unchanged =
    previous?.mtimeMs === stats.mtimeMs &&
    previous.sizeBytes === stats.size &&
    previous.contentHash === contentHash;

  if (unchanged) {
    return { file: filePath, skippedUnchanged: true, recordCount: 0, driftErrors: [] };
  }

  const parsed = parseJournalBuffer(buffer, filePath);
  const fileState = { mtimeMs: stats.mtimeMs, sizeBytes: stats.size, contentHash };

  try {
    const { records, driftErrors } = normaliseJournal(parsed, salt);
    saveTurnRecords(db, records);
    recordIngestedFile(db, filePath, fileState);
    return { file: filePath, skippedUnchanged: false, recordCount: records.length, driftErrors };
  } catch (error) {
    if (error instanceof SchemaDriftError) {
      recordIngestedFile(db, filePath, fileState);
      return { file: filePath, skippedUnchanged: false, recordCount: 0, driftErrors: [error] };
    }
    throw error;
  }
}

export interface IngestSummary {
  readonly filesConsidered: number;
  readonly filesIngested: number;
  readonly filesSkippedUnchanged: number;
  readonly totalRecords: number;
  readonly totalDriftErrors: number;
  readonly results: readonly IngestFileResult[];
}

function summarise(results: readonly IngestFileResult[]): IngestSummary {
  return {
    filesConsidered: results.length,
    filesIngested: results.filter((r) => !r.skippedUnchanged).length,
    filesSkippedUnchanged: results.filter((r) => r.skippedUnchanged).length,
    totalRecords: results.reduce((sum, r) => sum + r.recordCount, 0),
    totalDriftErrors: results.reduce((sum, r) => sum + r.driftErrors.length, 0),
    results,
  };
}

/**
 * Discovers every `chatSessions` directory this machine has (Phase D1.2)
 * and ingests every file found in each. `ingestFile` never throws for a
 * drift reason (see its own doc comment), so a malformed session's
 * failure is reflected in the returned summary's `totalDriftErrors`
 * rather than aborting the sweep — one bad file must not hide the other
 * 101.
 *
 * `roots` defaults to the real, OS-specific `workspaceStorage` locations
 * (see `discovery.ts`) and should only ever be overridden in tests —
 * production callers must always scan the real machine.
 */
export async function ingestAllDiscovered(
  db: Database.Database,
  cwd: string = process.cwd(),
  roots?: readonly string[],
): Promise<IngestSummary> {
  const salt = await loadOrCreateInstallSalt(cwd);
  const workspaces = await discoverChatSessionDirs(roots);
  const results: IngestFileResult[] = [];

  for (const workspace of workspaces) {
    let entries: string[];
    try {
      entries = await readdir(workspace.chatSessionsDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const filePath = join(workspace.chatSessionsDir, entry);
      results.push(await ingestFile(db, filePath, salt));
    }
  }

  return summarise(results);
}
