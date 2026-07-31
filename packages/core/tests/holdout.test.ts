import { describe, it, expect } from 'vitest';
import {
  assignHoldout,
  assessBalance,
  parseRoster,
  BALANCE_THRESHOLD_SMD,
  MIN_STRATUM_SIZE,
  type HoldoutUnit,
} from '../src/holdout/assignment.js';
import {
  assessPower,
  assessFeasibility,
  inverseNormalCdf,
  requiredUnitsPerArm,
} from '../src/holdout/power.js';
import { benjaminiHochberg, pValueFromInterval } from '../src/holdout/multiplicity.js';
import {
  buildPreregistration,
  canonicalise,
  checkRegistration,
  hashPreregistration,
} from '../src/holdout/preregistration.js';
import { evaluateGuardrails, GUARDRAIL_METRICS, PRIMARY_METRIC } from '../src/holdout/metrics.js';
import { assessRollback } from '../src/holdout/rollback.js';
import { buildSavingsPnl, CALIBRATION_TOLERANCE, type PnlInput } from '../src/holdout/pnl.js';
import { measureOverrides } from '../src/holdout/override.js';
import type { RequestRow } from '../src/store/database.js';
import type { Policy } from '../src/simulate/policy.js';

/** A fleet with the spend concentration the plan's finding F11 describes. */
function fleet(size: number, teams = 4): HoldoutUnit[] {
  return Array.from({ length: size }, (_, i) => ({
    unit: `u${String(i).padStart(3, '0')}`,
    team: `team-${String(i % teams)}`,
    // Roughly log-normal: a handful of people spend an order of magnitude
    // more than the median, which is what makes stratification necessary.
    preSpend: Math.round(50 * Math.exp((i % 17) / 3)),
  }));
}

