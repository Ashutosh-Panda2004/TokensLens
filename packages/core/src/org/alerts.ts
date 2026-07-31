import type { OrgRollup } from './rollup.js';
import type { OrgBundle } from './bundle.js';

/**
 * **D9.6 — anomaly alerts, and the exec report.**
 *
 * ## Why the median absolute deviation and not a standard deviation
 *
 * A spend anomaly *is* an outlier, and outliers inflate the standard
 * deviation they are being compared against. On a series with one genuine
 * spike, a 3σ rule quietly widens σ until the spike sits inside it and
 * nothing fires — the detector is disabled by the very event it exists to
 * catch. The MAD is unaffected by up to half the series being anomalous,
 * which is the property that matters here.
 *
 * The 0.6745 scaling makes the MAD comparable to a standard deviation for
 * normally distributed data, so a threshold of 3.5 means roughly what a
 * reader expects "3.5 sigma" to mean.
 *
 * ## Why nothing is posted anywhere
 *
 * The plan says "Slack/Teams anomaly alerts". Posting requires a network
 * call, and the core makes none — a rule enforced by `arch.test.ts`, not by
 * good intentions. Relaxing it so a chat webhook could be called would put
 * an outbound HTTP client in the same binary that reads developers'
 * conversations, and no amount of care afterwards would make that
 * reviewable again.
 *
 * So this produces the alert **payload** and the organisation's existing
 * plumbing delivers it. That is also less work for whoever adopts it: every
 * company already has a way to post a JSON blob to a channel, and none of
 * them want a second one.
 */
export const MAD_SCALE = 0.6745;
export const DEFAULT_ALERT_THRESHOLD = 3.5;

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface Anomaly {
  readonly day: string;
  readonly credits: number;
  readonly expected: number;
  readonly robustZ: number;
  readonly severity: AlertSeverity;
  readonly detail: string;
}

export interface AnomalyReport {
  readonly anomalies: readonly Anomaly[];
  readonly daysConsidered: number;
  readonly median: number;
  readonly mad: number;
  readonly estimable: boolean;
  readonly detail: string;
}

export interface DailySpend {
  readonly day: string;
  readonly credits: number;
}

export function detectAnomalies(
  series: readonly DailySpend[],
  threshold: number = DEFAULT_ALERT_THRESHOLD,
): AnomalyReport {
  // Fewer than a fortnight and the MAD is being estimated from noise. An
  // alerting system that cries wolf in its first week never gets a second.
  if (series.length < 14) {
    return {
      anomalies: [],
      daysConsidered: series.length,
      median: 0,
      mad: 0,
      estimable: false,
      detail:
        `Only ${String(series.length)} day(s) of history. At least 14 are needed before "unusual" means ` +
        'anything, and an alerting system that fires spuriously in its first week is switched off in its second.',
    };
  }

  const values = series.map((point) => point.credits);
  const median = medianOf(values);
  const mad = medianOf(values.map((v) => Math.abs(v - median)));

  if (mad === 0) {
    return {
      anomalies: [],
      daysConsidered: series.length,
      median,
      mad,
      estimable: false,
      detail:
        'Daily spend has no variation at all, so every deviation is infinitely unusual and none of them ' +
        'are informative. Almost certainly a data problem rather than a spending pattern.',
    };
  }

  const anomalies = series
    .map((point) => {
      const z = (MAD_SCALE * (point.credits - median)) / mad;
      return {
        day: point.day,
        credits: point.credits,
        expected: median,
        robustZ: z,
        severity: severityOf(z, threshold),
        detail:
          `${point.day}: ${point.credits.toFixed(0)} credits against a typical ${median.toFixed(0)} ` +
          `(robust z ${z.toFixed(1)}).`,
      };
    })
    .filter((anomaly) => Math.abs(anomaly.robustZ) >= threshold)
    .sort((a, b) => Math.abs(b.robustZ) - Math.abs(a.robustZ));

  return {
    anomalies,
    daysConsidered: series.length,
    median,
    mad,
    estimable: true,
    detail:
      anomalies.length === 0
        ? `No day deviated more than ${String(threshold)} robust standard deviations from the typical ` +
          `${median.toFixed(0)} credits.`
        : `${String(anomalies.length)} day(s) deviated sharply from a typical ${median.toFixed(0)} credits. ` +
          'Deviation is measured against the median absolute deviation, so a single large spike cannot ' +
          'inflate the threshold and hide itself.',
  };
}

