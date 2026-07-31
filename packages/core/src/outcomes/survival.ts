/**
 * Survival analysis for code.
 *
 * The question "did this change last?" has the same shape as "did this
 * patient survive?", and it has the same awkward property: most of the
 * subjects have not had the event yet, and the ones observed longest are
 * not a random sample. A change merged yesterday has not been reverted —
 * but concluding it is durable would make the most recent work look
 * perfect, every time the report is run.
 *
 * That is **right-censoring**, and handling it is the whole reason to use
 * survival analysis rather than a ratio. Kaplan–Meier uses a censored
 * observation for as long as it was actually observed and then stops
 * counting it, instead of discarding it (which throws away information) or
 * treating it as a survivor (which is the flattering mistake).
 */

export interface SurvivalObservation {
  /** Time from entry to event or censoring, in the caller's unit. */
  readonly duration: number;
  /** True when the event happened; false when the subject was still alive when observation stopped. */
  readonly event: boolean;
  /** Number of identical subjects this row stands for — lines, usually. */
  readonly weight: number;
}

export interface SurvivalPoint {
  readonly time: number;
  /** Estimated share still alive at this time. */
  readonly survival: number;
  /** Greenwood standard error of `survival`. */
  readonly standardError: number;
  readonly atRisk: number;
  readonly events: number;
}

export interface SurvivalCurve {
  readonly points: readonly SurvivalPoint[];
  /**
   * How many subjects remained at risk after each observed time — censorings
   * included, not only events.
   *
   * Kept because the event points alone cannot answer "is this curve
   * estimable at day 30?". On a two-day-old repository every line is
   * censored at day 2, the last *event* is at day 1 with a large risk set,
   * and a check that looked only at events would happily report survival at
   * day 30 for a horizon nobody has lived through.
   */
  readonly riskSet: readonly { readonly time: number; readonly remaining: number }[];
  readonly subjects: number;
  readonly events: number;
  readonly censored: number;
}

/**
 * Kaplan–Meier product-limit estimator.
 *
 * `S(t) = ∏ (1 - dᵢ/nᵢ)` over event times up to `t`, where `dᵢ` is events at
 * that time and `nᵢ` the number still at risk. Censored subjects leave the
 * risk set without contributing an event, which is exactly the treatment a
 * change that simply has not been alive long enough deserves.
 *
 * Ties are resolved by processing all events at a time before removing that
 * time's censored subjects — the standard convention, and it matters: the
 * other order quietly inflates survival.
 */
export function kaplanMeier(observations: readonly SurvivalObservation[]): SurvivalCurve {
  const usable = observations.filter(
    (row) => Number.isFinite(row.duration) && row.duration >= 0 && row.weight > 0,
  );

  const subjects = usable.reduce((sum, row) => sum + row.weight, 0);
  if (subjects === 0) return { points: [], riskSet: [], subjects: 0, events: 0, censored: 0 };

  const byTime = new Map<number, { events: number; censored: number }>();
  for (const row of usable) {
    const bucket = byTime.get(row.duration) ?? { events: 0, censored: 0 };
    if (row.event) bucket.events += row.weight;
    else bucket.censored += row.weight;
    byTime.set(row.duration, bucket);
  }

  const times = [...byTime.keys()].sort((a, b) => a - b);
  const points: SurvivalPoint[] = [];
  const riskSet: { time: number; remaining: number }[] = [];

  let atRisk = subjects;
  let survival = 1;
  // Greenwood's formula accumulates Σ dᵢ / (nᵢ(nᵢ - dᵢ)).
  let greenwood = 0;
  let totalEvents = 0;
  let totalCensored = 0;

  for (const time of times) {
    const bucket = byTime.get(time);
    if (!bucket) continue;

    if (bucket.events > 0 && atRisk > 0) {
      survival *= 1 - bucket.events / atRisk;
      const denominator = atRisk * (atRisk - bucket.events);
      greenwood += denominator > 0 ? bucket.events / denominator : 0;
      totalEvents += bucket.events;

      points.push({
        time,
        survival,
        standardError: survival * Math.sqrt(greenwood),
        atRisk,
        events: bucket.events,
      });
    }

    totalCensored += bucket.censored;
    atRisk -= bucket.events + bucket.censored;
    riskSet.push({ time, remaining: atRisk });
  }

  return { points, riskSet, subjects, events: totalEvents, censored: totalCensored };
}

