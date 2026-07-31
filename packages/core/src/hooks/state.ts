import Database from 'better-sqlite3';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tokenLensDir } from '../shared/config.js';

/**
 * State for the runtime guards, in a database of its own.
 *
 * ## Why not the ledger
 *
 * The hook runs on **every tool call** with a hard budget of 50 ms at p99.
 * The ledger database is large, its open path applies migrations, and the
 * commands that use it run a full journal ingest first. None of that can be
 * anywhere near this code path.
 *
 * So the guards get a separate, small, WAL-mode database that opens in
 * about a millisecond and contains only what a decision needs. It is
 * disposable by design: deleting it costs nothing but a cold start, because
 * every durable figure lives in the ledger, which is rebuilt from journals
 * on disk.
 *
 * WAL matters for a second reason. Several agent processes can be running
 * concurrently in one workspace, and a rollback-journal database would have
 * them blocking each other inside the latency budget.
 */
const SCHEMA_VERSION = 1;
const FILE_NAME = 'guards.sqlite3';

export function guardStatePath(cwd: string = process.cwd()): string {
  return join(tokenLensDir(cwd), FILE_NAME);
}

export function openGuardState(filePath: string): Database.Database {
  if (filePath !== ':memory:') {
    mkdirSync(join(filePath, '..'), { recursive: true });
  }

  const db = new Database(filePath);
  // Every one of these is a latency decision, not a preference.
  db.pragma('journal_mode = WAL');
  // `normal` fsyncs at checkpoints rather than every commit. A guard losing
  // its last few observations after a power cut costs one redundant read;
  // paying a full fsync on every tool call costs the whole budget.
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 2000');

  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  const current = (db.pragma('user_version', { simple: true }) as number | undefined) ?? 0;
  if (current >= SCHEMA_VERSION) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS observed_read (
      session_id   TEXT    NOT NULL,
      file_hash    TEXT    NOT NULL,
      start_line   INTEGER NOT NULL,
      end_line     INTEGER NOT NULL,
      content_hash TEXT    NOT NULL,
      turn         INTEGER NOT NULL,
      ts           INTEGER NOT NULL,
      PRIMARY KEY (session_id, file_hash, start_line, end_line)
    );

    CREATE TABLE IF NOT EXISTS session_state (
      session_id   TEXT PRIMARY KEY,
      rounds       INTEGER NOT NULL DEFAULT 0,
      edits        INTEGER NOT NULL DEFAULT 0,
      turns        INTEGER NOT NULL DEFAULT 0,
      compactions  INTEGER NOT NULL DEFAULT 0,
      started_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      halted       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS decision_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      session_id TEXT    NOT NULL,
      rule       TEXT    NOT NULL,
      event      TEXT    NOT NULL,
      decision   TEXT    NOT NULL,
      tool_name  TEXT,
      subject    TEXT,
      evidence   TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decision_rule ON decision_log(rule, ts);
    CREATE INDEX IF NOT EXISTS idx_decision_subject ON decision_log(session_id, rule, subject, ts);

    CREATE TABLE IF NOT EXISTS rule_health (
      rule             TEXT PRIMARY KEY,
      interventions    INTEGER NOT NULL DEFAULT 0,
      reversals        INTEGER NOT NULL DEFAULT 0,
      disabled_at      INTEGER,
      disabled_reason  TEXT
    );
  `);

  db.pragma(`user_version = ${String(SCHEMA_VERSION)}`);
}

export interface ObservedRead {
  readonly contentHash: string;
  readonly turn: number;
  readonly ts: number;
}

export function findObservedRead(
  db: Database.Database,
  sessionId: string,
  fileHash: string,
  startLine: number,
  endLine: number,
): ObservedRead | undefined {
  return db
    .prepare(
      `SELECT content_hash AS contentHash, turn, ts
         FROM observed_read
        WHERE session_id = ? AND file_hash = ? AND start_line = ? AND end_line = ?`,
    )
    .get(sessionId, fileHash, startLine, endLine) as ObservedRead | undefined;
}

export function recordObservedRead(
  db: Database.Database,
  sessionId: string,
  fileHash: string,
  startLine: number,
  endLine: number,
  contentHash: string,
  turn: number,
  ts: number,
): void {
  db.prepare(
    `INSERT INTO observed_read (session_id, file_hash, start_line, end_line, content_hash, turn, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, file_hash, start_line, end_line)
     DO UPDATE SET content_hash = excluded.content_hash, turn = excluded.turn, ts = excluded.ts`,
  ).run(sessionId, fileHash, startLine, endLine, contentHash, turn, ts);
}

/** Undoes a recorded read when the tool it was recorded for then failed. */
export function forgetObservedRead(
  db: Database.Database,
  sessionId: string,
  fileHash: string,
): void {
  db.prepare(`DELETE FROM observed_read WHERE session_id = ? AND file_hash = ?`).run(
    sessionId,
    fileHash,
  );
}

export interface SessionState {
  readonly sessionId: string;
  readonly rounds: number;
  readonly edits: number;
  readonly turns: number;
  readonly compactions: number;
  readonly startedAt: number;
  readonly lastSeenAt: number;
  readonly halted: number;
}

export function getSessionState(
  db: Database.Database,
  sessionId: string,
): SessionState | undefined {
  return db
    .prepare(
      `SELECT session_id AS sessionId, rounds, edits, turns, compactions,
              started_at AS startedAt, last_seen_at AS lastSeenAt, halted
         FROM session_state WHERE session_id = ?`,
    )
    .get(sessionId) as SessionState | undefined;
}

export type SessionCounter = 'rounds' | 'edits' | 'turns' | 'compactions';

/**
 * Bumps a counter, creating the row if this is the first thing seen for the
 * session. One statement, so two concurrent agent processes cannot lose an
 * increment between a read and a write.
 */
export function bumpSession(
  db: Database.Database,
  sessionId: string,
  counter: SessionCounter,
  now: number,
  by = 1,
): void {
  db.prepare(
    `INSERT INTO session_state (session_id, ${counter}, started_at, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE
       SET ${counter} = ${counter} + excluded.${counter},
           last_seen_at = excluded.last_seen_at`,
  ).run(sessionId, by, now, now);
}

export function markSessionHalted(db: Database.Database, sessionId: string, now: number): void {
  db.prepare(
    `INSERT INTO session_state (session_id, halted, started_at, last_seen_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET halted = 1, last_seen_at = excluded.last_seen_at`,
  ).run(sessionId, now, now);
}

export interface DecisionRecord {
  readonly ts: number;
  readonly sessionId: string;
  readonly rule: string;
  readonly event: string;
  readonly decision: string;
  readonly toolName?: string;
  /** What the decision was about — the key the insistence check counts on. */
  readonly subject?: string;
  readonly evidence: string;
}

/**
 * Every intervention is logged with the evidence that produced it (H-5).
 *
 * Not for compliance theatre: a guard that blocks a tool call and cannot
 * afterwards say exactly why is one nobody will leave enabled after the
 * first false positive.
 */
export function logDecision(db: Database.Database, record: DecisionRecord): void {
  db.prepare(
    `INSERT INTO decision_log (ts, session_id, rule, event, decision, tool_name, subject, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.ts,
    record.sessionId,
    record.rule,
    record.event,
    record.decision,
    record.toolName ?? null,
    record.subject ?? null,
    record.evidence,
  );
}

/**
 * How many times this rule has already refused this exact thing in this
 * session — the raw material of the insistence check.
 */
export function countDenials(
  db: Database.Database,
  sessionId: string,
  rule: string,
  subject: string,
  since: number,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM decision_log
        WHERE session_id = ? AND rule = ? AND subject = ? AND decision = 'deny' AND ts >= ?`,
    )
    .get(sessionId, rule, subject, since) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function readDecisionLog(db: Database.Database, limit = 50): DecisionRecord[] {
  return db
    .prepare(
      `SELECT ts, session_id AS sessionId, rule, event, decision,
              tool_name AS toolName, subject, evidence
         FROM decision_log ORDER BY ts DESC, id DESC LIMIT ?`,
    )
    .all(limit) as DecisionRecord[];
}

export interface RuleHealth {
  readonly rule: string;
  readonly interventions: number;
  readonly reversals: number;
  readonly disabledAt: number | null;
  readonly disabledReason: string | null;
}

export function getRuleHealth(db: Database.Database, rule: string): RuleHealth | undefined {
  return db
    .prepare(
      `SELECT rule, interventions, reversals,
              disabled_at AS disabledAt, disabled_reason AS disabledReason
         FROM rule_health WHERE rule = ?`,
    )
    .get(rule) as RuleHealth | undefined;
}

export function allRuleHealth(db: Database.Database): RuleHealth[] {
  return db
    .prepare(
      `SELECT rule, interventions, reversals,
              disabled_at AS disabledAt, disabled_reason AS disabledReason
         FROM rule_health ORDER BY rule`,
    )
    .all() as RuleHealth[];
}

export function bumpRule(
  db: Database.Database,
  rule: string,
  field: 'interventions' | 'reversals',
): void {
  db.prepare(
    `INSERT INTO rule_health (rule, ${field}) VALUES (?, 1)
     ON CONFLICT(rule) DO UPDATE SET ${field} = ${field} + 1`,
  ).run(rule);
}

export function disableRule(
  db: Database.Database,
  rule: string,
  reason: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO rule_health (rule, disabled_at, disabled_reason) VALUES (?, ?, ?)
     ON CONFLICT(rule) DO UPDATE SET disabled_at = excluded.disabled_at,
                                     disabled_reason = excluded.disabled_reason`,
  ).run(rule, now, reason);
}

export function enableRule(db: Database.Database, rule: string): void {
  db.prepare(
    `UPDATE rule_health SET disabled_at = NULL, disabled_reason = NULL, reversals = 0 WHERE rule = ?`,
  ).run(rule);
}
