import { describe, it, expect } from 'vitest';
import {
  estimateStaggeredDid,
  estimateTwoWayFixedEffects,
  type CohortAssignment,
  type PanelRow,
} from '../src/outcomes/did.js';

/**
 * A panel with a **planted** effect, so the estimator can be checked against
 * a known truth rather than against itself.
 *
 * Units adopt at staggered periods. Post-treatment observations get `effect`
 * added. `heterogeneous` scales the effect by cohort, which is the exact
 * condition under which two-way fixed effects goes wrong.
 */
function panelWithPlantedEffect(options: {
  periods: number;
  cohorts: readonly (number | undefined)[];
  unitsPerCohort: number;
  effect: number;
  heterogeneous?: boolean;
  drift?: (unit: number, period: number) => number;
}): { panel: PanelRow[]; cohorts: CohortAssignment[] } {
  const panel: PanelRow[] = [];
  const cohorts: CohortAssignment[] = [];
  let unitIndex = 0;

  options.cohorts.forEach((treatedAt, cohortIndex) => {
    for (let i = 0; i < options.unitsPerCohort; i += 1) {
      const unit = `u${String(unitIndex++)}`;
      cohorts.push(treatedAt === undefined ? { unit } : { unit, treatedAt });

      for (let period = 0; period < options.periods; period += 1) {
        const treated = treatedAt !== undefined && period >= treatedAt;
        const scale = options.heterogeneous === true ? cohortIndex + 1 : 1;
        panel.push({
          unit,
          period,
          outcome:
            // A common time trend both groups share — the thing DiD differences out.
            10 +
            period * 0.5 +
            (treated ? options.effect * scale : 0) +
            (options.drift?.(unitIndex, period) ?? 0),
        });
      }
    }
  });

  return { panel, cohorts };
}

