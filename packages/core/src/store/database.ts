import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MIGRATIONS } from './migrations.js';
import { tokenLensDir } from '../shared/config.js';
import { LEDGER_DB_FILE_NAME } from '../shared/constants.js';
import type { TurnRecord } from '../model/turn-record.js';

/** Absolute path to the default SQLite ledger file inside `.tokenlens/`. */
export function defaultDatabasePath(cwd: string = process.cwd()): string {
  return join(tokenLensDir(cwd), LEDGER_DB_FILE_NAME);
}

/**
 * Opens (creating if needed) the SQLite ledger and brings it up to the
 * latest schema version. Safe to call repeatedly and concurrently across
 * processes — WAL mode is enabled specifically so a live `tokenlens hook`
 * writer (Phase D6) and a `tokenlens ledger` reader can coexist.
 */
export function openDatabase(filePath: string): Database.Database {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (currentVersion >= MIGRATIONS.length) return;

  const applyPending = db.transaction(() => {
    for (let version = currentVersion; version < MIGRATIONS.length; version++) {
      const migration = MIGRATIONS[version];
      if (migration) db.exec(migration);
    }
    db.pragma(`user_version = ${String(MIGRATIONS.length)}`);
  });
  applyPending();
}

export interface IngestedFileState {
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  readonly contentHash: string;
}

interface IngestedFileRow {
  readonly mtimeMs: number;
  readonly sizeBytes: number;
  readonly contentHash: string;
}

/** Looks up the last-known state of a journal file, for the incremental-ingest skip check (Phase D1.7). */
export function getIngestedFileState(
  db: Database.Database,
  filePath: string,
): IngestedFileState | undefined {
  return db
    .prepare(
      `SELECT mtime_ms AS mtimeMs, size_bytes AS sizeBytes, content_hash AS contentHash
       FROM ingested_file WHERE file_path = ?`,
    )
    .get(filePath) as IngestedFileRow | undefined;
}

/** Records (or updates) a journal file's ingested state. */
export function recordIngestedFile(
  db: Database.Database,
  filePath: string,
  state: IngestedFileState,
  ingestedAt: number = Date.now(),
): void {
  db.prepare(
    `INSERT INTO ingested_file (file_path, mtime_ms, size_bytes, content_hash, last_ingested_at)
     VALUES (@filePath, @mtimeMs, @sizeBytes, @contentHash, @ingestedAt)
     ON CONFLICT(file_path) DO UPDATE SET
       mtime_ms = @mtimeMs, size_bytes = @sizeBytes, content_hash = @contentHash, last_ingested_at = @ingestedAt`,
  ).run({ filePath, ...state, ingestedAt });
}

export interface RequestRow {
  readonly requestId: string;
  readonly sessionId: string;
  readonly ts: number;
  readonly model: string;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly credits: number | null;
  readonly turnIndex: number;
  readonly sourceFile: string;
  readonly sourceOffset: number;
}

const REQUEST_COLUMNS = `
  request_id     AS requestId,
  session_id     AS sessionId,
  ts             AS ts,
  model          AS model,
  prompt_tokens  AS promptTokens,
  output_tokens  AS outputTokens,
  credits        AS credits,
  turn_index     AS turnIndex,
  source_file    AS sourceFile,
  source_offset  AS sourceOffset
`;

/** Looks up one request by id — the primitive `tokenlens verify` is built on. */
export function getRequestById(db: Database.Database, requestId: string): RequestRow | undefined {
  return db
    .prepare(`SELECT ${REQUEST_COLUMNS} FROM request WHERE request_id = ?`)
    .get(requestId) as RequestRow | undefined;
}

/** All requests, most-expensive-credits-first — the primitive `tokenlens sessions --top` is built on. */
export function getAllRequests(db: Database.Database): RequestRow[] {
  return db.prepare(`SELECT ${REQUEST_COLUMNS} FROM request ORDER BY ts ASC`).all() as RequestRow[];
}

export interface CostCentreRow {
  readonly requestId: string;
  readonly category: string;
  readonly label: string;
  readonly percentageOfPrompt: number;
  readonly tokens: number;
}

/** Every cost-centre row across every request — the primitive the ledger's "by cost centre" view is built on. */
export function getAllCostCentres(db: Database.Database): CostCentreRow[] {
  return db
    .prepare(
      `SELECT
         request_id            AS requestId,
         category              AS category,
         label                 AS label,
         percentage_of_prompt  AS percentageOfPrompt,
         tokens                AS tokens
       FROM cost_centre`,
    )
    .all() as CostCentreRow[];
}

