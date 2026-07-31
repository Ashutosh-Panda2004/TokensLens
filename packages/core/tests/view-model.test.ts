import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { buildLedger } from '../src/ledger/ledger.js';
import { forecastBudget } from '../src/ledger/budget.js';
import { provenanceView, toBudgetView, toLedgerView } from '../src/dashboard/view-model.js';
import type { CostCentre, CostCentreLabel, TurnRecord } from '../src/model/turn-record.js';

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
    contentReferences: [],
    turnIndex: 0,
    source: { file: 'f', offset: 0 },
    ...overrides,
  };
}

function centre(
  label: CostCentreLabel,
  percentageOfPrompt: number,
  promptTokens = 1000,
): CostCentre {
  return {
    category: label === 'Messages' || label === 'Files' ? 'User Context' : 'System',
    label,
    percentageOfPrompt,
    tokens: Math.round((percentageOfPrompt / 100) * promptTokens),
  };
}

describe('provenanceView', () => {
  it('is "measured" only when nothing was modelled', () => {
    const view = provenanceView(10, 10, 0);
    expect(view.kind).toBe('measured');
    expect(view.measuredPercent).toBe(100);
  });

  it('is "modelled" only when nothing was measured', () => {
    const view = provenanceView(10, 0, 10);
    expect(view.kind).toBe('modelled');
    expect(view.measuredPercent).toBe(0);
  });

  it('is "blended" when both parts are non-zero, and reports the rounded measured share', () => {
    const view = provenanceView(10, 3, 7);
    expect(view.kind).toBe('blended');
    expect(view.measuredPercent).toBe(30);
  });

  it('rounds the measured share rather than truncating it', () => {
    // 2/3 = 66.66% -> 67, not 66.
    expect(provenanceView(3, 2, 1).measuredPercent).toBe(67);
  });

  it('does not divide by zero on an empty ledger', () => {
    const view = provenanceView(0, 0, 0);
    expect(view.measuredPercent).toBe(100);
    expect(Number.isFinite(view.measuredPercent)).toBe(true);
    expect(view.kind).toBe('measured');
  });
});

describe('toLedgerView', () => {
  it("conserves money — every aggregate's measured + modelled equals its value", () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({
        requestId: 'r1',
        ts: 1,
        credits: 10,
        costCentres: [centre('System Instructions', 100)],
      }),
      // No credits field -> estimated from the rate card -> modelled.
      record({
        requestId: 'r2',
        ts: 2,
        model: 'model-b',
        sessionId: 'session-b',
        costCentres: [centre('Tool Definitions', 100)],
      }),
    ]);

    const view = toLedgerView(buildLedger(db));

    const conserves = (v: { value: number; measured: number; modelled: number }): void => {
      expect(v.measured + v.modelled).toBeCloseTo(v.value, 9);
    };

    conserves(view.totalCredits);
    for (const day of view.byDay) conserves(day.credits);
    for (const model of view.byModel) conserves(model.credits);
    for (const session of view.bySession) conserves(session.credits);
    for (const centre of view.byCostCentre) conserves(centre.credits);
  });

  it('marks a fully measured model measured, and an unmeasured one modelled', () => {
    // A ledger with *no* measured request anywhere has a blended rate of 0, so
    // everything estimates to 0 credits — the meaningful case is a mixed
    // ledger, where the blended rate is real and one model rides on it.
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({ requestId: 'r1', ts: 1, model: 'priced', credits: 10 }),
      record({ requestId: 'r2', ts: 2, model: 'unpriced' }),
    ]);

    const view = toLedgerView(buildLedger(db));
    const priced = view.byModel.find((m) => m.model === 'priced');
    const unpriced = view.byModel.find((m) => m.model === 'unpriced');

    expect(priced?.credits.kind).toBe('measured');
    expect(unpriced?.credits.kind).toBe('modelled');
    expect(unpriced?.credits.value).toBeGreaterThan(0);
    expect(view.totalCredits.kind).toBe('blended');
  });

  it("reports each cost centre's token share, summing to ~100%", () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({
        requestId: 'r1',
        ts: 1,
        credits: 10,
        promptTokens: 1000,
        costCentres: [centre('System Instructions', 25), centre('Tool Definitions', 75)],
      }),
    ]);

    const view = toLedgerView(buildLedger(db));
    const shares = new Map(view.byCostCentre.map((c) => [c.label, c.tokenShare]));
    expect(shares.get('System Instructions')).toBe(25);
    expect(shares.get('Tool Definitions')).toBe(75);
  });

  it("surfaces whether each model's rate was measured or fell back to the blended card", () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({ requestId: 'r1', ts: 1, model: 'priced', credits: 10 }),
      record({ requestId: 'r2', ts: 2, model: 'unpriced' }),
    ]);

    const view = toLedgerView(buildLedger(db));
    const priced = view.byModel.find((m) => m.model === 'priced');
    const unpriced = view.byModel.find((m) => m.model === 'unpriced');

    expect(priced?.rate.provenance.kind).toBe('measured');
    expect(priced?.rateSampleSize).toBe(1);
    expect(unpriced?.rate.provenance.kind).toBe('modelled');
    expect(unpriced?.rateSampleSize).toBe(0);
    // The fallback must state what it assumed, not just that it guessed.
    if (unpriced?.rate.provenance.kind === 'modelled') {
      expect(unpriced.rate.provenance.assumptions.length).toBeGreaterThan(0);
    }
  });

  it('never emits a bare number for credits — every credit figure is a ProvenanceView', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [record({ requestId: 'r1', ts: 1, credits: 10 })]);
    const view = toLedgerView(buildLedger(db));
    expect(typeof view.totalCredits).toBe('object');
    expect(view.totalCredits).toHaveProperty('kind');
  });
});