describe('staggered difference-in-differences', () => {
  it('recovers a planted effect', () => {
    const { panel, cohorts } = panelWithPlantedEffect({
      periods: 12,
      cohorts: [4, 6, 8, undefined],
      unitsPerCohort: 5,
      effect: 2,
    });

    const result = estimateStaggeredDid(panel, cohorts, { bootstrapSamples: 200 });

    expect(result.preTrend.passes).toBe(true);
    expect(result.att?.point).toBeCloseTo(2, 6);
    expect(result.att?.low).toBeLessThanOrEqual(2);
    expect(result.att?.high).toBeGreaterThanOrEqual(2);
  });

  /**
   * The counterpart of D4's null-policy test. An estimator that always finds
   * an effect is worse than no estimator, and the failure is invisible
   * without a case where the truth is zero.
   */
  it('reports an interval containing zero when nothing was planted', () => {
    const { panel, cohorts } = panelWithPlantedEffect({
      periods: 12,
      cohorts: [4, 6, 8, undefined],
      unitsPerCohort: 5,
      effect: 0,
    });

    const result = estimateStaggeredDid(panel, cohorts, { bootstrapSamples: 200 });

    expect(result.att?.point).toBeCloseTo(0, 9);
    expect(result.att?.low).toBeLessThanOrEqual(0);
    expect(result.att?.high).toBeGreaterThanOrEqual(0);
  });

  /**
   * The central assumption cannot be proven, but it can be falsified. If the
   * groups were already diverging, the estimate afterwards contains that
   * divergence — and the design must say so *before* it shows a number.
   */
  it('fails the pre-trend check when groups were already diverging', () => {
    const { panel, cohorts } = panelWithPlantedEffect({
      periods: 12,
      cohorts: [6, undefined],
      unitsPerCohort: 6,
      effect: 0,
      // Treated units drift upward from the very beginning.
      drift: (unit, period) => (unit <= 6 ? period * 3 : 0),
    });

    const result = estimateStaggeredDid(panel, cohorts, { bootstrapSamples: 200 });

    expect(result.preTrend.passes).toBe(false);
    expect(result.preTrend.periodsTested).toBeGreaterThan(0);
    expect(result.preTrend.detail).toMatch(/diverging before treatment/);
  });

  it('says so when parallel trends could not be tested at all', () => {
    // Everyone treated from period 1: there is no pre-period to look at.
    const { panel, cohorts } = panelWithPlantedEffect({
      periods: 6,
      cohorts: [1, undefined],
      unitsPerCohort: 5,
      effect: 1,
    });

    const result = estimateStaggeredDid(panel, cohorts, { bootstrapSamples: 100 });

    expect(result.preTrend.passes).toBe(false);
    expect(result.preTrend.detail).toMatch(/untested assumption is not a satisfied one/);
  });

  /**
   * Justifies the choice of estimator with a failing alternative rather than
   * a comment. Under staggered adoption with effects that differ by cohort,
   * TWFE uses already-treated units as controls for later-treated ones.
   *
   * The expected value here is worth spelling out, because it is not the
   * naive average of the planted effects and that is the point. Cohorts
   * adopt at 4, 8 and 12 with effects 2, 4 and 6, and nobody is
   * never-treated. So:
   *
   * - cohort 4 is estimable for t = 4..11 (8 periods) against cohorts 8 and 12
   * - cohort 8 is estimable for t = 8..11 (4 periods) against cohort 12
   * - cohort 12 has **no** valid control and contributes nothing
   *
   * Weighted by estimable cells, the answer is (8·2 + 4·4) / 12 = 8/3.
   * An estimator that returned the naive mean of 2, 4 and 6 would be
   * claiming to have measured a cohort it had nothing to compare against.
   */
  it('avoids the bias two-way fixed effects suffers under heterogeneous staggered adoption', () => {
    const { panel, cohorts } = panelWithPlantedEffect({
      periods: 16,
      cohorts: [4, 8, 12],
      unitsPerCohort: 6,
      effect: 2,
      heterogeneous: true,
    });

    const correct = estimateStaggeredDid(panel, cohorts, { bootstrapSamples: 100 });
    const twfe = estimateTwoWayFixedEffects(panel, cohorts);

    expect(correct.att?.point).toBeCloseTo(8 / 3, 9);
    expect(twfe).toBeDefined();
    // The two disagree by a wide margin — the whole reason not to use TWFE.
    expect(Math.abs((twfe ?? 0) - (correct.att?.point ?? 0))).toBeGreaterThan(0.5);
  });

  it('is byte-identical across runs, because the bootstrap is seeded', () => {
    const { panel, cohorts } = panelWithPlantedEffect({
      periods: 10,
      cohorts: [4, 6, undefined],
      unitsPerCohort: 4,
      effect: 1.5,
    });

    const first = JSON.stringify(estimateStaggeredDid(panel, cohorts, { bootstrapSamples: 150 }));
    const second = JSON.stringify(estimateStaggeredDid(panel, cohorts, { bootstrapSamples: 150 }));

    expect(first).toBe(second);
  });

  it('uses not-yet-treated units as controls when nobody is never-treated', () => {
    const { panel, cohorts } = panelWithPlantedEffect({
      periods: 14,
      cohorts: [4, 7, 10],
      unitsPerCohort: 5,
      effect: 1,
    });

    const notYet = estimateStaggeredDid(panel, cohorts, {
      comparisonGroup: 'not-yet-treated',
      bootstrapSamples: 100,
    });
    const neverOnly = estimateStaggeredDid(panel, cohorts, {
      comparisonGroup: 'never-treated',
      bootstrapSamples: 100,
    });

    // With a fully rolled-out history there is no never-treated group at all,
    // so that comparison has nothing to estimate against.
    expect(notYet.att?.point).toBeCloseTo(1, 6);
    expect(neverOnly.att).toBeUndefined();
    expect(neverOnly.droppedCells).toBeGreaterThan(0);
  });

  it('reports nothing rather than guessing when a cohort is too small', () => {
    const { panel, cohorts } = panelWithPlantedEffect({
      periods: 8,
      cohorts: [3, undefined],
      unitsPerCohort: 2,
      effect: 5,
    });

    const result = estimateStaggeredDid(panel, cohorts, {
      minUnitsPerSide: 5,
      bootstrapSamples: 50,
    });

    expect(result.att).toBeUndefined();
  });
});