describe('D8.1 · stratified randomised assignment', () => {
  it('is reproducible from the seed alone', () => {
    const units = fleet(60);
    const a = assignHoldout(units, { seed: 42 });
    const b = assignHoldout(units, { seed: 42 });
    expect(a.assignments).toEqual(b.assignments);

    const c = assignHoldout(units, { seed: 43 });
    expect(c.assignments).not.toEqual(a.assignments);
  });

  it('holds out the requested share of the fleet', () => {
    const design = assignHoldout(fleet(60), { seed: 7, holdoutFraction: 0.15 });
    expect(design.balance.holdoutUnits).toBe(9);
    expect(design.balance.treatedUnits).toBe(51);
  });

  it('balances pre-spend across the arms', () => {
    // The property the plan calls for: stratification balances spend
    // deciles. Checked across many seeds, because a single lucky draw
    // proves nothing about the procedure.
    for (let seed = 1; seed <= 25; seed += 1) {
      const design = assignHoldout(fleet(80), { seed });
      const smd = design.balance.standardisedMeanDifference ?? 0;
      expect(Math.abs(smd)).toBeLessThan(0.5);
    }
  });

  it('beats unstratified randomisation on spend balance', () => {
    // The comparison that justifies the complexity. Without it there is no
    // evidence the stratification does anything at all.
    const units = fleet(60);
    let stratified = 0;
    let naive = 0;

    for (let seed = 1; seed <= 40; seed += 1) {
      const design = assignHoldout(units, { seed });
      stratified += Math.abs(design.balance.standardisedMeanDifference ?? 0);

      // Same units, one stratum: pure randomisation.
      const flat = assignHoldout(
        units.map((u) => ({ ...u, team: 'all' })),
        { seed, deciles: 1 },
      );
      naive += Math.abs(flat.balance.standardisedMeanDifference ?? 0);
    }

    expect(stratified).toBeLessThan(naive);
  });

  it('never produces strata too small to randomise within', () => {
    // Found live: 47 people across 6 teams produced 35 strata — 1.3 members
    // each. Randomising inside a cell of one does nothing, the balance
    // check duly failed, and the report still said "35 strata
    // (team × spend decile)" as though something rigorous had happened.
    const design = assignHoldout(fleet(47, 6), { seed: 20260801 });

    expect(design.dimensions).toBe('spend');
    expect(design.balance.strata.length).toBeLessThanOrEqual(47 / MIN_STRATUM_SIZE);
    for (const stratum of design.balance.strata) {
      expect(stratum.treated + stratum.holdout).toBeGreaterThanOrEqual(2);
    }
  });

  it('drops the team dimension rather than the spend dimension when it cannot afford both', () => {
    // Concentration is the imbalance that threatens the estimate. Team was
    // only ever for reporting, so it is the one that goes.
    const design = assignHoldout(fleet(40, 8), { seed: 5 });
    expect(design.dimensions).toBe('spend');
    expect(design.dimensionsDetail).toMatch(/team dimension is dropped/);
  });

  it('crosses both dimensions once the fleet can pay for it', () => {
    const design = assignHoldout(fleet(400, 4), { seed: 5 });
    expect(design.dimensions).toBe('team+spend');
    expect(design.balance.strata.length).toBeGreaterThan(10);
  });

  it('says so when the fleet is too small to stratify at all', () => {
    const design = assignHoldout(fleet(6, 3), { seed: 5 });
    expect(design.dimensions).toBe('none');
    expect(design.dimensionsDetail).toMatch(/only protection there is/);
  });

  it('does not systematically exclude any stratum from the holdout', () => {
    // The defect this pins: equal-sized strata all have the same
    // remainder, so the tie-break decides who misses out. Breaking ties by
    // stratum key sorted the spend buckets ascending, and the top decile
    // never received a holdout place on any seed — the arms differed
    // systematically in the one dimension the stratification existed to
    // balance, and each individual draw still looked randomised.
    const units = fleet(60, 1);
    const heldOutFrom = new Map<string, number>();

    for (let seed = 1; seed <= 60; seed += 1) {
      for (const assignment of assignHoldout(units, { seed }).assignments) {
        if (assignment.arm !== 'holdout') continue;
        heldOutFrom.set(assignment.stratum, (heldOutFrom.get(assignment.stratum) ?? 0) + 1);
      }
    }

    const strata = new Set(assignHoldout(units, { seed: 1 }).assignments.map((a) => a.stratum));
    for (const stratum of strata) {
      expect(heldOutFrom.get(stratum) ?? 0).toBeGreaterThan(0);
    }
  });

  it('still holds someone out when every stratum is smaller than 1/fraction', () => {
    // The largest-remainder case. Ten teams of three, 15% holdout: naive
    // per-stratum rounding gives round(0.45) = 0 everywhere, and the
    // "15% holdout" silently becomes nobody.
    const units: HoldoutUnit[] = Array.from({ length: 30 }, (_, i) => ({
      unit: `u${String(i)}`,
      team: `team-${String(i % 10)}`,
      preSpend: 100 + i,
    }));

    const design = assignHoldout(units, { seed: 3, holdoutFraction: 0.15 });
    expect(design.balance.holdoutUnits).toBe(5);
    expect(design.balance.strata.filter((s) => s.holdout > 0).length).toBeGreaterThan(1);
  });

  it('never allocates more holdout places than a stratum has members', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const design = assignHoldout(fleet(23, 7), { seed, holdoutFraction: 0.5 });
      for (const stratum of design.balance.strata) {
        expect(stratum.holdout).toBeLessThanOrEqual(stratum.holdout + stratum.treated);
        expect(stratum.holdout).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('warns when one unit dominates spend, because randomisation cannot fix that', () => {
    const units: HoldoutUnit[] = [
      { unit: 'whale', team: 'a', preSpend: 100_000 },
      ...Array.from({ length: 19 }, (_, i) => ({
        unit: `u${String(i)}`,
        team: 'a',
        preSpend: 100,
      })),
    ];
    const design = assignHoldout(units, { seed: 1 });
    expect(design.balance.concentrationWarning).toMatch(/sample of one/);
  });

  it('says nothing about balance when there is no variance to standardise by', () => {
    const flat = assessBalance(
      Array.from({ length: 10 }, (_, i) => ({
        unit: `u${String(i)}`,
        team: 't',
        preSpend: 100,
        stratum: 't#0',
        arm: i < 2 ? ('holdout' as const) : ('treated' as const),
      })),
    );
    expect(flat.standardisedMeanDifference).toBeUndefined();
    expect(flat.balanced).toBe(true);
    expect(BALANCE_THRESHOLD_SMD).toBeLessThanOrEqual(0.1);
  });

  it('hashes roster identifiers so a file naming people yields a design that does not', () => {
    const roster =
      'identifier,team,credits\nAda@Example.com,platform,500\nada@example.com,platform,500\n';
    const units = parseRoster(roster, 'salt');
    expect(units).toHaveLength(1);
    expect(units[0]?.unit).not.toContain('ada');
    expect(units[0]?.team).toBe('platform');
    expect(units[0]?.preSpend).toBe(500);
  });
});

describe('D8.7 · power, computed before the experiment runs', () => {
  it('matches known normal quantiles', () => {
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959964, 5);
    expect(inverseNormalCdf(0.8)).toBeCloseTo(0.8416212, 5);
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 8);
    expect(inverseNormalCdf(0.025)).toBeCloseTo(-1.959964, 5);
    expect(Number.isNaN(inverseNormalCdf(0))).toBe(true);
  });

  it('reproduces the textbook two-sample MDE', () => {
    // (1.9599640 + 0.8416212) × 1 × sqrt(2/100)
    const verdict = assessPower({ standardDeviation: 1, treatedUnits: 100, holdoutUnits: 100 });
    expect(verdict.minimumDetectableEffect).toBeCloseTo(0.396204, 6);
  });

  it('inverts to the sample size the same MDE implies', () => {
    const n = requiredUnitsPerArm(0.396204, 1);
    expect(n).toBeGreaterThanOrEqual(99);
    expect(n).toBeLessThanOrEqual(101);
  });

  it('refuses to report a detectable effect when an arm is empty', () => {
    const verdict = assessPower({ standardDeviation: 1, treatedUnits: 10, holdoutUnits: 0 });
    expect(verdict.minimumDetectableEffect).toBeUndefined();
    expect(verdict.detail).toMatch(/design failure/);
  });

  it('flags a small sample as optimistic rather than reporting the number bare', () => {
    const verdict = assessPower({ standardDeviation: 1, treatedUnits: 12, holdoutUnits: 3 });
    expect(verdict.detail).toMatch(/optimistic/);
  });

  it('warns when the simulated effect is smaller than anything the fleet can see', () => {
    const verdict = assessPower({ standardDeviation: 100, treatedUnits: 8, holdoutUnits: 2 });
    const feasibility = assessFeasibility(verdict, 5, 100);
    expect(feasibility.feasible).toBe(false);
    expect(feasibility.detail).toMatch(/we could not tell/);
    expect(feasibility.unitsNeededPerArm).toBeGreaterThan(10);
  });
});

