/**
 * **D8.7 — Benjamini–Hochberg, because the secondary metrics are a trap.**
 *
 * There is one primary metric and roughly nine others: three secondary,
 * four guardrails, and whatever gets added next quarter. Test all of them
 * at α = 0.05 and the probability of at least one spurious "significant"
 * result is about 40%. Somebody will find it, and it will be the one that
 * goes in the deck.
 *
 * Bonferroni would fix that and destroy the guardrails: dividing α by ten
 * makes each guardrail so insensitive that a genuine regression sails
 * through. Benjamini–Hochberg controls the **false discovery rate** — the
 * expected share of claimed findings that are wrong — which is the quantity
 * anyone reading the report actually cares about, and it keeps far more
 * power.
 *
 * The primary metric is excluded from the correction. It was named in the
 * pre-registration before any data arrived, so testing it once is not a
 * multiple comparison; sweeping it into the family would penalise the one
 * hypothesis that was declared in advance.
 */

export interface Hypothesis {
  readonly key: string;
  readonly pValue: number;
}

export interface AdjustedHypothesis {
  readonly key: string;
  readonly pValue: number;
  /** BH-adjusted p-value (a q-value): the FDR at which this finding first becomes claimable. */
  readonly qValue: number;
  readonly rejected: boolean;
}

export const DEFAULT_FDR = 0.05;

/**
 * Step-up procedure with the standard monotonicity enforcement — q-values
 * are made non-decreasing in p by sweeping from the largest p downwards.
 * Without it the adjusted values can decrease as the raw p increases, which
 * is indefensible when read off a table.
 */
export function benjaminiHochberg(
  hypotheses: readonly Hypothesis[],
  fdr: number = DEFAULT_FDR,
): AdjustedHypothesis[] {
  const usable = hypotheses.filter((h) => Number.isFinite(h.pValue));
  const m = usable.length;
  if (m === 0) return [];

  const ordered = [...usable].sort((a, b) => a.pValue - b.pValue || a.key.localeCompare(b.key));
  const qValues = new Array<number>(m);

  let running = 1;
  for (let i = m - 1; i >= 0; i -= 1) {
    const entry = ordered[i];
    if (!entry) continue;
    running = Math.min(running, (entry.pValue * m) / (i + 1));
    qValues[i] = running;
  }

  const adjusted = ordered.map((entry, i) => {
    const q = qValues[i] ?? 1;
    return { key: entry.key, pValue: entry.pValue, qValue: Math.min(1, q), rejected: q <= fdr };
  });

  const byKey = new Map(adjusted.map((entry) => [entry.key, entry]));
  return hypotheses
    .map((h) => byKey.get(h.key))
    .filter((entry): entry is AdjustedHypothesis => entry !== undefined);
}

/**
 * Two-sided p-value from a bootstrap confidence interval.
 *
 * The DiD estimator returns intervals rather than p-values, because an
 * interval says how big the effect might be and a p-value only says whether
 * it is distinguishable from zero. But the multiplicity correction needs
 * p-values, so one is recovered by inverting the interval under a normal
 * approximation: the half-width at level α corresponds to
 * $z_{1-\alpha/2}$ standard errors, which gives $\sigma$, which gives the
 * z-statistic.
 *
 * This is an approximation of an approximation and is labelled as such
 * wherever it surfaces. It is used only to *rank and threshold* hypotheses,
 * never to report an effect size — those always come from the interval.
 */
export function pValueFromInterval(
  point: number,
  low: number,
  high: number,
  alpha = 0.05,
): number | undefined {
  const halfWidth = (high - low) / 2;
  if (!(halfWidth > 0)) return undefined;

  // z for the interval's own confidence level.
  const z = alpha === 0.05 ? 1.959963984540054 : Math.abs(inverseNormalQuantile(1 - alpha / 2));
  const standardError = halfWidth / z;
  if (!(standardError > 0)) return undefined;

  const statistic = Math.abs(point / standardError);
  return 2 * (1 - standardNormalCdf(statistic));
}

function standardNormalCdf(x: number): number {
  // Zelen & Severo 26.2.17 — enough precision for a threshold decision, and
  // it keeps this file free of a dependency on power.ts's inverse.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

function inverseNormalQuantile(p: number): number {
  // Bisection: called at most once per hypothesis, and correctness here
  // matters more than speed.
  let low = -10;
  let high = 10;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (standardNormalCdf(mid) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}
