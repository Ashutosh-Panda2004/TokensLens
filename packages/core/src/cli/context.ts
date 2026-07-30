import { openDatabase, defaultDatabasePath } from '../store/database.js';
import { ingestAllDiscovered } from '../ingest/pipeline.js';
import { logger } from '../shared/logger.js';
import type Database from 'better-sqlite3';

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
