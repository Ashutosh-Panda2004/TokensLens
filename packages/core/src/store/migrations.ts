/**
 * Ordered schema migrations, applied via SQLite's `PRAGMA user_version`
 * (array index + 1 == version — no extra migration-tracking table
 * needed). Each entry is a batch of DDL statements run inside one
 * transaction; append new entries here in Phase D3+ rather than editing
 * an existing one — SQLite's `PRAGMA user_version` means a machine that
 * already applied version N never re-runs it.
 */
export const MIGRATIONS: readonly string[] = [
  // v1 — Phase D1: the credit ledger's own tables.
  `
  CREATE TABLE IF NOT EXISTS ingested_file (
    file_path        TEXT PRIMARY KEY,
    mtime_ms         INTEGER NOT NULL,
    size_bytes       INTEGER NOT NULL,
    content_hash     TEXT NOT NULL,
    last_ingested_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session (
    session_id    TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS request (
    request_id     TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL REFERENCES session(session_id),
    ts             INTEGER NOT NULL,
    model          TEXT NOT NULL,
    prompt_tokens  INTEGER NOT NULL,
    output_tokens  INTEGER NOT NULL,
    credits        REAL,
    turn_index     INTEGER NOT NULL,
    source_file    TEXT NOT NULL,
    source_offset  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_request_session ON request(session_id);
  CREATE INDEX IF NOT EXISTS idx_request_ts ON request(ts);
  CREATE INDEX IF NOT EXISTS idx_request_model ON request(model);

  CREATE TABLE IF NOT EXISTS cost_centre (
    request_id           TEXT NOT NULL REFERENCES request(request_id),
    category              TEXT NOT NULL,
    label                 TEXT NOT NULL,
    percentage_of_prompt  REAL NOT NULL,
    tokens                INTEGER NOT NULL,
    PRIMARY KEY (request_id, label)
  );

  CREATE TABLE IF NOT EXISTS round (
    request_id       TEXT NOT NULL REFERENCES request(request_id),
    round_id         TEXT NOT NULL,
    ts               INTEGER NOT NULL,
    model_id         TEXT,
    thinking_tokens  INTEGER,
    retries          INTEGER NOT NULL,
    PRIMARY KEY (request_id, round_id)
  );

  CREATE TABLE IF NOT EXISTS tool_call (
    request_id    TEXT NOT NULL,
    round_id      TEXT NOT NULL,
    tool_call_id  TEXT NOT NULL,
    name          TEXT NOT NULL,
    PRIMARY KEY (request_id, round_id, tool_call_id),
    FOREIGN KEY (request_id, round_id) REFERENCES round(request_id, round_id)
  );

  CREATE TABLE IF NOT EXISTS edit (
    request_id  TEXT NOT NULL REFERENCES request(request_id),
    file_hash   TEXT NOT NULL,
    edit_count  INTEGER NOT NULL,
    done        INTEGER NOT NULL,
    PRIMARY KEY (request_id, file_hash)
  );

  CREATE TABLE IF NOT EXISTS compaction (
    request_id              TEXT NOT NULL REFERENCES request(request_id),
    tool_call_round_id      TEXT NOT NULL,
    model                   TEXT NOT NULL,
    num_rounds              INTEGER NOT NULL,
    duration_ms             INTEGER NOT NULL,
    outcome                 TEXT NOT NULL,
    context_length_before   INTEGER NOT NULL,
    PRIMARY KEY (request_id, tool_call_round_id)
  );
  `,

  // v2 — Phase D3: the three signals the waste detectors need that the
  // ledger never had to care about. All are redaction-safe by construction:
  // sizes are lengths (the payload is measured and discarded), and every
  // file identity is a salted hash produced during ingest.
  `
  ALTER TABLE tool_call ADD COLUMN result_chars INTEGER;
  ALTER TABLE tool_call ADD COLUMN target_file_hash TEXT;
  ALTER TABLE tool_call ADD COLUMN target_start_line INTEGER;
  ALTER TABLE tool_call ADD COLUMN target_end_line INTEGER;

  CREATE INDEX IF NOT EXISTS idx_tool_call_name ON tool_call(name);
  CREATE INDEX IF NOT EXISTS idx_tool_call_target ON tool_call(target_file_hash);

  CREATE TABLE IF NOT EXISTS content_reference (
    request_id  TEXT NOT NULL REFERENCES request(request_id),
    file_hash   TEXT NOT NULL,
    PRIMARY KEY (request_id, file_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_content_reference_hash ON content_reference(file_hash);

  -- This migration changes *what ingest extracts*, not just where it is
  -- stored. Every journal already recorded in ingested_file would otherwise
  -- be skipped as "unchanged" on the next run and would never gain the new
  -- columns, leaving a silently half-populated table — exactly the kind of
  -- quiet wrong answer P5 forbids. Clearing the ingest cache forces one
  -- full re-read; the file contents have not changed, only our reading of
  -- them, and re-ingestion is idempotent by design (D1.7).
  DELETE FROM ingested_file;
  `,
];
