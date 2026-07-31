import { DAY_MS, type DurableChange } from './durability.js';
import { decomposeEffort, reviewLatencies, type EffortOptions } from './effort.js';
import { formatPercent } from '../waste/format.js';
import type { CommitRecord } from './git.js';

/**
 * **Productivity displacement** — the failure mode where work is not
 * eliminated but moved.
 *
 * Cheaper generation does not automatically mean less work. It can mean the
 * same work, relocated out of authoring and into reviewing, reworking and
 * responding to failures — and relocated work is usually *more* expensive,
 * because review is done by the most senior people available.
 *
 * These classes are named for the same reason W1–W14 are: "productivity is
 * down" is not actionable, and "the same files are being rewritten within a
 * week at twice last quarter's rate" is. Each class that cannot be measured
 * from the available data says so, with what would unblock it, rather than
 * being silently omitted — a skipped class implies zero, which is a
 * stronger claim than the data supports and in the flattering direction.
 */
export type DisplacementClass = 'PD1' | 'PD2' | 'PD3' | 'PD4' | 'PD5' | 'PD6';

export interface DisplacementFinding {
  readonly class: DisplacementClass;
  readonly title: string;
  /** Direction and size of the movement. Sign matters: negative is an improvement. */
  readonly magnitude: number;
  readonly unit: string;
  /** 0..1, rising with the evidence. Never a constant. */
  readonly confidence: number;
  readonly detail: string;
  readonly assumptions: readonly string[];
}

export interface UnavailableDisplacement {
  readonly class: DisplacementClass;
  readonly name: string;
  readonly reason: string;
  readonly unblockedBy: string;
}

export const UNAVAILABLE_DISPLACEMENT: readonly UnavailableDisplacement[] = [
  {
    class: 'PD1',
    name: 'Review displacement',
    reason:
      'Detecting a shift from authoring into reviewing requires knowing how long review took. Git records when a merge happened, not how long anyone spent looking at it.',
    unblockedBy: 'Pull-request review events from the forge API.',
  },
  {
    class: 'PD6',
    name: 'Reviewer concentration',
    reason:
      'Requires knowing who reviewed what, to see review load concentrating on a few people. Git records authorship, not review.',
    unblockedBy: 'The same forge API as PD1.',
  },
];

export interface DisplacementOptions extends EffortOptions {
  /** Length of each comparison window, in days. */
  readonly windowDays?: number;
  readonly now?: number;
}

const DEFAULT_WINDOW_DAYS = 90;
/** Below this many changes in a window, a comparison is noise. */
const MIN_CHANGES_PER_WINDOW = 20;

export interface DisplacementReport {
  readonly findings: readonly DisplacementFinding[];
  readonly unavailable: readonly UnavailableDisplacement[];
  readonly windowDays: number;
  /** True when every measurable signature fired at once. */
  readonly compositeAlarm: boolean;
  readonly compositeDetail: string;
}

/**
 * Compares the most recent window against the one before it.
 *
 * A before/after comparison is **not** a causal claim and is not dressed as
 * one: it says what moved, not what moved it. The causal question is
 * `outcomes effect`, which needs a treatment date and a control group. This
 * exists because a team should be able to see a displacement signature
 * forming without first commissioning a study.
 */
export function detectDisplacement(
  commits: readonly CommitRecord[],
  changes: readonly DurableChange[],
  options: DisplacementOptions = {},
): DisplacementReport {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = options.now ?? Date.now();
  const windowMs = windowDays * DAY_MS;

  const recentFrom = now - windowMs;
  const priorFrom = now - 2 * windowMs;

  const recent = slice(commits, changes, recentFrom, now);
  const prior = slice(commits, changes, priorFrom, recentFrom);

  const findings: DisplacementFinding[] = [];

  if (
    recent.changes.length >= MIN_CHANGES_PER_WINDOW &&
    prior.changes.length >= MIN_CHANGES_PER_WINDOW
  ) {
    findings.push(...churnInflation(recent, prior));
    findings.push(...blastRadiusGrowth(recent, prior, options));
    findings.push(...reworkRecursion(recent, prior, options));
    findings.push(...failureExport(recent, prior));
  }

  // The signature is the *conjunction*. Any one of these alone has an
  // innocent explanation; together they do not.
  const throughputUp =
    signOf(findings, 'PD2') !== undefined && recent.changes.length > prior.changes.length;
  const survivalDown = (signOf(findings, 'PD2') ?? 0) > 0;
  const reworkUp = (signOf(findings, 'PD4') ?? 0) > 0;
  const compositeAlarm = throughputUp && survivalDown && reworkUp;

  return {
    findings: findings.sort((a, b) => b.magnitude - a.magnitude || a.class.localeCompare(b.class)),
    unavailable: UNAVAILABLE_DISPLACEMENT,
    windowDays,
    compositeAlarm,
    compositeDetail: compositeAlarm
      ? 'Throughput rose while survival fell and rework rose. Taken together that is work being relocated rather than eliminated — the pattern that looks like a productivity gain in every metric except the ones that count.'
      : 'The measurable displacement signatures did not fire together. That is not evidence of a gain; it is the absence of evidence of relocation.',
  };
}

interface Window {
  readonly commits: readonly CommitRecord[];
  readonly changes: readonly DurableChange[];
  readonly from: number;
  readonly to: number;
}

function slice(
  commits: readonly CommitRecord[],
  changes: readonly DurableChange[],
  from: number,
  to: number,
): Window {
  return {
    commits: commits.filter((commit) => commit.ts >= from && commit.ts < to),
    changes: changes.filter((change) => change.ts >= from && change.ts < to),
    from,
    to,
  };
}

