/**
 * Estimating what a change in AI availability actually did.
 *
 * ## Why not simply correlate usage with outcomes
 *
 * Because the correlation is not merely noisy — it is **biased in an
 * unknown direction**. Developers reach for AI on tedious work, which is
 * fast anyway, *and* on work they are stuck on, which is slow anyway. The
 * sign of the selection flips by task type, so no amount of data fixes it
 * and no confidence interval around it means anything.
 *
 * An effect is a difference between two states of the world. Without a
 * contrast there is no effect to estimate, only an association to describe.
 *
 * ## Why not two-way fixed effects
 *
 * TWFE is the reflex, and under **staggered** adoption with effects that
 * differ across cohorts it is provably biased: already-treated units end up
 * serving as controls for later-treated ones, so a genuinely positive
 * effect can be reported with the wrong sign. {@link estimateTwoWayFixedEffects}
 * is included precisely so a test can show the divergence rather than a
 * comment asserting it.
 *
 * The Callaway–Sant'Anna construction below avoids it by only ever
 * comparing a cohort against units that have **not yet** been treated.
 */

export interface PanelRow {
  /** Team, repo or squad. Never an individual. */
  readonly unit: string;
  /** Integer period index — week or month. Contiguous, ascending. */
  readonly period: number;
  readonly outcome: number;
}

export interface CohortAssignment {
  readonly unit: string;
  /** Period the unit was first treated. Absent means never treated. */
  readonly treatedAt?: number;
}

export interface Interval {
  readonly point: number;
  readonly low: number;
  readonly high: number;
}

export interface EventStudyPoint {
  /** Periods relative to treatment. Negative is before, and should be ~0. */
  readonly relativePeriod: number;
  readonly effect: Interval;
  readonly units: number;
}

export interface PreTrendVerdict {
  /**
   * False when any pre-treatment period shows an effect whose interval
   * excludes zero. The design's parallel-trends assumption is then not
   * supported and no estimate should be quoted from it.
   */
  readonly passes: boolean;
  /**
   * True when there were no pre-treatment periods to look at. Distinct from
   * failing: nothing diverged, nothing was checked. The refusal is the same
   * but the reason a reader is given must not be.
   */
  readonly untestable: boolean;
  readonly worstPeriod: number | undefined;
  readonly worstEffect: Interval | undefined;
  readonly periodsTested: number;
  readonly detail: string;
}

export interface DidResult {
  /** Average effect on the treated. `undefined` when nothing was estimable. */
  readonly att: Interval | undefined;
  readonly eventStudy: readonly EventStudyPoint[];
  readonly preTrend: PreTrendVerdict;
  readonly treatedUnits: number;
  readonly controlUnits: number;
  readonly cohorts: readonly number[];
  /** Cohort/period cells dropped for want of a comparison or a base period. */
  readonly droppedCells: number;
  readonly comparisonGroup: ComparisonGroup;
}

export type ComparisonGroup = 'never-treated' | 'not-yet-treated';

export interface DidOptions {
  /**
   * `never-treated` is cleaner but needs units that never adopt — often
   * none, once a rollout completes. `not-yet-treated` uses later cohorts as
   * controls while they are still untreated, which is what makes a fully
   * rolled-out history analysable at all.
   */
  readonly comparisonGroup?: ComparisonGroup;
  readonly bootstrapSamples?: number;
  /** Two-sided. 0.05 gives a 95% interval. */
  readonly alpha?: number;
  /** Seeded, because a report that changes between runs is not a report. */
  readonly seed?: number;
  readonly minUnitsPerSide?: number;
}

const DEFAULT_BOOTSTRAP = 1000;
const DEFAULT_ALPHA = 0.05;
const DEFAULT_SEED = 20260731;
const DEFAULT_MIN_UNITS = 3;

/**
 * Callaway–Sant'Anna group-time average treatment effects, aggregated.
 *
 * For a cohort `g` first treated at period `g`, and an outcome period `t`:
 *
 * ```
 * ATT(g,t) = E[Yₜ - Y_{g-1} | treated at g] - E[Yₜ - Y_{g-1} | not yet treated]
 * ```
 *
 * Every comparison is anchored on `g-1`, the last period before that cohort
 * was treated, so nothing already-treated is ever used as a control.
 *
 * Intervals come from a **cluster bootstrap on the unit**, not the
 * observation. Weeks within a team are correlated; resampling them
 * independently would produce intervals several times too narrow, which is
 * the most common way an analysis like this reports significance it has not
 * earned.
 */
