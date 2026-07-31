import {
  estimateStaggeredDid,
  type CohortAssignment,
  type DidResult,
  type PanelRow,
} from '../outcomes/did.js';
import type { DurableChange } from '../outcomes/durability.js';
import { buildPanel } from '../outcomes/report.js';
import type { Assignment } from './assignment.js';
import { assessBalance, type BalanceReport } from './assignment.js';
import { assessPower, type PowerVerdict } from './power.js';
import {
  evaluateGuardrails,
  GUARDRAIL_METRICS,
  PRIMARY_METRIC,
  SECONDARY_METRICS,
  UNAVAILABLE_METRICS,
  type GuardrailAssessment,
  type MetricObservation,
  type UnavailableMetric,
} from './metrics.js';
import { benjaminiHochberg, pValueFromInterval, type AdjustedHypothesis } from './multiplicity.js';
import type { RegistrationCheck } from './preregistration.js';

/**
 * **D8 — the analysis, assembled.**
 *
 * The ordering of this report is not cosmetic. It runs:
 *
 * 1. registration status,
 * 2. balance,
 * 3. power,
 * 4. **then** the effect.
 *
 * Every one of the first three can invalidate the fourth, and each is far
 * easier to accept before the estimate is visible than after. A report that
 * leads with the number and appends its caveats has, in practice, published
 * the number.
 */
export interface HypothesisResult {
  readonly metric: string;
  readonly name: string;
  readonly role: 'primary' | 'secondary' | 'guardrail';
  readonly effect:
    { readonly point: number; readonly low: number; readonly high: number } | undefined;
  readonly pValue: number | undefined;
  readonly qValue: number | undefined;
  readonly significant: boolean;
  readonly detail: string;
}

export interface HoldoutAnalysis {
  readonly registration: RegistrationCheck | undefined;
  readonly balance: BalanceReport;
  readonly power: PowerVerdict;
  readonly primary: HypothesisResult;
  readonly secondary: readonly HypothesisResult[];
  readonly guardrails: GuardrailAssessment;
  readonly did: DidResult | undefined;
  readonly unavailable: readonly UnavailableMetric[];
  readonly verdict: string;
}

export interface AnalyseOptions {
  readonly assignments: readonly Assignment[];
  readonly changes: readonly DurableChange[];
  readonly deployedAt: number | undefined;
  readonly periodDays: number;
  readonly registration?: RegistrationCheck;
  /** Secondary and guardrail levels, supplied by the caller from the ledger. */
  readonly observations?: readonly MetricObservation[];
  readonly alpha?: number;
  readonly power?: number;
}

/**
 * The primary metric — effort per durable change — is estimated with the
 * same staggered difference-in-differences machinery as D10, with the arms
 * as cohorts: the treated arm has a treatment period, the holdout never
 * does. Reusing the estimator rather than writing a two-sample t-test is
 * deliberate; the t-test would ignore the pre-period entirely, and the
 * pre-trend check is the only thing standing between this and a
 * before/after chart with error bars.
 */