describe('toBudgetView', () => {
  const now = new Date(Date.UTC(2026, 5, 15, 12, 0, 0)); // 15 June 2026

  function ledgerSpanningTwoMonths(): Database.Database {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      // Previous month — must NOT be counted in the month-to-date split.
      record({ requestId: 'old-measured', ts: Date.UTC(2026, 4, 20), credits: 500 }),
      record({ requestId: 'old-modelled', ts: Date.UTC(2026, 4, 21), model: 'model-x' }),
      // Current month.
      record({ requestId: 'new-measured', ts: Date.UTC(2026, 5, 2), credits: 40 }),
      record({ requestId: 'new-modelled', ts: Date.UTC(2026, 5, 3), model: 'model-x' }),
    ]);
    return db;
  }

  it("splits month-to-date credits using only the current month's days", () => {
    // Regression test: an earlier draft summed measured credits across *every*
    // day in the ledger, so a big previous month silently inflated this month's
    // measured share past 100%.
    const summary = buildLedger(ledgerSpanningTwoMonths());
    const view = toBudgetView(forecastBudget(summary, 'enterprise', now), summary, now);

    expect(view.monthToDateCredits.measured + view.monthToDateCredits.modelled).toBeCloseTo(
      view.monthToDateCredits.value,
      9,
    );
    expect(view.monthToDateCredits.measured).toBeCloseTo(40, 9);
    expect(view.monthToDateCredits.measuredPercent).toBeLessThanOrEqual(100);
    expect(view.monthToDateCredits.value).toBeLessThan(summary.totalCredits);
  });

  it('always tags the projection as modelled, however measured its inputs were', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [record({ requestId: 'r1', ts: Date.UTC(2026, 5, 1), credits: 100 })]);
    const summary = buildLedger(db);
    const view = toBudgetView(forecastBudget(summary, 'enterprise', now), summary, now);

    expect(view.monthToDateCredits.kind).toBe('measured');
    expect(view.projectedMonthEndCredits.provenance.kind).toBe('modelled');
    expect(view.projectedOverage.provenance.kind).toBe('modelled');
    expect(view.projectedMonthEndCredits.provenance.assumptions.length).toBeGreaterThan(0);
  });

  it('carries a modelled hard-block date when spend is projected to exhaust the allowance', () => {
    const db = openDatabase(':memory:');
    // 5,000 credits on day 1 of a 1,000-credit Business allowance.
    saveTurnRecords(db, [record({ requestId: 'r1', ts: Date.UTC(2026, 5, 1), credits: 5000 })]);
    const summary = buildLedger(db);
    const view = toBudgetView(forecastBudget(summary, 'business', now), summary, now);

    expect(view.onTrackToExceedAllowance).toBe(true);
    expect(view.hardBlockDate?.provenance.kind).toBe('modelled');
    expect(view.hardBlockDate?.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('omits the hard-block date entirely when there is no spend to extrapolate from', () => {
    const summary = buildLedger(openDatabase(':memory:'));
    const view = toBudgetView(forecastBudget(summary, 'enterprise', now), summary, now);

    expect(view.hardBlockDate).toBeUndefined();
    expect(view.onTrackToExceedAllowance).toBe(false);
    expect(view.monthToDateCredits.value).toBe(0);
  });
});