export function estimateStaggeredDid(
  panel: readonly PanelRow[],
  cohorts: readonly CohortAssignment[],
  options: DidOptions = {},
): DidResult {
  const comparisonGroup = options.comparisonGroup ?? 'not-yet-treated';
  const alpha = options.alpha ?? DEFAULT_ALPHA;
  const minUnits = options.minUnitsPerSide ?? DEFAULT_MIN_UNITS;

  const treatedAt = new Map(cohorts.map((entry) => [entry.unit, entry.treatedAt]));
  const outcomes = new Map<string, Map<number, number>>();
  for (const row of panel) {
    const byPeriod = outcomes.get(row.unit) ?? new Map<number, number>();
    byPeriod.set(row.period, row.outcome);
    outcomes.set(row.unit, byPeriod);
  }

  const units = [...outcomes.keys()].sort();
  const periods = [...new Set(panel.map((row) => row.period))].sort((a, b) => a - b);
  const cohortPeriods = [
    ...new Set(
      units
        .map((unit) => treatedAt.get(unit))
        .filter((period): period is number => period !== undefined),
    ),
  ].sort((a, b) => a - b);

  const estimate = (sample: readonly string[]): Aggregates =>
    aggregate(sample, outcomes, treatedAt, periods, cohortPeriods, comparisonGroup, minUnits);

  const point = estimate(units);
  const draws = bootstrap(units, estimate, options);

  const eventStudy: EventStudyPoint[] = [...point.byRelativePeriod.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([relativePeriod, value]) => ({
      relativePeriod,
      effect: intervalFrom(
        value.effect,
        draws.map((draw) => draw.byRelativePeriod.get(relativePeriod)?.effect),
        alpha,
      ),
      units: value.units,
    }));

  return {
    att:
      point.overall === undefined
        ? undefined
        : intervalFrom(
            point.overall,
            draws.map((draw) => draw.overall),
            alpha,
          ),
    eventStudy,
    preTrend: judgePreTrend(eventStudy),
    treatedUnits: units.filter((unit) => treatedAt.get(unit) !== undefined).length,
    controlUnits: units.filter((unit) => treatedAt.get(unit) === undefined).length,
    cohorts: cohortPeriods,
    droppedCells: point.droppedCells,
    comparisonGroup,
  };
}

interface Aggregates {
  readonly overall: number | undefined;
  readonly byRelativePeriod: Map<number, { effect: number; units: number }>;
  readonly droppedCells: number;
}

function aggregate(
  units: readonly string[],
  outcomes: ReadonlyMap<string, Map<number, number>>,
  treatedAt: ReadonlyMap<string, number | undefined>,
  periods: readonly number[],
  cohortPeriods: readonly number[],
  comparisonGroup: ComparisonGroup,
  minUnits: number,
): Aggregates {
  const byRelative = new Map<number, { total: number; weight: number; units: number }>();
  let postTotal = 0;
  let postWeight = 0;
  let droppedCells = 0;

  for (const g of cohortPeriods) {
    const treated = units.filter((unit) => treatedAt.get(unit) === g);
    if (treated.length < minUnits) continue;

    const base = g - 1;

    for (const t of periods) {
      if (t === base) continue;

      const controls = units.filter((unit) => {
        const unitCohort = treatedAt.get(unit);
        if (unitCohort === undefined) return true;
        if (comparisonGroup === 'never-treated') return false;
        // Still untreated at both the base period and the outcome period.
        return unitCohort > Math.max(t, g);
      });
      if (controls.length < minUnits) {
        droppedCells += 1;
        continue;
      }

      const treatedDelta = meanDelta(treated, outcomes, base, t);
      const controlDelta = meanDelta(controls, outcomes, base, t);
      if (treatedDelta === undefined || controlDelta === undefined) {
        droppedCells += 1;
        continue;
      }

      const effect = treatedDelta - controlDelta;
      const relative = t - g;
      const bucket = byRelative.get(relative) ?? { total: 0, weight: 0, units: 0 };
      bucket.total += effect * treated.length;
      bucket.weight += treated.length;
      bucket.units = Math.max(bucket.units, treated.length);
      byRelative.set(relative, bucket);

      // The headline aggregates post-treatment periods only, weighted by
      // cohort size, so a large late cohort does not count the same as a
      // two-team pilot.
      if (relative >= 0) {
        postTotal += effect * treated.length;
        postWeight += treated.length;
      }
    }
  }

  return {
    overall: postWeight > 0 ? postTotal / postWeight : undefined,
    byRelativePeriod: new Map(
      [...byRelative.entries()].map(([relative, bucket]) => [
        relative,
        { effect: bucket.weight > 0 ? bucket.total / bucket.weight : 0, units: bucket.units },
      ]),
    ),
    droppedCells,
  };
}

function meanDelta(
  units: readonly string[],
  outcomes: ReadonlyMap<string, Map<number, number>>,
  base: number,
  target: number,
): number | undefined {
  let total = 0;
  let count = 0;
  for (const unit of units) {
    const series = outcomes.get(unit);
    const from = series?.get(base);
    const to = series?.get(target);
    if (from === undefined || to === undefined) continue;
    total += to - from;
    count += 1;
  }
  return count > 0 ? total / count : undefined;
}

function bootstrap(
  units: readonly string[],
  estimate: (sample: readonly string[]) => Aggregates,
  options: DidOptions,
): Aggregates[] {
  const samples = options.bootstrapSamples ?? DEFAULT_BOOTSTRAP;
  const random = mulberry32(options.seed ?? DEFAULT_SEED);
  const draws: Aggregates[] = [];

  for (let i = 0; i < samples; i += 1) {
    // Resample *units* with replacement. Resampling observations would
    // treat weeks within a team as independent, which they are not, and
    // would produce intervals several times too narrow.
    const sample = Array.from(
      { length: units.length },
      () => units[Math.floor(random() * units.length)] ?? units[0] ?? '',
    );
    draws.push(estimate(sample));
  }

  return draws;
}