export function analyseHoldout(options: AnalyseOptions): HoldoutAnalysis {
  const balance = assessBalance(options.assignments);
  const armOf = new Map(options.assignments.map((a) => [a.unit, a.arm]));

  const panel = buildPanel(
    options.changes,
    (changes) => {
      const observed = changes.filter((change) => change.fullyObserved);
      if (observed.length === 0) return undefined;
      // Higher is better here — the share of a change that survived — and
      // the direction is carried in the metric definition rather than
      // flipped silently in the estimator.
      return observed.reduce((sum, c) => sum + c.survivingFraction, 0) / observed.length;
    },
    { periodDays: options.periodDays, groupOf: (change) => change.authorId },
  );

  const panelRows: PanelRow[] = panel.map((point) => ({
    unit: point.unit,
    period: point.period,
    outcome: point.outcome,
  }));

  const periodMs = options.periodDays * 24 * 60 * 60 * 1000;
  const treatedPeriod =
    options.deployedAt === undefined ? undefined : Math.floor(options.deployedAt / periodMs);

  const cohorts: CohortAssignment[] = options.assignments.map((assignment) =>
    assignment.arm === 'treated' && treatedPeriod !== undefined
      ? { unit: assignment.unit, treatedAt: treatedPeriod }
      : { unit: assignment.unit },
  );

  const observedUnits = new Set(panelRows.map((row) => row.unit));
  const treatedObserved = [...observedUnits].filter((u) => armOf.get(u) === 'treated').length;
  const holdoutObserved = [...observedUnits].filter((u) => armOf.get(u) === 'holdout').length;

  const outcomes = panelRows.map((row) => row.outcome);
  const power = assessPower({
    standardDeviation: standardDeviation(outcomes),
    treatedUnits: treatedObserved,
    holdoutUnits: holdoutObserved,
    ...(options.alpha !== undefined ? { alpha: options.alpha } : {}),
    ...(options.power !== undefined ? { power: options.power } : {}),
    baseline: mean(outcomes),
  });

  const estimable =
    treatedPeriod !== undefined &&
    panelRows.length > 0 &&
    treatedObserved > 0 &&
    holdoutObserved > 0;
  const did = estimable ? estimateStaggeredDid(panelRows, cohorts) : undefined;

  const primary = toPrimary(did, options.deployedAt, treatedObserved, holdoutObserved);
  const secondary = toSecondary(options.observations ?? []);
  const guardrails = evaluateGuardrails(options.observations ?? [], GUARDRAIL_METRICS);

  return {
    registration: options.registration,
    balance,
    power,
    primary,
    secondary,
    guardrails,
    did,
    unavailable: UNAVAILABLE_METRICS,
    verdict: verdictOf(primary, guardrails, options.registration, did),
  };
}

function toPrimary(
  did: DidResult | undefined,
  deployedAt: number | undefined,
  treated: number,
  holdout: number,
): HypothesisResult {
  if (deployedAt === undefined) {
    return {
      metric: PRIMARY_METRIC.id,
      name: PRIMARY_METRIC.name,
      role: 'primary',
      effect: undefined,
      pValue: undefined,
      qValue: undefined,
      significant: false,
      detail:
        'The policy has not been recorded as deployed, so there is no treatment date and nothing to ' +
        'estimate. Run `tokenlens holdout deploy` at the moment of the push.',
    };
  }
  if (!did || treated === 0 || holdout === 0) {
    return {
      metric: PRIMARY_METRIC.id,
      name: PRIMARY_METRIC.name,
      role: 'primary',
      effect: undefined,
      pValue: undefined,
      qValue: undefined,
      significant: false,
      detail:
        `Only ${String(treated)} treated and ${String(holdout)} held-out unit(s) produced any observable ` +
        'outcome, so no contrast exists. This is missing data, not a null result, and must never be ' +
        'reported as "no effect".',
    };
  }

  const att = did.att;
  const p = att === undefined ? undefined : pValueFromInterval(att.point, att.low, att.high);

  return {
    metric: PRIMARY_METRIC.id,
    name: PRIMARY_METRIC.name,
    role: 'primary',
    effect: att,
    pValue: p,
    // The primary hypothesis is pre-registered and tested once, so it is
    // not part of the multiplicity family — correcting it would penalise
    // the one hypothesis that was declared in advance.
    qValue: p,
    significant: att !== undefined && (att.low > 0 || att.high < 0),
    detail:
      att === undefined
        ? 'The estimator returned no average treatment effect: no cohort had both a usable pre-period and a usable post-period.'
        : did.preTrend.passes
          ? `Estimated effect ${att.point.toFixed(4)} [${att.low.toFixed(4)}, ${att.high.toFixed(4)}].`
          : `Estimated effect ${att.point.toFixed(4)} [${att.low.toFixed(4)}, ${att.high.toFixed(4)}], but the ` +
            'pre-trend check failed. The arms were already diverging before the policy, so this number ' +
            'describes a difference and does not attribute it.',
  };
}