describe('D8.7 · multiplicity', () => {
  // Benjamini & Hochberg 1995, the Needleman et al. p-values from the
  // paper that introduced the procedure.
  const BH_1995 = [
    0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.324, 0.4262, 0.5719,
    0.6528, 0.759, 1.0,
  ];

  it('reproduces the Benjamini–Hochberg worked example', () => {
    const adjusted = benjaminiHochberg(
      BH_1995.map((value, i) => ({ key: `h${String(i)}`, pValue: value })),
      0.05,
    );
    // The published result: four hypotheses rejected, and the fifth
    // (p = 0.0201, threshold 0.0167) not.
    expect(adjusted.filter((entry) => entry.rejected)).toHaveLength(4);
    expect(adjusted[4]?.rejected).toBe(false);
    expect(adjusted[3]?.qValue).toBeCloseTo(0.035625, 6);
  });

  it('keeps more power than Bonferroni would, which is why it is used here', () => {
    // Bonferroni at 0.05/15 rejects three. Dividing alpha by the number of
    // guardrails would make each one too insensitive to catch a real
    // regression, which is the failure this correction has to avoid.
    const bonferroni = BH_1995.filter((p) => p <= 0.05 / BH_1995.length).length;
    const bh = benjaminiHochberg(
      BH_1995.map((value, i) => ({ key: `h${String(i)}`, pValue: value })),
    ).filter((entry) => entry.rejected).length;

    expect(bonferroni).toBe(3);
    expect(bh).toBeGreaterThan(bonferroni);
  });

  it('keeps q-values non-decreasing in p', () => {
    const adjusted = benjaminiHochberg(
      [0.9, 0.01, 0.5, 0.02, 0.3].map((value, i) => ({ key: `h${String(i)}`, pValue: value })),
    );
    const sorted = [...adjusted].sort((a, b) => a.pValue - b.pValue);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]?.qValue).toBeGreaterThanOrEqual(sorted[i - 1]?.qValue ?? 0);
    }
  });

  it('returns results in input order so a report cannot silently re-rank', () => {
    const adjusted = benjaminiHochberg([
      { key: 'z', pValue: 0.9 },
      { key: 'a', pValue: 0.001 },
    ]);
    expect(adjusted.map((entry) => entry.key)).toEqual(['z', 'a']);
  });

  it('recovers a p-value from an interval that just excludes zero', () => {
    const p = pValueFromInterval(1, 0.0001, 1.9999);
    expect(p).toBeDefined();
    expect(p ?? 1).toBeLessThan(0.06);
    expect(p ?? 0).toBeGreaterThan(0.04);
  });

  it('returns nothing for a degenerate interval rather than a confident zero', () => {
    expect(pValueFromInterval(1, 1, 1)).toBeUndefined();
  });
});

