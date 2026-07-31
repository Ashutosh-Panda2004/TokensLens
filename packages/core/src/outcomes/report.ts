import { loadOrCreateInstallSalt } from '../ingest/redact.js';
import { assertReportSafe } from '../privacy/guard.js';
import { readGitHistory, isGitRepository, type CommitRecord, type GitRunner } from './git.js';
import { measureDurability, summariseDurability, type DurabilitySummary } from './durability.js';
import {
  decomposeEffort,
  UNAVAILABLE_TERMS,
  type EffortDecomposition,
  type UnavailableTerm,
} from './effort.js';
import { detectDisplacement, type DisplacementReport } from './displacement.js';
import { survivalAt, isEstimableAt } from './survival.js';
import type { PrivacyContext } from '../privacy/scope.js';
import type { DurableChange } from './durability.js';

/**
 * The outcome report answers one question: **was the spend worth it?**
 *
 * Everything through D5 measures cost. An organisation that adopts
 * TokenLens on the strength of those phases has bought a cost-reduction
 * tool that cannot tell it whether the cost reduction hurt. This is the
 * layer that can.
 *
 * ## What it does not do
 *
 * It does not produce a productivity score. It does not rank anybody. It
 * does not claim causation from a before/after comparison — that is
 * `outcomes effect`, which needs a treatment date and a control group, and
 * which refuses to report an estimate when its own pre-trend test fails.
 */
export interface OutcomeReport {
  readonly changeCount: number;
  readonly authorCount: number;
  readonly windowFrom: number;
  readonly windowTo: number;
  readonly durability: DurabilitySummary;
  readonly horizonDays: number;
  /** Share of added lines still present at the horizon. */
  readonly survivalAtHorizon: number | undefined;
  readonly effort: EffortDecomposition;
  /** Measurable human hours per durable change. The productivity denominator. */
  readonly hoursPerDurableChange: number | undefined;
  readonly displacement: DisplacementReport;
  /** Terms of the identity this data cannot supply, with what would unblock them. */
  readonly unavailable: readonly UnavailableTerm[];
  /**
   * Share of deletions the churn attribution actually carried. A low number
   * means most deletion activity was in old code and the survival figures
   * rest on a thin slice.
   */
  readonly attributionCoverage: number;
  readonly privacy: PrivacyContext;
}

export interface OutcomeOptions {
  readonly cwd?: string;
  readonly since?: Date;
  readonly horizonDays?: number;
  readonly windowDays?: number;
  /** Injected so a report is not a function of the clock. */
  readonly now?: number;
  readonly privacy?: PrivacyContext;
  readonly runner?: GitRunner;
}

/** An outcome report describes a repository, not a person. Fail closed anyway. */
const DEFAULT_PRIVACY: PrivacyContext = { scope: 'shared', subjectCount: 1 };

export async function buildOutcomeReport(options: OutcomeOptions = {}): Promise<OutcomeReport> {
  const cwd = options.cwd ?? process.cwd();
  const salt = await loadOrCreateInstallSalt(cwd);

  const commits = await readGitHistory(
    { cwd, ...(options.since !== undefined ? { since: options.since } : {}) },
    salt,
    options.runner,
  );

  return assembleOutcomeReport(commits, options);
}

/**
 * Split from {@link buildOutcomeReport} so the analysis is a pure function
 * of the commit history — which is what makes it testable without a
 * repository, and reproducible given one.
 */
export function assembleOutcomeReport(
  commits: readonly CommitRecord[],
  options: OutcomeOptions = {},
): OutcomeReport {
  const now = options.now ?? Date.now();
  const privacy = options.privacy ?? DEFAULT_PRIVACY;

  const durability = measureDurability(commits, {
    now,
    ...(options.horizonDays !== undefined ? { horizonDays: options.horizonDays } : {}),
  });
  const summary = summariseDurability(durability.changes);
  const effort = decomposeEffort(commits, durability.changes);
  const displacement = detectDisplacement(commits, durability.changes, {
    now,
    ...(options.windowDays !== undefined ? { windowDays: options.windowDays } : {}),
  });

  const timestamps = commits.map((commit) => commit.ts);
  const totalDeletions = durability.attributedDeletions + durability.backgroundDeletions;

  // Quoted only where the curve still has a risk set. Past that point
  // Kaplan-Meier repeats its last value forever, and that flat tail looks
  // like evidence while being nothing of the sort.
  const survival = isEstimableAt(durability.curve, durability.horizonDays)
    ? survivalAt(durability.curve, durability.horizonDays)
    : undefined;

  const report: OutcomeReport = {
    changeCount: durability.changes.length,
    authorCount: new Set(commits.map((commit) => commit.authorId)).size,
    windowFrom: timestamps.length > 0 ? Math.min(...timestamps) : now,
    windowTo: timestamps.length > 0 ? Math.max(...timestamps) : now,
    durability: summary,
    horizonDays: durability.horizonDays,
    survivalAtHorizon: survival,
    effort,
    hoursPerDurableChange:
      summary.durable > 0 ? effort.measurableHours / summary.durable : undefined,
    displacement,
    unavailable: UNAVAILABLE_TERMS,
    attributionCoverage: totalDeletions > 0 ? durability.attributedDeletions / totalDeletions : 0,
    privacy,
  };

  // The same gate the ledger, waste, simulation and policy paths pass
  // through. This report should never trip it — author ids are hashed at
  // ingest and no per-author figure reaches the output — and it runs anyway,
  // because a gate that depends on being remembered is not a gate.
  assertReportSafe(report, privacy);
  return report;
}

/**
 * Aggregates changes into a unit-by-period panel for the causal estimator.
 *
 * The **unit of analysis is the change; the unit of reporting is the group**.
 * That is not a presentation choice, it is the structural anti-surveillance
 * guarantee: individual rows exist transiently inside this function and
 * nowhere in its output.
 */
export interface PanelOptions {
  /** Days per period. 7 gives weeks, which is the usual granularity. */
  readonly periodDays?: number;
  /** Maps a change to its reporting group. Defaults to one group for the repo. */
  readonly groupOf?: (change: DurableChange) => string;
  readonly now?: number;
}

export interface PanelPoint {
  readonly unit: string;
  readonly period: number;
  readonly outcome: number;
  readonly changes: number;
}

export function buildPanel(
  changes: readonly DurableChange[],
  outcome: (changes: readonly DurableChange[]) => number | undefined,
  options: PanelOptions = {},
): PanelPoint[] {
  const periodDays = options.periodDays ?? 7;
  const periodMs = periodDays * 24 * 60 * 60 * 1000;
  const groupOf = options.groupOf ?? ((): string => 'repository');

  const buckets = new Map<string, DurableChange[]>();
  for (const change of changes) {
    const key = `${groupOf(change)}\u0000${String(Math.floor(change.ts / periodMs))}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(change);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .map(([key, bucket]) => {
      const [unit = '', period = '0'] = key.split('\u0000');
      const value = outcome(bucket);
      return value === undefined
        ? undefined
        : { unit, period: Number.parseInt(period, 10), outcome: value, changes: bucket.length };
    })
    .filter((point): point is PanelPoint => point !== undefined)
    .sort((a, b) => a.unit.localeCompare(b.unit) || a.period - b.period);
}

export { isGitRepository };
