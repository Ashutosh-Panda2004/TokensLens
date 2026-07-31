import { describe, it, expect } from 'vitest';
import { assessCeiling, splitAtCeiling } from '../src/simulate/ceiling.js';
import { MONTHLY_ALLOWANCE } from '../src/ledger/budget.js';
import { buildSimulationCorpus } from './fixtures/simulate-corpus.js';
import { buildSimulation } from '../src/simulate/report.js';
import { parsePolicy } from '../src/simulate/policy.js';

const NOW = new Date('2026-07-15T12:00:00Z');

/**
 * The constraint from PLAN.md §20.5, expressed as tests.
 *
 * Copilot bills only what exceeds the included allowance, so a saving that
 * pushes spend below that line stops being money and becomes unused
 * allowance. A model that reports a 60% reduction as though it were worth
 * twice a 30% one is describing arithmetic rather than an invoice, and the
 * error is always in the direction of overstating the business case.
 */
describe('contract ceiling', () => {
  it('identifies the reduction at which savings stop being cash', () => {
    // 5,000 enterprise seats at the measured fleet run-rate from PLAN.md §20.5.
    const ceiling = assessCeiling(9_922, { plan: 'enterprise', seats: 5_000 });

    expect(ceiling.includedCredits).toBe(MONTHLY_ALLOWANCE.enterprise * 5_000);
    expect(ceiling.projectedMonthlyCredits).toBe(9_922 * 5_000);
    expect(ceiling.overageCredits).toBe(9_922 * 5_000 - 3_900 * 5_000);
    // PLAN.md's documented 60.7% figure, reproduced from the same inputs.
    expect(ceiling.reductionThatEliminatesOverage).toBeCloseTo(0.607, 3);
  });

  it('reports savings below the ceiling as cash, one for one', () => {
    const ceiling = assessCeiling(9_922, { plan: 'enterprise', seats: 5_000 });
    const split = splitAtCeiling(ceiling, 0.3);

    expect(split.unusedAllowanceCredits).toBe(0);
    expect(split.exceedsCeiling).toBe(false);
    expect(split.cashCredits).toBeCloseTo(ceiling.projectedMonthlyCredits * 0.3, 6);
  });

  it('refuses to report savings beyond the ceiling as cash', () => {
    const ceiling = assessCeiling(9_922, { plan: 'enterprise', seats: 5_000 });
    const split = splitAtCeiling(ceiling, 0.8);

    expect(split.exceedsCeiling).toBe(true);
    // Everything above 60.7% is allowance that goes unused, not an invoice
    // that shrinks. The cash figure is capped at the whole overage and no
    // further, however large the reduction.
    expect(split.cashCredits).toBe(ceiling.overageCredits);
    expect(split.unusedAllowanceCredits).toBeCloseTo(
      ceiling.projectedMonthlyCredits * 0.8 - ceiling.overageCredits,
      6,
    );
    expect(split.shareOfMaxCashSaving).toBe(1);
  });

  it('reports the expected case as a share of the maximum achievable', () => {
    const ceiling = assessCeiling(9_922, { plan: 'enterprise', seats: 5_000 });

    // PLAN.md: the 46.2% case captures 76% of the maximum achievable cash
    // saving. Reproduced here rather than restated.
    expect(splitAtCeiling(ceiling, 0.462).shareOfMaxCashSaving).toBeCloseTo(0.761, 2);
  });

  it('reports no cash at all when spend is already inside the allowance', () => {
    const ceiling = assessCeiling(500, { plan: 'enterprise', seats: 1 });

    expect(ceiling.overageCredits).toBe(0);
    expect(ceiling.reductionThatEliminatesOverage).toBeUndefined();

    const split = splitAtCeiling(ceiling, 0.5);
    expect(split.cashCredits).toBe(0);
    expect(split.unusedAllowanceCredits).toBeCloseTo(250, 6);
    expect(split.shareOfMaxCashSaving).toBe(0);
  });

  it('uses the lower Business allowance when that is the plan', () => {
    const business = assessCeiling(3_000, { plan: 'business', seats: 10 });
    const enterprise = assessCeiling(3_000, { plan: 'enterprise', seats: 10 });

    expect(business.overageCredits).toBeGreaterThan(enterprise.overageCredits);
    expect(enterprise.overageCredits).toBe(0);
  });

  it('never extrapolates below the one seat that was actually measured', () => {
    expect(assessCeiling(1_000, { plan: 'enterprise', seats: 0 }).seats).toBe(1);
    expect(assessCeiling(1_000, { plan: 'enterprise', seats: -5 }).seats).toBe(1);
  });

  it('is wired into the simulation report at both ends of the band', () => {
    const report = buildSimulation(
      buildSimulationCorpus(),
      parsePolicy('version: 1\nsession:\n  max_rounds: 10\n').policy,
      { now: NOW, plan: 'enterprise', seats: 5_000 },
    );

    expect(report.ceiling.seats).toBe(5_000);
    expect(report.cash.low.reduction).toBe(report.reduction.low);
    expect(report.cash.high.reduction).toBe(report.reduction.high);
    expect(report.cash.low.cashCredits).toBeLessThanOrEqual(report.cash.high.cashCredits);
  });
});