function churnInflation(recent: Window, prior: Window): DisplacementFinding[] {
  const recentSurvival = meanSurviving(recent.changes);
  const priorSurvival = meanSurviving(prior.changes);
  if (recentSurvival === undefined || priorSurvival === undefined) return [];

  const delta = priorSurvival - recentSurvival;
  if (delta <= 0) return [];

  return [
    {
      class: 'PD2',
      title: 'Less of what is written is surviving',
      magnitude: delta,
      unit: 'share of added lines',
      confidence: sampleConfidence(recent.changes.length + prior.changes.length, 100),
      detail:
        `Surviving share fell from ${formatPercent(priorSurvival)} to ${formatPercent(recentSurvival)} ` +
        `while ${String(recent.changes.length)} change(s) landed, against ${String(prior.changes.length)} before.`,
      assumptions: [
        'deletions are attributed to the most recently added lines first — see `durability.ts` for why that overstates churn against new code',
        'only changes observed for the full horizon contribute',
      ],
    },
  ];
}

function blastRadiusGrowth(
  recent: Window,
  prior: Window,
  options: DisplacementOptions,
): DisplacementFinding[] {
  void options;
  const recentSize = mean(recent.changes.map((change) => change.linesAdded));
  const priorSize = mean(prior.changes.map((change) => change.linesAdded));
  const recentLatency = mean(reviewLatencies(recent.commits));
  const priorLatency = mean(reviewLatencies(prior.commits));

  if (recentSize === undefined || priorSize === undefined || priorSize === 0) return [];
  if (recentLatency === undefined || priorLatency === undefined || priorLatency === 0) return [];

  const sizeGrowth = recentSize / priorSize - 1;
  const latencyGrowth = recentLatency / priorLatency - 1;
  // Bigger changes waved through no more slowly than small ones were.
  if (sizeGrowth <= 0.1 || latencyGrowth >= sizeGrowth) return [];

  return [
    {
      class: 'PD3',
      title: 'Changes grew faster than the time spent waiting on them',
      magnitude: sizeGrowth - latencyGrowth,
      unit: 'growth gap',
      confidence: sampleConfidence(recent.commits.length, 200),
      detail:
        `Mean change size grew ${formatPercent(sizeGrowth)} while merge latency grew ${formatPercent(latencyGrowth)}. ` +
        'Larger changes are being merged no more slowly, which is what under-review looks like from the outside.',
      assumptions: [
        'merge latency is wall-clock waiting, not reviewer attention — a pull request open over a weekend consumed neither',
        'assumes review effort should scale with change size, which is the usual case and not a law',
      ],
    },
  ];
}

function reworkRecursion(
  recent: Window,
  prior: Window,
  options: DisplacementOptions,
): DisplacementFinding[] {
  const recentEffort = decomposeEffort(recent.commits, recent.changes, options);
  const priorEffort = decomposeEffort(prior.commits, prior.changes, options);
  if (recentEffort.reworkRatio === undefined || priorEffort.reworkRatio === undefined) return [];

  const delta = recentEffort.reworkRatio - priorEffort.reworkRatio;
  if (delta <= 0) return [];

  return [
    {
      class: 'PD4',
      title: 'A larger share of effort is going into rewriting recent work',
      magnitude: delta,
      unit: 'rework ratio',
      confidence: sampleConfidence(recent.commits.length, 200),
      detail:
        `Rework and failure effort per hour of authoring rose from ${priorEffort.reworkRatio.toFixed(2)} ` +
        `to ${recentEffort.reworkRatio.toFixed(2)}.`,
      assumptions: [
        'authoring hours are estimated by clustering commits in time; thinking that produced no commit is invisible to it',
        'rework is a share of the same authoring hours, not a separate pot — the terms sum to observed effort',
      ],
    },
  ];
}

function failureExport(recent: Window, prior: Window): DisplacementFinding[] {
  const recentRate = rate(recent.changes, (change) => change.reverted);
  const priorRate = rate(prior.changes, (change) => change.reverted);
  if (recentRate === undefined || priorRate === undefined) return [];

  const delta = recentRate - priorRate;
  if (delta <= 0) return [];

  return [
    {
      class: 'PD5',
      title: 'More of what ships is being taken back out',
      magnitude: delta,
      unit: 'revert rate',
      confidence: sampleConfidence(recent.changes.length + prior.changes.length, 200),
      detail: `Revert rate rose from ${formatPercent(priorRate)} to ${formatPercent(recentRate)}.`,
      assumptions: [
        'only explicit reverts are visible; a fix-forward that undoes a change without saying so is not counted, so this understates',
        'production incidents are not linked — that needs an incident feed',
      ],
    },
  ];
}

function signOf(
  findings: readonly DisplacementFinding[],
  klass: DisplacementClass,
): number | undefined {
  return findings.find((finding) => finding.class === klass)?.magnitude;
}

function meanSurviving(changes: readonly DurableChange[]): number | undefined {
  const observed = changes.filter((change) => change.fullyObserved && change.linesAdded > 0);
  return mean(observed.map((change) => change.survivingFraction));
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate<T>(items: readonly T[], predicate: (item: T) => boolean): number | undefined {
  if (items.length === 0) return undefined;
  return items.filter(predicate).length / items.length;
}

/** Monotonic, bounded, and varies with the evidence — the same shape `waste/scoring.ts` uses. */
function sampleConfidence(n: number, halfPoint: number): number {
  if (n <= 0) return 0;
  return n / (n + halfPoint);
}
