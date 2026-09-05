import { describe, it, expect } from 'vitest';
import {
  forecastBudget,
  MONTHLY_ALLOWANCE,
  parseAllowanceValue,
  resolveAllowance,
} from '../src/ledger/budget.js';
import { ConfigError } from '../src/shared/errors.js';
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
  it('matches the published standard figures for every supported plan', () => {
    expect(MONTHLY_ALLOWANCE.business).toBe(1900);
    expect(MONTHLY_ALLOWANCE.enterprise).toBe(3900);
    expect(MONTHLY_ALLOWANCE.pro).toBe(1500);
    expect(MONTHLY_ALLOWANCE['pro-plus']).toBe(7000);
    expect(MONTHLY_ALLOWANCE.max).toBe(20_000);
  });
});

describe('parseAllowanceValue', () => {
  it('reads every accepted spelling of "no monthly limit" as null', () => {
    for (const spelling of ['unlimited', 'UNLIMITED', ' none ', 'no-limit', 'nolimit', 'off']) {
      expect(parseAllowanceValue(spelling, 'flag')).toBeNull();
    }
  });

  it('tolerates separators people copy out of a billing page', () => {
    expect(parseAllowanceValue('3,900', 'config')).toBe(3900);
    expect(parseAllowanceValue('3_900', 'env')).toBe(3900);
    expect(parseAllowanceValue(3900, 'config')).toBe(3900);
  });

  it('throws rather than falling back when the value is present but unintelligible', () => {
    // Silently substituting the plan default here would report a limit the
    // user believes they overrode — the exact silent-wrong-answer failure.
    expect(() => parseAllowanceValue('lots', 'flag')).toThrow(ConfigError);
    expect(() => parseAllowanceValue('-5', 'config')).toThrow(ConfigError);
    expect(() => parseAllowanceValue('', 'env')).toThrow(ConfigError);
  });
});

describe('resolveAllowance', () => {
  // Plan defaults are time-dependent while a promotion is running, so every
  // assertion about one pins the date. Without this the suite would start
  // failing on the day the promotion lapses, for no code change at all.
  const AFTER_PROMOTION = new Date(Date.UTC(2026, 8, 15));
  const DURING_PROMOTION = new Date(Date.UTC(2026, 6, 15));

  it('prefers flag over env over config over the plan default, and names the source', () => {
    expect(
      resolveAllowance({ plan: 'enterprise', flag: '10', env: '20', config: 30 }),
    ).toMatchObject({ credits: 10, source: 'flag' });
    expect(resolveAllowance({ plan: 'enterprise', env: '20', config: 30 })).toMatchObject({
      credits: 20,
      source: 'env',
    });
    expect(resolveAllowance({ plan: 'enterprise', config: 30 })).toMatchObject({
      credits: 30,
      source: 'config',
    });
    expect(resolveAllowance({ plan: 'business', now: AFTER_PROMOTION })).toMatchObject({
      credits: 1900,
      source: 'plan-default',
    });
  });

  it('applies the promotional allowance while it is running, and says so', () => {
    const promotional = resolveAllowance({ plan: 'enterprise', now: DURING_PROMOTION });
    expect(promotional.credits).toBe(7000);
    expect(promotional.promotionalUntil).toBe('2026-09-01');
  });

  it('lets the promotion lapse on its own rather than outliving it', () => {
    const standard = resolveAllowance({ plan: 'enterprise', now: AFTER_PROMOTION });
    expect(standard.credits).toBe(3900);
    expect(standard.promotionalUntil).toBeUndefined();
  });

  it('ignores an empty environment variable rather than treating it as a declaration', () => {
    expect(resolveAllowance({ plan: 'enterprise', env: '  ', now: AFTER_PROMOTION })).toMatchObject(
      {
        credits: 3900,
        source: 'plan-default',
      },
    );
  });

  it('carries "unlimited" through as null, not as zero', () => {
    const allowance = resolveAllowance({ plan: 'enterprise', config: 'unlimited' });
    expect(allowance.credits).toBeNull();
    expect(allowance.source).toBe('config');
  });
});

describe('forecastBudget with no enforced limit', () => {
  it('reports spend and a forecast but never an overage or an exhaustion date', () => {
    const ledger = ledgerWithDays([{ day: '2026-08-01', credits: 5000 }]);
    const now = new Date('2026-08-01T12:00:00Z');
    const forecast = forecastBudget(
      ledger,
      resolveAllowance({ plan: 'enterprise', flag: 'unlimited' }),
      now,
    );

    expect(forecast.unlimited).toBe(true);
    expect(forecast.monthlyAllowance).toBeNull();
    expect(forecast.allowanceSource).toBe('flag');
    // Spend and projection are still real measurements of real usage.
    expect(forecast.monthToDateCredits).toBe(5000);
    expect(forecast.projectedMonthEndCredits).toBeGreaterThan(5000);
    // ...but there is nothing to be over, and nothing to exhaust.
    expect(forecast.projectedOverage).toBe(0);
    expect(forecast.onTrackToExceedAllowance).toBe(false);
    expect(forecast.hardBlockDate).toBeUndefined();
  });

  it('still flags an overage when a limit is explicitly declared', () => {
    const ledger = ledgerWithDays([{ day: '2026-08-01', credits: 5000 }]);
    const now = new Date('2026-08-01T12:00:00Z');
    const forecast = forecastBudget(
      ledger,
      resolveAllowance({ plan: 'enterprise', flag: '1000' }),
      now,
    );

    expect(forecast.unlimited).toBe(false);
    expect(forecast.monthlyAllowance).toBe(1000);
    expect(forecast.onTrackToExceedAllowance).toBe(true);
    expect(forecast.projectedOverage).toBeGreaterThan(0);
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

    // June 2026 is inside the promotional window, so Business is 3,000.
    const forecast = forecastBudget(ledger, 'business', now);
    expect(forecast.monthlyAllowance).toBe(3000);
    expect(forecast.promotionalUntil).toBe('2026-09-01');
    // daily rate 500 * 30 days = 15000, way over the allowance
    expect(forecast.onTrackToExceedAllowance).toBe(true);
    expect(forecast.projectedOverage).toBeCloseTo(15000 - 3000, 6);
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