describe('D8.2 · pre-registration', () => {
  const design = assignHoldout(fleet(40), { seed: 11 });
  const document = buildPreregistration({
    design,
    horizonDays: 30,
    periodDays: 7,
    alpha: 0.05,
    power: 0.8,
    now: new Date('2026-08-01T00:00:00Z'),
  });

  it('hashes content, not key order', () => {
    const reordered = JSON.parse(
      JSON.stringify({
        ...document.registration,
      }),
    ) as typeof document.registration;
    expect(hashPreregistration(reordered)).toBe(document.hash);
    expect(canonicalise({ b: 1, a: 2 })).toBe(canonicalise({ a: 2, b: 1 }));
  });

  it('names the primary metric as effort per durable change, not credits per PR', () => {
    expect(document.registration.primaryMetric).toBe(PRIMARY_METRIC.id);
    expect(document.registration.primaryMetric).toBe('effort-per-durable-change');
    expect(document.registration.secondaryMetrics).toContain('credits-per-durable-change');
  });

  it('records no expected result', () => {
    const text = JSON.stringify(document.registration).toLowerCase();
    expect(text).not.toContain('expected');
    expect(text).not.toContain('target');
  });

  it('accepts an unchanged analysis', () => {
    const check = checkRegistration(document, document.registration);
    expect(check.status).toBe('registered');
    expect(check.differences).toHaveLength(0);
  });

  it('marks a changed horizon as exploratory, naming the field', () => {
    const check = checkRegistration(document, { ...document.registration, horizonDays: 14 });
    expect(check.status).toBe('amended');
    expect(check.differences.join(' ')).toMatch(/horizonDays: registered 30, running 14/);
    expect(check.detail).toMatch(/exploratory/);
  });

  it('detects a registration edited after the fact', () => {
    const tampered = {
      ...document,
      registration: { ...document.registration, seed: 99 },
    };
    const check = checkRegistration(tampered, tampered.registration);
    expect(check.status).toBe('unregistered');
    expect(check.detail).toMatch(/edited since it was written/);
  });
});

describe('D8.5 · guardrails', () => {
  it('fires when a metric moves the wrong way past its threshold', () => {
    const assessment = evaluateGuardrails([
      { metric: 'cycle-time', baseline: 10, current: 13, observations: 40 },
    ]);
    expect(assessment.breaches).toHaveLength(1);
    expect(assessment.breaches[0]?.adverseMovement).toBeCloseTo(0.3, 6);
  });

  it('does not fire on a movement in the good direction', () => {
    const assessment = evaluateGuardrails([
      { metric: 'cycle-time', baseline: 10, current: 5, observations: 40 },
      { metric: 'pr-throughput', baseline: 2, current: 3, observations: 40 },
    ]);
    expect(assessment.breaches).toHaveLength(0);
  });

  it('refuses to judge a metric with too few observations', () => {
    // A three-commit week must not revert a fleet policy: the revert would
    // be indistinguishable from the guardrail working, and the mechanism
    // would be disarmed within a month.
    const assessment = evaluateGuardrails([
      { metric: 'revert-rate-7d', baseline: 0.02, current: 0.5, observations: 3 },
    ]);
    expect(assessment.breaches).toHaveLength(0);
    expect(assessment.underpowered).toContain('revert-rate-7d');
  });

  it('reports an unobserved guardrail as missing, never as passing', () => {
    const assessment = evaluateGuardrails([]);
    expect(assessment.missing).toHaveLength(GUARDRAIL_METRICS.length);
    expect(assessment.assessed).toHaveLength(0);
  });
});

