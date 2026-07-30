import { describe, it, expect } from 'vitest';
import { forecastBudget, MONTHLY_ALLOWANCE } from '../src/ledger/budget.js';
import type { LedgerSummary } from '../src/ledger/ledger.js';

function ledgerWithDays(days: readonly { day: string; credits: number }[]): LedgerSummary {
  return {
    totalCredits: days.reduce((sum, d) => sum + d.credits, 0),
    measuredCredits: 0,
    modelledCredits: 0,
    requestCount: 0,
    byDay: days.map((d) => ({
      day: d.day,
      credits: d.credits,
      measuredCredits: 0,
      modelledCredits: d.credits,
      promptTokens: 0,
      outputTokens: 0,
      requestCount: 1,
    })),
    byModel: [],
    bySession: [],
    byCostCentre: [],
    rateCard: [],
  };
}

describe('MONTHLY_ALLOWANCE', () => {
  it('matches PLAN.md F12', () => {
    expect(MONTHLY_ALLOWANCE.business).toBe(1900);
    expect(MONTHLY_ALLOWANCE.enterprise).toBe(3900);
  });
});

describe('forecastBudget', () => {
  it('linearly extrapolates the month-to-date daily rate to a full 30-day month', () => {
    // 2026-06 has 30 days. "Now" is day 10, with 100 credits/day so far.
    const ledger = ledgerWithDays([
      { day: '2026-06-01', credits: 100 },
      { day: '2026-06-02', credits: 100 },
    ]);
    const now = new Date(Date.UTC(2026, 5, 2, 12, 0, 0)); // June 2, day 2 of the month

    const forecast = forecastBudget(ledger, 'enterprise', now);

    expect(forecast.daysInMonth).toBe(30);
    expect(forecast.daysElapsedInMonth).toBe(2);
    expect(forecast.monthToDateCredits).toBe(200);
    // daily rate = 200/2 = 100; projected = 100 * 30 = 3000
    expect(forecast.projectedMonthEndCredits).toBeCloseTo(3000, 6);
  });

  it('flags onTrackToExceedAllowance and computes a positive overage when the forecast exceeds the plan', () => {
    const ledger = ledgerWithDays([{ day: '2026-06-01', credits: 500 }]);
    const now = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));

    const forecast = forecastBudget(ledger, 'business', now); // allowance 1900
    // daily rate 500 * 30 days = 15000, way over 1900
    expect(forecast.onTrackToExceedAllowance).toBe(true);
    expect(forecast.projectedOverage).toBeCloseTo(15000 - 1900, 6);
  });

  it('reports zero overage and false flag when comfortably under the allowance', () => {
    const ledger = ledgerWithDays([{ day: '2026-06-01', credits: 1 }]);
    const now = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));

    const forecast = forecastBudget(ledger, 'enterprise', now);
    expect(forecast.onTrackToExceedAllowance).toBe(false);
    expect(forecast.projectedOverage).toBe(0);
  });

  it('only counts days within the forecasted month, ignoring other months in the ledger', () => {
    const ledger = ledgerWithDays([
      { day: '2026-05-31', credits: 9999 }, // previous month — must be excluded
      { day: '2026-06-01', credits: 100 },
    ]);
    const now = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));

    const forecast = forecastBudget(ledger, 'enterprise', now);
    expect(forecast.monthToDateCredits).toBe(100);
  });

  it('does not divide by zero when called for a ledger with no days recorded yet', () => {
    const ledger = ledgerWithDays([]);
    const now = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));

    const forecast = forecastBudget(ledger, 'enterprise', now);
    expect(forecast.monthToDateCredits).toBe(0);
    expect(forecast.projectedMonthEndCredits).toBe(0);
    expect(Number.isFinite(forecast.projectedMonthEndCredits)).toBe(true);
  });
});
