import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import type { CostCentre, TurnRecord } from '../src/model/turn-record.js';

const TOKEN = 'provenance-ui-token-aaaaaaaaaaaaaaa';

function record(overrides: Partial<TurnRecord> & Pick<TurnRecord, 'requestId' | 'ts'>): TurnRecord {
  return {
    sessionId: 'session-a',
    model: 'model-a',
    promptTokens: 1000,
    outputTokens: 100,
    costCentres: [
      { category: 'System', label: 'System Instructions', percentageOfPrompt: 30, tokens: 300 },
      { category: 'System', label: 'Tool Definitions', percentageOfPrompt: 70, tokens: 700 },
    ] satisfies CostCentre[],
    rounds: [],
    edits: [],
    compactions: [],
    contentReferences: [],
    turnIndex: 0,
    source: { file: 'f', offset: 0 },
    ...overrides,
  };
}

/** Is this a `ProvenanceView` — the shape the UI renders as a chip? */
function isProvenanceView(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<
    Record<'value' | 'measured' | 'modelled' | 'measuredPercent' | 'kind', unknown>
  >;
  return (
    typeof v.value === 'number' &&
    typeof v.measured === 'number' &&
    typeof v.modelled === 'number' &&
    typeof v.measuredPercent === 'number' &&
    (v.kind === 'measured' || v.kind === 'modelled' || v.kind === 'blended')
  );
}

/** Is this a `Measured<T>`/`Modelled<T>` — the other shape the UI renders as a chip? */
function isTaggedValue(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (!('provenance' in value) || !('value' in value)) return false;

  const provenance: unknown = (value as { provenance: unknown }).provenance;
  if (typeof provenance !== 'object' || provenance === null) return false;

  const kind: unknown = (provenance as { kind?: unknown }).kind;
  return kind === 'measured' || kind === 'modelled';
}

/**
 * Walks an API payload and collects the JSON path of every credit-bearing
 * field that is a *bare number* — i.e. one the UI could render without a
 * provenance chip. The D2 exit criterion is that this list is always empty.
 */
function findUnchippedCreditFields(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => findUnchippedCreditFields(item, `${path}[${String(i)}]`));
  }
  if (typeof node !== 'object' || node === null) return [];
  if (isProvenanceView(node) || isTaggedValue(node)) return []; // already chipped — do not recurse in

  return Object.entries(node).flatMap(([key, value]) => {
    const childPath = `${path}.${key}`;
    // "credits", "monthToDateCredits", "projectedOverage", "rate"… but not
    // counts, sample sizes, token totals, shares or percentages, which are
    // dimensions rather than money and carry no provenance claim.
    const isMoneyField =
      /credit|overage|rate/i.test(key) && !/count|percent|sample|size|share|token/i.test(key);
    if (isMoneyField && typeof value === 'number') return [childPath];
    return findUnchippedCreditFields(value, childPath);
  });
}

describe('provenance UI invariant', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = openDatabase(':memory:');
    saveTurnRecords(db, [
      // A deliberately mixed ledger: measured, unmeasured, several models,
      // several sessions, several days — so every aggregate is exercised.
      record({ requestId: 'r1', ts: Date.UTC(2026, 5, 1), credits: 12 }),
      record({ requestId: 'r2', ts: Date.UTC(2026, 5, 1), model: 'model-b' }),
      record({ requestId: 'r3', ts: Date.UTC(2026, 5, 2), sessionId: 'session-b', credits: 8 }),
      record({
        requestId: 'r4',
        ts: Date.UTC(2026, 5, 3),
        sessionId: 'session-c',
        model: 'model-c',
      }),
    ]);
    app = createDashboardServer({ db, token: TOKEN });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  async function fetchJson(url: string): Promise<unknown> {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it('every credit figure in /api/ledger carries a provenance tag', async () => {
    const body = await fetchJson('/api/ledger');
    expect(findUnchippedCreditFields(body)).toEqual([]);
  });

  it('every credit figure in /api/budget carries a provenance tag', async () => {
    const body = await fetchJson('/api/budget');
    expect(findUnchippedCreditFields(body)).toEqual([]);
  });

  it('the detector itself works — it catches a bare credit number', () => {
    expect(findUnchippedCreditFields({ byDay: [{ credits: 42 }] })).toEqual(['$.byDay[0].credits']);
    expect(findUnchippedCreditFields({ rate: 1.5 })).toEqual(['$.rate']);
    expect(findUnchippedCreditFields({ requestCount: 42, rateSampleSize: 3 })).toEqual([]);
  });

  it('every model rate is a tagged value, so the blended fallback can never pass as measured', async () => {
    const body = (await fetchJson('/api/ledger')) as {
      byModel: { model: string; rate: unknown; rateSampleSize: number }[];
    };

    for (const row of body.byModel) {
      expect(isTaggedValue(row.rate)).toBe(true);
    }

    const measuredRate = body.byModel.find((m) => m.model === 'model-a');
    const fallbackRate = body.byModel.find((m) => m.model === 'model-b');
    expect((measuredRate?.rate as { provenance: { kind: string } }).provenance.kind).toBe(
      'measured',
    );
    expect((fallbackRate?.rate as { provenance: { kind: string } }).provenance.kind).toBe(
      'modelled',
    );
    expect(fallbackRate?.rateSampleSize).toBe(0);
  });

  it('every aggregate in /api/ledger is chipped, not just the headline total', async () => {
    const body = (await fetchJson('/api/ledger')) as {
      totalCredits: unknown;
      byDay: { credits: unknown }[];
      byModel: { credits: unknown }[];
      bySession: { credits: unknown }[];
      byCostCentre: { credits: unknown }[];
    };

    expect(isProvenanceView(body.totalCredits)).toBe(true);
    expect(body.byDay.length).toBeGreaterThan(0);
    expect(body.byModel.length).toBeGreaterThan(0);
    expect(body.bySession.length).toBeGreaterThan(0);
    expect(body.byCostCentre.length).toBeGreaterThan(0);

    for (const row of [...body.byDay, ...body.byModel, ...body.bySession, ...body.byCostCentre]) {
      expect(isProvenanceView(row.credits)).toBe(true);
    }
  });

  it('every projected figure in /api/budget is tagged modelled, never measured', async () => {
    const body = (await fetchJson('/api/budget')) as {
      projectedMonthEndCredits: { provenance: { kind: string; assumptions: string[] } };
      projectedOverage: { provenance: { kind: string } };
    };

    expect(body.projectedMonthEndCredits.provenance.kind).toBe('modelled');
    expect(body.projectedOverage.provenance.kind).toBe('modelled');
    // A modelled figure without a stated assumption is an unfalsifiable claim.
    expect(body.projectedMonthEndCredits.provenance.assumptions.length).toBeGreaterThan(0);
  });
});
