import { createHash } from 'node:crypto';
import type { HoldoutDesign } from './assignment.js';
import { GUARDRAIL_METRICS, PRIMARY_METRIC, SECONDARY_METRICS } from './metrics.js';

/**
 * **D8.2 — the pre-registration artefact.**
 *
 * ## Why a hash, and why before
 *
 * Every step of this analysis has a defensible alternative. Thirty days or
 * sixty for the durability horizon; effort per durable change or per merged
 * PR; drop the two developers who joined mid-quarter or keep them. Each
 * choice is arguable. The problem is that they can be argued *after the
 * results are in*, and a researcher who tries four specifications and
 * reports the one that worked has run four experiments and published one —
 * without lying about anything.
 *
 * The defence is to write the analysis down first and hash it. The hash is
 * not security; nobody is being kept out. It is a **commitment device**: it
 * makes "we always intended to measure it that way" checkable, and it makes
 * the honest alternative — labelling a later analysis *exploratory* —
 * cheap enough to actually do.
 *
 * ## What is deliberately not in here
 *
 * No expected result, no target saving. A registration that records the
 * answer it hopes for is a press release with a timestamp.
 */
export const PREREGISTRATION_VERSION = 1;

export interface Preregistration {
  readonly version: number;
  /** ISO date. The registration is void if the first policy push predates it. */
  readonly registeredAt: string;
  /** Git HEAD at registration time, so the code that will run the analysis is pinned too. */
  readonly commit: string | undefined;
  readonly primaryMetric: string;
  readonly secondaryMetrics: readonly string[];
  readonly guardrails: readonly string[];
  readonly holdoutFraction: number;
  readonly seed: number;
  readonly strata: readonly string[];
  readonly units: number;
  readonly horizonDays: number;
  readonly periodDays: number;
  readonly alpha: number;
  readonly power: number;
  readonly multipleComparisons: 'benjamini-hochberg';
  readonly comparisonGroup: string;
  /** Everything that would make the result uninterpretable, written before it can be rationalised. */
  readonly stoppingRules: readonly string[];
}

export interface PreregistrationDocument {
  readonly registration: Preregistration;
  readonly hash: string;
}

export interface BuildPreregistrationOptions {
  readonly design: HoldoutDesign;
  readonly horizonDays: number;
  readonly periodDays: number;
  readonly alpha: number;
  readonly power: number;
  readonly commit?: string;
  readonly now?: Date;
  readonly comparisonGroup?: string;
}

export function buildPreregistration(
  options: BuildPreregistrationOptions,
): PreregistrationDocument {
  const registration: Preregistration = {
    version: PREREGISTRATION_VERSION,
    registeredAt: (options.now ?? new Date()).toISOString(),
    commit: options.commit,
    primaryMetric: PRIMARY_METRIC.id,
    secondaryMetrics: SECONDARY_METRICS.map((m) => m.id),
    guardrails: GUARDRAIL_METRICS.map((m) => m.id),
    holdoutFraction: options.design.holdoutFraction,
    seed: options.design.seed,
    strata: [...new Set(options.design.assignments.map((a) => a.stratum))].sort(),
    units: options.design.assignments.length,
    horizonDays: options.horizonDays,
    periodDays: options.periodDays,
    alpha: options.alpha,
    power: options.power,
    multipleComparisons: 'benjamini-hochberg',
    comparisonGroup: options.comparisonGroup ?? 'never-treated',
    stoppingRules: [
      'The experiment runs for the full pre-registered window. An interim look does not stop it.',
      'A guardrail breach reverts the policy (AUTO-26) but does not end the observation window; the ' +
        'reverted period is reported, not deleted.',
      'If the pre-trend check fails, the estimate is reported as descriptive and the causal claim is withdrawn.',
      'If the realised saving misses the simulated saving by more than 20%, that gap is reported as a ' +
        'TokenLens defect rather than adjusted away.',
    ],
  };

  return { registration, hash: hashPreregistration(registration) };
}

/**
 * Canonical JSON — keys sorted at every level — so the hash is a property
 * of the *content*, not of whatever order the object literal happened to be
 * written in. Without this, reformatting the file would invalidate the
 * commitment and the mechanism would be abandoned within a week.
 */
export function canonicalise(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`).join(',')}}`;
}

export function hashPreregistration(registration: Preregistration): string {
  return createHash('sha256').update(canonicalise(registration)).digest('hex');
}

export type RegistrationStatus = 'registered' | 'amended' | 'unregistered';

export interface RegistrationCheck {
  readonly status: RegistrationStatus;
  readonly expectedHash: string;
  readonly actualHash: string;
  readonly differences: readonly string[];
  readonly detail: string;
}

/**
 * Compares the analysis about to run against the registered one.
 *
 * Deliberately does **not** throw. Refusing to run would guarantee the
 * mechanism gets bypassed the first time somebody genuinely needs a
 * different specification. Instead the divergence is named, field by field,
 * and the result is stamped `amended` — which every renderer downstream
 * must show, because an exploratory finding presented as a pre-registered
 * one is the exact failure this file exists to prevent.
 */
export function checkRegistration(
  document: PreregistrationDocument,
  actual: Preregistration,
): RegistrationCheck {
  const actualHash = hashPreregistration(actual);
  const differences: string[] = [];

  const keys = new Set([...Object.keys(document.registration), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) {
    // Timestamps and the commit legitimately differ between registration and
    // analysis; that is the whole point of registering early.
    if (key === 'registeredAt' || key === 'commit') continue;
    const before = canonicalise((document.registration as unknown as Record<string, unknown>)[key]);
    const after = canonicalise((actual as unknown as Record<string, unknown>)[key]);
    if (before !== after) differences.push(`${key}: registered ${before}, running ${after}`);
  }

  if (document.hash !== hashPreregistration(document.registration)) {
    return {
      status: 'unregistered',
      expectedHash: document.hash,
      actualHash,
      differences,
      detail:
        'The registration file does not match its own hash. It has been edited since it was written, ' +
        'so it evidences nothing and the analysis must be reported as exploratory.',
    };
  }

  if (differences.length === 0) {
    return {
      status: 'registered',
      expectedHash: document.hash,
      actualHash,
      differences,
      detail: `Analysis matches the registration recorded on ${document.registration.registeredAt.slice(0, 10)}.`,
    };
  }

  return {
    status: 'amended',
    expectedHash: document.hash,
    actualHash,
    differences,
    detail:
      `The analysis differs from the registration in ${String(differences.length)} respect(s). ` +
      'This result is exploratory. That is a legitimate thing to report — it is not a legitimate thing ' +
      'to report as confirmatory.',
  };
}
