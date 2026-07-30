import { describe, it, expect } from 'vitest';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { buildLedger } from '../src/ledger/ledger.js';
import type { TurnRecord } from '../src/model/turn-record.js';

function record(overrides: Partial<TurnRecord> & Pick<TurnRecord, 'requestId' | 'ts'>): TurnRecord {
  return {
    sessionId: 'session-a',
    model: 'model-a',
    promptTokens: 1000,
    outputTokens: 100,
    costCentres: [],
    rounds: [],
    edits: [],
    compactions: [],
    turnIndex: 0,
    source: { file: 'f', offset: 0 },
    ...overrides,
  };
}

describe('ledger money conservation', () => {
  it('total credits equals measured + modelled credits, exactly', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({ requestId: 'r1', ts: 1, credits: 10 }), // measured
      record({ requestId: 'r2', ts: 2, model: 'model-b' }), // unmeasured -> modelled estimate
    ]);

    const ledger = buildLedger(db);
    expect(ledger.totalCredits).toBeCloseTo(ledger.measuredCredits + ledger.modelledCredits, 9);
  });

  it('the sum of per-model credits equals total credits', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({ requestId: 'r1', ts: 1, model: 'a', credits: 10 }),
      record({ requestId: 'r2', ts: 2, model: 'b', credits: 20 }),
      record({ requestId: 'r3', ts: 3, model: 'a', credits: 5 }),
    ]);

    const ledger = buildLedger(db);
    const sumByModel = ledger.byModel.reduce((sum, m) => sum + m.credits, 0);
    expect(sumByModel).toBeCloseTo(ledger.totalCredits, 9);
  });

  it('the sum of per-day credits equals total credits', () => {
    const db = openDatabase(':memory:');
    const day1 = Date.UTC(2026, 0, 1, 10, 0, 0);
    const day2 = Date.UTC(2026, 0, 2, 10, 0, 0);
    saveTurnRecords(db, [
      record({ requestId: 'r1', ts: day1, credits: 10 }),
      record({ requestId: 'r2', ts: day2, credits: 20 }),
    ]);

    const ledger = buildLedger(db);
    const sumByDay = ledger.byDay.reduce((sum, d) => sum + d.credits, 0);
    expect(sumByDay).toBeCloseTo(ledger.totalCredits, 9);
    expect(ledger.byDay.map((d) => d.day)).toEqual(['2026-01-01', '2026-01-02']);
  });

  it('the sum of per-session credits equals total credits', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({ requestId: 'r1', ts: 1, sessionId: 's1', credits: 10 }),
      record({ requestId: 'r2', ts: 2, sessionId: 's2', credits: 20 }),
      record({ requestId: 'r3', ts: 3, sessionId: 's1', credits: 5 }),
    ]);

    const ledger = buildLedger(db);
    const sumBySession = ledger.bySession.reduce((sum, s) => sum + s.credits, 0);
    expect(sumBySession).toBeCloseTo(ledger.totalCredits, 9);

    const s1 = ledger.bySession.find((s) => s.sessionId === 's1');
    expect(s1?.requestCount).toBe(2);
    expect(s1?.credits).toBeCloseTo(15, 9);
  });

  it("a request's cost-centre tokens sum to its promptTokens, and the ledger's byCostCentre total tokens equals the sum across all requests", () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({
        requestId: 'r1',
        ts: 1,
        promptTokens: 1000,
        credits: 10,
        costCentres: [
          { category: 'System', label: 'System Instructions', percentageOfPrompt: 20, tokens: 200 },
          { category: 'User Context', label: 'Messages', percentageOfPrompt: 80, tokens: 800 },
        ],
      }),
      record({
        requestId: 'r2',
        ts: 2,
        promptTokens: 2000,
        credits: 20,
        costCentres: [
          { category: 'System', label: 'System Instructions', percentageOfPrompt: 10, tokens: 200 },
          { category: 'User Context', label: 'Messages', percentageOfPrompt: 90, tokens: 1800 },
        ],
      }),
    ]);

    const ledger = buildLedger(db);
    const systemInstructions = ledger.byCostCentre.find((c) => c.label === 'System Instructions');
    const messages = ledger.byCostCentre.find((c) => c.label === 'Messages');

    expect(systemInstructions?.tokens).toBe(400); // 200 + 200
    expect(messages?.tokens).toBe(2600); // 800 + 1800

    const totalCostCentreTokens = ledger.byCostCentre.reduce((sum, c) => sum + c.tokens, 0);
    expect(totalCostCentreTokens).toBe(3000); // matches the sum of both requests' promptTokens
  });

  it('an empty ledger has zero totals and empty breakdowns, never a fabricated non-zero', () => {
    const db = openDatabase(':memory:');
    const ledger = buildLedger(db);

    expect(ledger.totalCredits).toBe(0);
    expect(ledger.requestCount).toBe(0);
    expect(ledger.byDay).toEqual([]);
    expect(ledger.byModel).toEqual([]);
    expect(ledger.bySession).toEqual([]);
    expect(ledger.byCostCentre).toEqual([]);
  });
});