function severityOf(z: number, threshold: number): AlertSeverity {
  const magnitude = Math.abs(z);
  if (magnitude >= threshold * 2) return 'critical';
  if (magnitude >= threshold) return 'warning';
  return 'info';
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

export interface AlertPayload {
  readonly title: string;
  readonly severity: AlertSeverity;
  readonly summary: string;
  readonly facts: readonly { readonly name: string; readonly value: string }[];
  readonly delivery: string;
}

/**
 * Builds what an operator posts. Deliberately shaped as facts rather than
 * prose so it survives being rendered by Slack, Teams, or an e-mail
 * template nobody has written yet.
 */
export function buildAlert(report: AnomalyReport, rollup: OrgRollup): AlertPayload | undefined {
  const worst = report.anomalies[0];
  if (!worst) return undefined;

  return {
    title: `TokenLens: unusual Copilot spend on ${worst.day}`,
    severity: worst.severity,
    summary: worst.detail,
    facts: [
      { name: 'Day', value: worst.day },
      { name: 'Credits', value: worst.credits.toFixed(0) },
      { name: 'Typical', value: worst.expected.toFixed(0) },
      { name: 'Robust z', value: worst.robustZ.toFixed(1) },
      { name: 'Fleet installs', value: String(rollup.installs) },
      { name: 'Other anomalous days', value: String(report.anomalies.length - 1) },
    ],
    delivery:
      'TokenLens does not post this. The core makes no network calls, enforced by an architectural test ' +
      'rather than a promise — pipe this JSON into whatever already posts to your channel.',
  };
}

export interface ExecutiveReport {
  readonly period: string;
  readonly installs: number;
  readonly developers: number;
  readonly totalCredits: number;
  readonly creditsPerDeveloper: number;
  readonly measuredShare: number;
  readonly topModels: readonly { readonly model: string; readonly share: number }[];
  readonly topWaste: readonly { readonly class: string; readonly credits: number }[];
  readonly concentration: string;
  readonly caveats: readonly string[];
}

/**
 * The FinOps report.
 *
 * Its caveats are a required field rather than an appendix, for the same
 * reason `gapCredits` is required in the P&L: the summary is what gets
 * pasted into a deck, and anything optional will not make the journey.
 */
export function buildExecutiveReport(
  rollup: OrgRollup,
  bundles: readonly OrgBundle[],
): ExecutiveReport {
  const caveats: string[] = [
    `${((1 - rollup.measuredShare) * 100).toFixed(0)}% of the credit figure is rate-card estimated rather ` +
      'than measured. Estimates and measurements are not summed anywhere without saying so.',
  ];

  if (!rollup.extrapolationRetired) {
    caveats.push(
      `Only ${String(rollup.installs)} install(s) have synced. Fleet figures below are those installs, ` +
        'not the organisation, and multiplying them by a seat count reproduces exactly the extrapolation ' +
        'error this phase exists to retire.',
    );
  }
  if (rollup.distribution.gini !== undefined && rollup.distribution.gini > 0.5) {
    caveats.push(
      `Spend is concentrated (Gini ${rollup.distribution.gini.toFixed(2)}). Per-developer averages describe ` +
        'nobody; the median is the honest per-seat figure.',
    );
  }
  if (rollup.suppressedTeams > 0) {
    caveats.push(
      `${String(rollup.suppressedTeams)} team(s) are withheld for having fewer than five developers. ` +
        'Their credits are still in the total, so the total is complete even though the breakdown is not.',
    );
  }

  return {
    period: `${rollup.periodFrom} to ${rollup.periodTo}`,
    installs: rollup.installs,
    developers: rollup.developers,
    totalCredits: rollup.totalCredits,
    creditsPerDeveloper: rollup.developers > 0 ? rollup.totalCredits / rollup.developers : 0,
    measuredShare: rollup.measuredShare,
    topModels: rollup.byModel.slice(0, 5).map((m) => ({ model: m.model, share: m.share })),
    topWaste: rollup.byWasteClass.slice(0, 5).map((w) => ({ class: w.class, credits: w.credits })),
    concentration: rollup.distribution.detail,
    caveats: [
      ...caveats,
      `Built from ${String(bundles.length)} bundle(s), each of which carries a manifest of every field it ` +
        'contains. Nothing in this report was derived from source code, prompts or file paths.',
    ],
  };
}