/**
 * Secondary metrics get the Benjamini–Hochberg correction; the primary does
 * not. See `multiplicity.ts` for why that asymmetry is the right one.
 */
function toSecondary(observations: readonly MetricObservation[]): HypothesisResult[] {
  const definitions = [...SECONDARY_METRICS, ...GUARDRAIL_METRICS];
  const byId = new Map(observations.map((o) => [o.metric, o]));

  const raw = definitions.map((definition) => {
    const observation = byId.get(definition.id);
    if (!observation || observation.observations < definition.minimumObservations) {
      return {
        definition,
        observation,
        pValue: undefined,
      };
    }
    // A crude two-proportion-free z on the relative movement, using the
    // observation count as the sample size. This is a screening statistic
    // only: effect sizes are always reported from the levels themselves.
    const relative =
      observation.baseline === 0
        ? 0
        : (observation.current - observation.baseline) / Math.abs(observation.baseline);
    const se = 1 / Math.sqrt(observation.observations);
    const p = se > 0 ? twoSided(Math.abs(relative) / se) : undefined;
    return { definition, observation, pValue: p };
  });

  const adjusted: AdjustedHypothesis[] = benjaminiHochberg(
    raw
      .filter((entry) => entry.pValue !== undefined)
      .map((entry) => ({ key: entry.definition.id, pValue: entry.pValue ?? 1 })),
  );
  const byKey = new Map(adjusted.map((entry) => [entry.key, entry]));

  return raw.map((entry) => {
    const q = byKey.get(entry.definition.id);
    const observation = entry.observation;
    return {
      metric: entry.definition.id,
      name: entry.definition.name,
      role: entry.definition.role === 'guardrail' ? ('guardrail' as const) : ('secondary' as const),
      effect:
        observation === undefined
          ? undefined
          : {
              point: observation.current - observation.baseline,
              low: Number.NaN,
              high: Number.NaN,
            },
      pValue: entry.pValue,
      qValue: q?.qValue,
      significant: q?.rejected ?? false,
      detail:
        observation === undefined
          ? 'Not observed in this window.'
          : observation.observations < entry.definition.minimumObservations
            ? `Only ${String(observation.observations)} observation(s); the metric needs ` +
              `${String(entry.definition.minimumObservations)} before it is allowed to claim anything.`
            : `${observation.baseline.toFixed(3)} → ${observation.current.toFixed(3)}` +
              (entry.definition.caveat === undefined ? '' : ` — ${entry.definition.caveat}`),
    };
  });
}

function verdictOf(
  primary: HypothesisResult,
  guardrails: GuardrailAssessment,
  registration: RegistrationCheck | undefined,
  did: DidResult | undefined,
): string {
  if (registration && registration.status !== 'registered') {
    return (
      'EXPLORATORY — ' +
      registration.detail +
      ' Nothing below may be presented as a pre-registered result.'
    );
  }
  if (guardrails.breaches.length > 0) {
    return `GUARDRAIL BREACH — ${String(guardrails.breaches.length)} guardrail(s) moved the wrong way. The policy should already have been reverted; a saving bought with a regression is not a saving.`;
  }
  if (primary.effect === undefined) return `NO ESTIMATE — ${primary.detail}`;
  if (did && !did.preTrend.passes) {
    return 'DESCRIPTIVE ONLY — the pre-trend check failed, so the difference between the arms cannot be attributed to the policy.';
  }
  if (!primary.significant) {
    return (
      'NO DETECTABLE EFFECT — the interval includes zero. Whether that means "no effect" or "not enough ' +
      'data" is answered by the minimum detectable effect above, and it is almost always the latter.'
    );
  }
  return `EFFECT DETECTED — ${primary.detail}`;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

function twoSided(z: number): number {
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const upper =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.min(1, 2 * upper);
}
