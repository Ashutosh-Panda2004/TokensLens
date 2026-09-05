import { openDatabase, defaultDatabasePath } from '../store/database.js';
import { ingestAllDiscovered } from '../ingest/pipeline.js';
import { loadOrCreateInstallSalt } from '../ingest/redact.js';
import { isGitRepository, readGitHistory } from '../outcomes/git.js';
import { buildGitSurvival } from '../waste/git-survival.js';
import { logger } from '../shared/logger.js';
import type Database from 'better-sqlite3';
import type { DetectContextInputs } from '../waste/context.js';

/**
 * Shared setup for every reporting command (`ledger`, `sessions`,
 * `verify`, `budget`): open the local SQLite ledger and sync it against
 * whatever journal files exist on this machine before answering. Ingest
 * is always run, never a separate step the user has to remember —
 * Phase D1.7's incremental skip logic is what keeps this cheap on repeat
 * runs.
 */
export async function openLedgerForReading(): Promise<Database.Database> {
  const db = openDatabase(defaultDatabasePath());

  const summary = await ingestAllDiscovered(db);
  logger.debug(
    `ingest: ${String(summary.filesIngested)} file(s) read, ` +
      `${String(summary.filesSkippedUnchanged)} unchanged, ` +
      `${String(summary.totalRecords)} record(s), ` +
      `${String(summary.totalDriftErrors)} drift warning(s)`,
  );
  if (summary.totalDriftErrors > 0) {
    logger.warn(
      `${String(summary.totalDriftErrors)} schema-drift event(s) during ingest (a request or a whole ` +
        'file did not match the expected shape and was skipped) — run with TOKENLENS_LOG_LEVEL=debug for detail.',
    );
  }

  return db;
}

/**
 * Reads the external evidence D12's detectors cannot fetch for themselves.
 *
 * This is the impure half, kept here rather than in `src/waste` so the
 * guarantee that a detector "physically cannot reach the network or the
 * filesystem" survives D12 intact. Git is a subprocess; the detector must never
 * be the thing that starts one.
 *
 * Failure is not an error. Running outside a repository, or against a
 * repository git refuses to read, simply means W7 is unavailable for this run —
 * and `conditionallyUnavailable()` then says so by name, with what would change
 * it. A waste report that refused to run because there was no `.git` directory
 * would be a worse product than one that reports eleven classes instead of
 * twelve.
 */
export async function collectDetectInputs(
  cwd: string = process.cwd(),
): Promise<DetectContextInputs> {
  try {
    if (!(await isGitRepository(cwd))) return {};
    const salt = await loadOrCreateInstallSalt(cwd);
    const commits = await readGitHistory({ cwd }, salt);
    logger.debug(`git: ${String(commits.length)} commit(s) read for W7 survival`);
    return { git: buildGitSurvival(commits) };
  } catch (error) {
    logger.debug(
      `git history unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}