function intervalFrom(
  point: number,
  draws: readonly (number | undefined)[],
  alpha: number,
): Interval {
  const values = draws
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  if (values.length === 0) return { point, low: point, high: point };

  return {
    point,
    low: percentile(values, alpha / 2),
    high: percentile(values, 1 - alpha / 2),
  };
}

function percentile(sortedAscending: readonly number[], q: number): number {
  const index = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.ceil(q * sortedAscending.length) - 1),
  );
  return sortedAscending[index] ?? 0;
}

/**
 * Whether the design's central assumption survives its own data.
 *
 * Parallel trends cannot be proven, but it can be **falsified**: if treated
 * and control units were already diverging before treatment, the estimate
 * afterwards is measuring that divergence. Any pre-treatment period whose
 * interval excludes zero fails the design, and the verdict is printed
 * *above* the estimate rather than as a footnote beneath it.
 */
function judgePreTrend(eventStudy: readonly EventStudyPoint[]): PreTrendVerdict {
  const pre = eventStudy.filter((point) => point.relativePeriod < -1);
  if (pre.length === 0) {
    return {
      passes: false,
      untestable: true,
      worstPeriod: undefined,
      worstEffect: undefined,
      periodsTested: 0,
      detail:
        'No pre-treatment periods were estimable, so parallel trends could not be tested at all. ' +
        'An untested assumption is not a satisfied one — treat any estimate from this panel as descriptive.',
    };
  }

  const violations = pre.filter((point) => point.effect.low > 0 || point.effect.high < 0);
  const worst = [...pre].sort(
    (a, b) =>
      Math.abs(b.effect.point) - Math.abs(a.effect.point) || a.relativePeriod - b.relativePeriod,
  )[0];

  return {
    passes: violations.length === 0,
    untestable: false,
    worstPeriod: worst?.relativePeriod,
    worstEffect: worst?.effect,
    periodsTested: pre.length,
    detail:
      violations.length === 0
        ? `${String(pre.length)} pre-treatment period(s) tested; none shows a difference distinguishable from zero. The design holds.`
        : `${String(violations.length)} of ${String(pre.length)} pre-treatment period(s) already differ from zero. ` +
          'Treated and control units were diverging before treatment, so anything measured afterwards includes that divergence. No estimate should be quoted from this panel.',
  };
}

/**
 * Two-way fixed effects, by within-transformation.
 *
 * Exported **so it can be shown to be wrong**. Under staggered adoption
 * with heterogeneous effects this uses already-treated units as controls
 * for later-treated ones, and can return an estimate of the opposite sign
 * to the truth. `outcomes.did.test.ts` plants a known effect and
 * demonstrates the divergence, so the choice of estimator is justified by a
 * failing alternative rather than by assertion.
 */
export function estimateTwoWayFixedEffects(
  panel: readonly PanelRow[],
  cohorts: readonly CohortAssignment[],
): number | undefined {
  const treatedAt = new Map(cohorts.map((entry) => [entry.unit, entry.treatedAt]));
  const rows = panel.map((row) => {
    const cohort = treatedAt.get(row.unit);
    return { ...row, treated: cohort !== undefined && row.period >= cohort ? 1 : 0 };
  });
  if (rows.length === 0) return undefined;

  const grandY = rows.reduce((sum, row) => sum + row.outcome, 0) / rows.length;
  const grandD = rows.reduce((sum, row) => sum + row.treated, 0) / rows.length;

  const unitMeans = groupMeans(rows, (row) => row.unit);
  const periodMeans = groupMeans(rows, (row) => String(row.period));
  let numerator = 0;
  let denominator = 0;

  for (const row of rows) {
    const unit = unitMeans.get(row.unit);
    const period = periodMeans.get(String(row.period));
    if (!unit || !period) continue;

    const y = row.outcome - unit.y - period.y + grandY;
    const d = row.treated - unit.d - period.d + grandD;
    numerator += y * d;
    denominator += d * d;
  }

  return denominator > 0 ? numerator / denominator : undefined;
}

function groupMeans<T extends { outcome: number; treated: number }>(
  rows: readonly T[],
  key: (row: T) => string,
): Map<string, { y: number; d: number }> {
  const totals = new Map<string, { y: number; d: number; n: number }>();
  for (const row of rows) {
    const k = key(row);
    const bucket = totals.get(k) ?? { y: 0, d: 0, n: 0 };
    bucket.y += row.outcome;
    bucket.d += row.treated;
    bucket.n += 1;
    totals.set(k, bucket);
  }
  return new Map(
    [...totals.entries()].map(([k, bucket]) => [
      k,
      { y: bucket.y / bucket.n, d: bucket.d / bucket.n },
    ]),
  );
}

/** Small, fast, seeded PRNG. Determinism is a product requirement, not a convenience. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