describe('D8.8 · automatic rollback', () => {
  const breach = {
    metric: 'cycle-time',
    name: 'Cycle time',
    baseline: 10,
    current: 14,
    adverseMovement: 0.4,
    threshold: 0.2,
    detail: 'cycle time up 40%',
  };

  it('holds when nothing breached', () => {
    expect(assessRollback([]).decision).toBe('hold');
  });

  it('reverts on a breach and returns only the inverse artefacts', () => {
    const assessment = assessRollback([breach], {
      artefacts: [
        { path: 'apply.reg', contents: 'a', description: 'apply', role: 'apply' },
        { path: 'rollback.reg', contents: 'r', description: 'undo', role: 'rollback' },
      ],
    });
    expect(assessment.decision).toBe('revert');
    expect(assessment.artefacts.map((a) => a.path)).toEqual(['rollback.reg']);
    expect(assessment.manualActionRequired).toBeUndefined();
  });

  it('says loudly when a revert is warranted but impossible', () => {
    // The silent version of this leaves a harmful policy live while the log
    // reads "rollback".
    const assessment = assessRollback([breach]);
    expect(assessment.decision).toBe('revert');
    expect(assessment.manualActionRequired).toMatch(/still live/);
  });
});

describe('D8.9 · savings P&L honesty', () => {
  const month = (over: number): PnlInput => ({
    month: '2026-08',
    simulatedCredits: 1000,
    treatedMeanCredits: 100 - over,
    holdoutMeanCredits: 100,
    treatedUnits: 20,
    holdoutUnits: 5,
  });

  it('always carries the gap, even when the simulation was right', () => {
    const pnl = buildSavingsPnl([month(50)]);
    expect(pnl.rows[0]?.gapCredits).toBeDefined();
    expect(pnl.realisedCredits).toBe(1000);
    expect(pnl.gapCredits).toBe(0);
    expect(pnl.verdict).toBe('accurate');
  });

  it('reports an over-promising simulator as a TokenLens defect', () => {
    const pnl = buildSavingsPnl([month(10)]);
    expect(pnl.verdict).toBe('over-promised');
    expect(pnl.defect).toMatch(/TokenLens defect/);
    expect(pnl.defect).toMatch(/realisation bands/);
  });

  it('calls out an under-promising simulator too, rather than banking the luck', () => {
    const pnl = buildSavingsPnl([month(100)]);
    expect(pnl.verdict).toBe('under-promised');
    expect(pnl.detail).toMatch(/still a calibration error/);
  });

  it('refuses to compute a realised saving without a control arm', () => {
    const pnl = buildSavingsPnl([{ ...month(50), holdoutUnits: 0 }]);
    expect(pnl.rows[0]?.estimable).toBe(false);
    expect(pnl.rows[0]?.realisedCredits).toBe(0);
    expect(pnl.verdict).toBe('unknown');
    expect(pnl.detail).toMatch(/before-and-after/);
    expect(CALIBRATION_TOLERANCE).toBe(0.2);
  });
});

describe('D8.6 · AUTO-25 override monitor', () => {
  function request(model: string, ts: number): RequestRow {
    return {
      requestId: `${model}-${String(ts)}`,
      sessionId: 's',
      ts,
      model,
      promptTokens: 10,
      outputTokens: 10,
      credits: 1,
      turnIndex: 0,
      sourceFile: 'f',
      sourceOffset: 0,
    };
  }

  const policy: Policy = {
    version: 1,
    model: { default: 'gpt-4.1', route: [{ when: { complexity: 'high' }, to: 'claude-opus-4' }] },
  };

  it('counts a model outside the policy as an override', () => {
    const report = measureOverrides(
      [request('gpt-4.1', 10), request('gpt-4.1', 11), request('o3', 12), request('o3', 13)],
      policy,
    );
    expect(report.overrideRate).toBeCloseTo(0.5, 6);
    expect(report.detail).toMatch(/reaching past a routing decision/);
  });

  it('does not count a routed alternative as an override', () => {
    const report = measureOverrides([request('claude-opus-4', 10), request('gpt-4.1', 11)], policy);
    expect(report.overrides).toBe(0);
    expect(report.overrideRate).toBe(0);
  });

  it('ignores requests that predate the deployment', () => {
    const report = measureOverrides([request('o3', 5), request('gpt-4.1', 50)], policy, {
      since: 20,
    });
    expect(report.requestsConsidered).toBe(1);
    expect(report.overrideRate).toBe(0);
  });

  it('reports no rate at all when the policy sets no default model', () => {
    const report = measureOverrides([request('o3', 10)], { version: 1 });
    expect(report.overrideRate).toBeUndefined();
    expect(report.detail).toMatch(/not a zero override rate/);
  });
});