export interface ToolCallRow {
  readonly requestId: string;
  readonly sessionId: string;
  readonly ts: number;
  readonly roundId: string;
  readonly toolCallId: string;
  readonly name: string;
  /** Measured character length of the recorded result. Null when the journal recorded none. */
  readonly resultChars: number | null;
  readonly targetFileHash: string | null;
  readonly targetStartLine: number | null;
  readonly targetEndLine: number | null;
}

/**
 * Every tool call, joined to its session and timestamp — the primitive
 * W1 (tool-definition tax), W2 (duplicate retrieval) and W3 (oversized
 * payloads) are all built on. Ordered so that per-session walks see calls
 * in the order they actually happened, which is what lets W2 distinguish
 * a first read from a re-read.
 */
export function getAllToolCalls(db: Database.Database): ToolCallRow[] {
  return db
    .prepare(
      `SELECT
         tc.request_id        AS requestId,
         r.session_id         AS sessionId,
         r.ts                 AS ts,
         tc.round_id          AS roundId,
         tc.tool_call_id      AS toolCallId,
         tc.name              AS name,
         tc.result_chars      AS resultChars,
         tc.target_file_hash  AS targetFileHash,
         tc.target_start_line AS targetStartLine,
         tc.target_end_line   AS targetEndLine
       FROM tool_call tc
       JOIN request r ON r.request_id = tc.request_id
       ORDER BY r.ts ASC, tc.request_id ASC, tc.round_id ASC`,
    )
    .all() as ToolCallRow[];
}

export interface RoundRow {
  readonly requestId: string;
  readonly roundId: string;
  readonly ts: number;
  readonly modelId: string | null;
  readonly thinkingTokens: number | null;
  readonly retries: number;
}

/** Every tool-call round — the primitive W6 (runaway loops) counts over. */
export function getAllRounds(db: Database.Database): RoundRow[] {
  return db
    .prepare(
      `SELECT
         request_id      AS requestId,
         round_id        AS roundId,
         ts              AS ts,
         model_id        AS modelId,
         thinking_tokens AS thinkingTokens,
         retries         AS retries
       FROM round`,
    )
    .all() as RoundRow[];
}

export interface EditRow {
  readonly requestId: string;
  readonly fileHash: string;
  readonly editCount: number;
  /** SQLite stores booleans as 0/1. */
  readonly done: number;
}

/** Every edit — the primitive W6 uses to ask "did this loop actually produce anything?". */
export function getAllEdits(db: Database.Database): EditRow[] {
  return db
    .prepare(
      `SELECT
         request_id AS requestId,
         file_hash  AS fileHash,
         edit_count AS editCount,
         done       AS done
       FROM edit`,
    )
    .all() as EditRow[];
}

export interface CompactionRow {
  readonly requestId: string;
  readonly toolCallRoundId: string;
  readonly model: string;
  readonly numRounds: number;
  readonly durationMs: number;
  readonly outcome: string;
  readonly contextLengthBefore: number;
}

/** Every compaction event — the primitive W9 (compaction overhead) prices. */
export function getAllCompactions(db: Database.Database): CompactionRow[] {
  return db
    .prepare(
      `SELECT
         request_id            AS requestId,
         tool_call_round_id    AS toolCallRoundId,
         model                 AS model,
         num_rounds            AS numRounds,
         duration_ms           AS durationMs,
         outcome               AS outcome,
         context_length_before AS contextLengthBefore
       FROM compaction`,
    )
    .all() as CompactionRow[];
}

export interface ContentReferenceRow {
  readonly requestId: string;
  readonly fileHash: string;
}

/** Every file the model was shown as a reference — the primitive W11 needs. */
export function getAllContentReferences(db: Database.Database): ContentReferenceRow[] {
  return db
    .prepare(
      `SELECT
         request_id AS requestId,
         file_hash  AS fileHash
       FROM content_reference`,
    )
    .all() as ContentReferenceRow[];
}

/**
 * Persists `records` transactionally. Each request is fully replaced
 * (delete-then-insert its child rows) rather than diffed, which is what
 * makes re-ingestion idempotent (Phase D1.7): running the same journal
 * through twice yields byte-identical tables, not duplicated children.
 */
