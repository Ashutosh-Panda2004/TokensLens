import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { buildTimeseries } from '../src/ledger/ledger.js';
import type { TurnRecord } from '../src/model/turn-record.js';
import type Database from 'better-sqlite3';

function turn(overrides: Partial<TurnRecord> & { requestId: string }): TurnRecord {
  return {
    sessionId: 'session-1',
    ts: Date.parse('2026-07-01T10:00:00Z'),
    model: 'model-a',
    promptTokens: 1000,
    outputTokens: 100,
    costCentres: [],
    rounds: [],
    edits: [],
    compactions: [],
    turnIndex: 0,
    toolResults: [],
    contentReferences: [],
    source: { file: 'ws-1/chatSessions/a.jsonl', offset: 0 },
    ...overrides,
  } as TurnRecord;
}

describe('buildTimeseries', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tokenlens-series-'));
    db = openDatabase(join(dir, 'ledger.sqlite3'));
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('zero-fills every band across the whole day axis', () => {
    saveTurnRecords(db, [
      // A pricing anchor: with no measured request the blended rate is zero
      // and every derived figure collapses to nothing.
      turn({ requestId: 'r1', credits: 10, ts: Date.parse('2026-07-01T10:00:00Z') }),
      turn({
        requestId: 'r2',
        credits: 20,
        model: 'model-b',
        ts: Date.parse('2026-07-03T10:00:00Z'),
      }),
    ]);

    const series = buildTimeseries(db);

    expect(series.days).toEqual(['2026-07-01', '2026-07-03']);
    // model-b never appeared on the first day, but its band still spans the
    // axis — a renderer stacks by index and cannot reconcile ragged arrays.
    for (const band of series.byModel) {
      expect(band.values).toHaveLength(series.days.length);
    }

    const modelB = series.byModel.find((band) => band.key === 'model-b');
    expect(modelB?.values).toEqual([0, 20]);
    expect(series.totals).toEqual([10, 20]);
    expect(series.requestCounts).toEqual([1, 1]);
  });

  it('orders bands by total so the biggest series stacks first', () => {
    saveTurnRecords(db, [
      turn({ requestId: 'r1', credits: 5, model: 'small' }),
      turn({ requestId: 'r2', credits: 90, model: 'large' }),
    ]);

    expect(buildTimeseries(db).byModel.map((band) => band.key)).toEqual(['large', 'small']);
  });

  it('honours the date range', () => {
    saveTurnRecords(db, [
      turn({ requestId: 'r1', credits: 10, ts: Date.parse('2026-07-01T10:00:00Z') }),
      turn({ requestId: 'r2', credits: 20, ts: Date.parse('2026-07-09T10:00:00Z') }),
    ]);

    const series = buildTimeseries(db, { from: '2026-07-05', to: '2026-07-31' });
    expect(series.days).toEqual(['2026-07-09']);
    expect(series.totals).toEqual([20]);
  });

  it('splits cost centres per day without leaking requests outside the range', () => {
    saveTurnRecords(db, [
      turn({
        requestId: 'r1',
        credits: 100,
        ts: Date.parse('2026-07-01T10:00:00Z'),
        costCentres: [
          {
            category: 'System',
            label: 'Tool Definitions',
            percentageOfPrompt: 25,
            tokens: 250,
          },
        ],
      }),
      turn({
        requestId: 'r2',
        credits: 100,
        ts: Date.parse('2026-07-20T10:00:00Z'),
        costCentres: [
          {
            category: 'System',
            label: 'Tool Definitions',
            percentageOfPrompt: 50,
            tokens: 500,
          },
        ],
      }),
    ]);

    const series = buildTimeseries(db, { from: '2026-07-01', to: '2026-07-10' });
    const band = series.byCostCentre.find((entry) => entry.key === 'Tool Definitions');

    expect(series.days).toEqual(['2026-07-01']);
    // 25% of the in-range request only — the out-of-range one must not appear.
    expect(band?.values).toEqual([25]);
  });
});