/**
 * Survival at `time`, read off the step function.
 *
 * Returns 1 before the first event — which is correct and not a placeholder:
 * with no events yet, nothing has died.
 */
export function survivalAt(curve: SurvivalCurve, time: number): number {
  let value = 1;
  for (const point of curve.points) {
    if (point.time > time) break;
    value = point.survival;
  }
  return value;
}

/** Subjects still under observation at `time`. */
export function atRiskAt(curve: SurvivalCurve, time: number): number {
  let remaining = curve.subjects;
  for (const entry of curve.riskSet) {
    if (entry.time > time) break;
    remaining = entry.remaining;
  }
  return remaining;
}

/**
 * Whether the curve is estimated well enough at `time` to be quoted.
 *
 * Past the point where the risk set has emptied, Kaplan–Meier keeps
 * reporting its last value forever, and that flat tail looks like evidence
 * while being nothing of the sort. The check has to count **censorings as
 * well as events** — on a two-day-old repository the last event is at day 1
 * with thousands of lines still at risk, and a check that looked only at
 * event points would cheerfully report 96% survival at a thirty-day horizon
 * nobody has lived through. That is the exact flattering error this module
 * exists to prevent, and it was found by running the tool on its own
 * repository.
 */
export function isEstimableAt(curve: SurvivalCurve, time: number, minimumAtRisk = 10): boolean {
  return atRiskAt(curve, time) >= minimumAtRisk;
}

export interface LogRankResult {
  readonly chiSquare: number;
  /** Approximate two-sided p-value on 1 degree of freedom. */
  readonly pValue: number;
  readonly observedA: number;
  readonly expectedA: number;
  readonly comparable: boolean;
}

/**
 * Log-rank test — the standard way to ask whether two survival curves
 * differ, without assuming a shape for either.
 *
 * It compares observed events in group A against the number expected if
 * both groups shared one hazard, pooled across every event time. Reported
 * with `comparable: false` when either group is too small for the
 * chi-square approximation to mean anything, because a p-value computed on
 * four observations is worse than no p-value.
 */
export function logRankTest(
  groupA: readonly SurvivalObservation[],
  groupB: readonly SurvivalObservation[],
  minimumGroupSize = 20,
): LogRankResult {
  const times = [...new Set([...groupA, ...groupB].map((row) => row.duration))].sort(
    (a, b) => a - b,
  );

  const totalA = groupA.reduce((sum, row) => sum + row.weight, 0);
  const totalB = groupB.reduce((sum, row) => sum + row.weight, 0);

  let atRiskA = totalA;
  let atRiskB = totalB;
  let observedA = 0;
  let expectedA = 0;
  let variance = 0;

  for (const time of times) {
    const eventsA = weightAt(groupA, time, true);
    const eventsB = weightAt(groupB, time, true);
    const events = eventsA + eventsB;
    const atRisk = atRiskA + atRiskB;

    if (events > 0 && atRisk > 1) {
      observedA += eventsA;
      expectedA += (events * atRiskA) / atRisk;
      variance +=
        (events * atRiskA * atRiskB * (atRisk - events)) / (atRisk * atRisk * (atRisk - 1));
    }

    atRiskA -= eventsA + weightAt(groupA, time, false);
    atRiskB -= eventsB + weightAt(groupB, time, false);
  }

  const comparable = totalA >= minimumGroupSize && totalB >= minimumGroupSize && variance > 0;
  const chiSquare = comparable ? (observedA - expectedA) ** 2 / variance : 0;

  return {
    chiSquare,
    pValue: comparable ? chiSquarePValue1df(chiSquare) : 1,
    observedA,
    expectedA,
    comparable,
  };
}

function weightAt(rows: readonly SurvivalObservation[], time: number, event: boolean): number {
  let total = 0;
  for (const row of rows) {
    if (row.duration === time && row.event === event) total += row.weight;
  }
  return total;
}

/**
 * Upper tail of the chi-square distribution on one degree of freedom, which
 * reduces to `erfc(√(x/2))`. Abramowitz–Stegun 7.1.26 gives `erfc` to about
 * 1.5e-7 — far tighter than the sampling error of anything this is applied
 * to, and it avoids a dependency for one function.
 */
function chiSquarePValue1df(chiSquare: number): number {
  if (!Number.isFinite(chiSquare) || chiSquare <= 0) return 1;
  return erfc(Math.sqrt(chiSquare / 2));
}

function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const tau =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? tau : 2 - tau;
}
