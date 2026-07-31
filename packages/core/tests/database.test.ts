import { describe, it, expect } from 'vitest';
import {
  openDatabase,
  saveTurnRecords,
  getAllRequests,
  getAllCostCentres,
  getIngestedFileState,
  recordIngestedFile,
} from '../src/store/database.js';
import type { TurnRecord } from '../src/model/turn-record.js';

function makeRecord(requestId: string, overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    sessionId: 'session-a',
    requestId,
    ts: 1,
    model: 'model-a',
    promptTokens: 1000,
    outputTokens: 100,
    costCentres: [],
    rounds: [],
    edits: [],
    compactions: [],
    contentReferences: [],
    turnIndex: 0,
    source: { file: 'f', offset: 0 },
    ...overrides,
  };
}

describe('openDatabase', () => {
  it('applies the schema (tables exist) on a fresh in-memory database', () => {
    const db = openDatabase(':memory:');
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    for (const expected of [
      'session',
      'request',
      'cost_centre',
      'round',
      'tool_call',
      'edit',
      'compaction',
      'ingested_file',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('is idempotent — opening twice does not fail or duplicate migrations', () => {
    const db1 = openDatabase(':memory:');
    expect(() => openDatabase(':memory:')).not.toThrow();
    db1.close();
  });
});

describe('saveTurnRecords', () => {
  it('persists a full record graph: request, cost centres, rounds, tool calls, edits, compactions', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      makeRecord('r1', {
        costCentres: [
          { category: 'System', label: 'Messages', percentageOfPrompt: 100, tokens: 1000 },
        ],
        rounds: [
          {
            id: 'round-1',
            ts: 2,
            modelId: 'model-a',
            toolCalls: [{ id: 'call-1', name: 'read_file' }],
            retries: 0,
          },
        ],
        edits: [{ fileHash: 'abc123', editCount: 1, done: true }],
        compactions: [
          {
            toolCallRoundId: 'round-1',
            model: 'model-a',
            numRounds: 5,
            durationMs: 1000,
            outcome: 'full/success',
            contextLengthBefore: 100,
          },
        ],
      }),
    ]);

    const requests = getAllRequests(db);
    expect(requests).toHaveLength(1);

    const costCentres = getAllCostCentres(db);
    expect(costCentres).toHaveLength(1);
    expect(costCentres[0]?.tokens).toBe(1000);

    const roundRow = db.prepare('SELECT * FROM round WHERE request_id = ?').get('r1');
    expect(roundRow).toBeDefined();

    const toolCallRow = db.prepare('SELECT * FROM tool_call WHERE request_id = ?').get('r1');
    expect(toolCallRow).toBeDefined();

    const editRow = db.prepare('SELECT * FROM edit WHERE request_id = ?').get('r1');
    expect(editRow).toBeDefined();

    const compactionRow = db.prepare('SELECT * FROM compaction WHERE request_id = ?').get('r1');
    expect(compactionRow).toBeDefined();
  });

  it('is idempotent — saving the same request twice does not duplicate child rows', () => {
    const db = openDatabase(':memory:');
    const record = makeRecord('r1', {
      costCentres: [
        { category: 'System', label: 'Messages', percentageOfPrompt: 100, tokens: 1000 },
      ],
    });

    saveTurnRecords(db, [record]);
    saveTurnRecords(db, [record]);

    expect(getAllRequests(db)).toHaveLength(1);
    expect(getAllCostCentres(db)).toHaveLength(1);
  });

  it('re-saving a request with fewer cost centres removes the stale ones (replace, not merge)', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      makeRecord('r1', {
        costCentres: [
          { category: 'System', label: 'Messages', percentageOfPrompt: 50, tokens: 500 },
          { category: 'System', label: 'Files', percentageOfPrompt: 50, tokens: 500 },
        ],
      }),
    ]);
    saveTurnRecords(db, [
      makeRecord('r1', {
        costCentres: [
          { category: 'System', label: 'Messages', percentageOfPrompt: 100, tokens: 1000 },
        ],
      }),
    ]);

    const costCentres = getAllCostCentres(db);
    expect(costCentres).toHaveLength(1);
    expect(costCentres[0]?.label).toBe('Messages');
  });

  it('merges first/last seen timestamps for a session across multiple requests', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      makeRecord('r1', { sessionId: 's1', ts: 100 }),
      makeRecord('r2', { sessionId: 's1', ts: 50 }),
      makeRecord('r3', { sessionId: 's1', ts: 200 }),
    ]);

    const session = db.prepare('SELECT * FROM session WHERE session_id = ?').get('s1') as {
      first_seen_at: number;
      last_seen_at: number;
    };
    expect(session.first_seen_at).toBe(50);
    expect(session.last_seen_at).toBe(200);
  });
});

describe('ingested_file tracking', () => {
  it('returns undefined before any state is recorded, then round-trips it', () => {
    const db = openDatabase(':memory:');
    expect(getIngestedFileState(db, '/some/file.jsonl')).toBeUndefined();

    recordIngestedFile(
      db,
      '/some/file.jsonl',
      { mtimeMs: 123, sizeBytes: 456, contentHash: 'hash1' },
      999,
    );
    const state = getIngestedFileState(db, '/some/file.jsonl');

    expect(state).toEqual({ mtimeMs: 123, sizeBytes: 456, contentHash: 'hash1' });
  });

  it('overwrites the previous state on a subsequent record for the same file', () => {
    const db = openDatabase(':memory:');
    recordIngestedFile(db, '/f.jsonl', { mtimeMs: 1, sizeBytes: 1, contentHash: 'a' });
    recordIngestedFile(db, '/f.jsonl', { mtimeMs: 2, sizeBytes: 2, contentHash: 'b' });

    expect(getIngestedFileState(db, '/f.jsonl')).toEqual({
      mtimeMs: 2,
      sizeBytes: 2,
      contentHash: 'b',
    });
  });
});