export function saveTurnRecords(db: Database.Database, records: readonly TurnRecord[]): void {
  const upsertSession = db.prepare(`
    INSERT INTO session (session_id, first_seen_at, last_seen_at)
    VALUES (@sessionId, @ts, @ts)
    ON CONFLICT(session_id) DO UPDATE SET
      first_seen_at = MIN(first_seen_at, @ts),
      last_seen_at = MAX(last_seen_at, @ts)
  `);

  const upsertRequest = db.prepare(`
    INSERT OR REPLACE INTO request
      (request_id, session_id, ts, model, prompt_tokens, output_tokens, credits, turn_index, source_file, source_offset)
    VALUES
      (@requestId, @sessionId, @ts, @model, @promptTokens, @outputTokens, @credits, @turnIndex, @sourceFile, @sourceOffset)
  `);

  const deleteCostCentres = db.prepare(`DELETE FROM cost_centre WHERE request_id = ?`);
  const insertCostCentre = db.prepare(`
    INSERT INTO cost_centre (request_id, category, label, percentage_of_prompt, tokens)
    VALUES (@requestId, @category, @label, @percentageOfPrompt, @tokens)
  `);

  const deleteToolCalls = db.prepare(`DELETE FROM tool_call WHERE request_id = ?`);
  const deleteRounds = db.prepare(`DELETE FROM round WHERE request_id = ?`);
  const insertRound = db.prepare(`
    INSERT INTO round (request_id, round_id, ts, model_id, thinking_tokens, retries)
    VALUES (@requestId, @roundId, @ts, @modelId, @thinkingTokens, @retries)
  `);
  const insertToolCall = db.prepare(`
    INSERT INTO tool_call (request_id, round_id, tool_call_id, name, result_chars, target_file_hash, target_start_line, target_end_line)
    VALUES (@requestId, @roundId, @toolCallId, @name, @resultChars, @targetFileHash, @targetStartLine, @targetEndLine)
  `);

  const deleteEdits = db.prepare(`DELETE FROM edit WHERE request_id = ?`);
  const insertEdit = db.prepare(`
    INSERT INTO edit (request_id, file_hash, edit_count, done)
    VALUES (@requestId, @fileHash, @editCount, @done)
  `);

  const deleteCompactions = db.prepare(`DELETE FROM compaction WHERE request_id = ?`);
  const insertCompaction = db.prepare(`
    INSERT INTO compaction (request_id, tool_call_round_id, model, num_rounds, duration_ms, outcome, context_length_before)
    VALUES (@requestId, @toolCallRoundId, @model, @numRounds, @durationMs, @outcome, @contextLengthBefore)
  `);

  const deleteContentRefs = db.prepare(`DELETE FROM content_reference WHERE request_id = ?`);
  const insertContentRef = db.prepare(`
    INSERT INTO content_reference (request_id, file_hash)
    VALUES (@requestId, @fileHash)
  `);

  const insertAll = db.transaction((batch: readonly TurnRecord[]) => {
    for (const record of batch) {
      upsertSession.run({ sessionId: record.sessionId, ts: record.ts });
      upsertRequest.run({
        requestId: record.requestId,
        sessionId: record.sessionId,
        ts: record.ts,
        model: record.model,
        promptTokens: record.promptTokens,
        outputTokens: record.outputTokens,
        credits: record.credits ?? null,
        turnIndex: record.turnIndex,
        sourceFile: record.source.file,
        sourceOffset: record.source.offset,
      });

      deleteCostCentres.run(record.requestId);
      for (const centre of record.costCentres) {
        insertCostCentre.run({ requestId: record.requestId, ...centre });
      }

      deleteToolCalls.run(record.requestId);
      deleteRounds.run(record.requestId);
      for (const round of record.rounds) {
        insertRound.run({
          requestId: record.requestId,
          roundId: round.id,
          ts: round.ts,
          modelId: round.modelId ?? null,
          thinkingTokens: round.thinkingTokens ?? null,
          retries: round.retries,
        });
        for (const call of round.toolCalls) {
          insertToolCall.run({
            requestId: record.requestId,
            roundId: round.id,
            toolCallId: call.id,
            name: call.name,
            resultChars: call.resultChars ?? null,
            targetFileHash: call.targetFileHash ?? null,
            targetStartLine: call.targetStartLine ?? null,
            targetEndLine: call.targetEndLine ?? null,
          });
        }
      }

      deleteEdits.run(record.requestId);
      for (const edit of record.edits) {
        insertEdit.run({
          requestId: record.requestId,
          fileHash: edit.fileHash,
          editCount: edit.editCount,
          done: edit.done ? 1 : 0,
        });
      }

      deleteCompactions.run(record.requestId);
      for (const compaction of record.compactions) {
        insertCompaction.run({ requestId: record.requestId, ...compaction });
      }

      deleteContentRefs.run(record.requestId);
      for (const reference of record.contentReferences) {
        insertContentRef.run({ requestId: record.requestId, fileHash: reference.fileHash });
      }
    }
  });

  insertAll(records);
}
