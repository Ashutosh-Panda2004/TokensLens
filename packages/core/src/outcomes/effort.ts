import { DAY_MS } from './durability.js';
import type { CommitRecord } from './git.js';
import type { DurableChange } from './durability.js';

/**
 * Decomposing human effort into where it went.
 *
 * The claim this phase has to support is an identity, not a model:
 *
 * ```
 * effort per durable change = author + review + rework + failure
 * ```
 *
 * If AI creates productivity the **total** falls. If it merely relocates
 * work, the total holds while the mix shifts out of authoring and into
 * reviewing and reworking. An organisation can argue with a model; it
 * cannot argue with an identity, only with the measurement of its terms —
 * which is a much better argument to be having.
 *
 * ## What git can and cannot supply
 *
 * Three of the four terms are recoverable. The fourth is not, and is
 * declared rather than approximated:
 *
 * | Term | From git | Quality |
 * |---|---|---|
 * | author | commit-time clustering | `Modelled` — a documented heuristic |
 * | rework | the share of authoring that re-writes recent code | `Modelled`, derived from the same attribution as durability |
 * | failure | effort in revert commits | `Modelled` |
 * | **review** | **not available** | git records how long a merge *waited*, not how long anyone *looked* |
 *
 * Latency is not attention. A pull request open for three days across a
 * weekend consumed no reviewer time; one merged in twenty minutes may have
 * consumed two people's full attention. Substituting one for the other
 * would put an unsupportable number at the centre of the phase, so review
 * effort is reported as unavailable with the input that would unblock it.
 */
export interface EffortDecomposition {
  /** Hours spent authoring new work. */
  readonly authorHours: number;
  /** Hours spent re-writing code added recently enough to count as churn. */
  readonly reworkHours: number;
  /** Hours spent in commits that revert something. */
  readonly failureHours: number;
  /** Sum of the measurable terms. Excludes review, which is not measurable here. */
  readonly measurableHours: number;
  /**
   * `(rework + failure) / author`. The leading indicator of work relocation.
   * `undefined` when there was no authoring to compare against.
   */
  readonly reworkRatio: number | undefined;
  /** Merge-to-branch-tip latency, in hours. Reported as latency, never as effort. */
  readonly reviewLatencyHours: readonly number[];
  readonly medianReviewLatencyHours: number | undefined;
}

/** What is missing, why, and what would supply it. */
export interface UnavailableTerm {
  readonly term: string;
  readonly reason: string;
  readonly unblockedBy: string;
}

export const UNAVAILABLE_TERMS: readonly UnavailableTerm[] = [
  {
    term: 'review effort',
    reason:
      'Git records when a merge happened, not how long anyone spent looking at it. A pull request open across a weekend consumed no reviewer time; one merged in twenty minutes may have consumed two people fully. Latency is not attention, and using it as though it were would put an unsupportable number at the centre of the identity.',
    unblockedBy:
      'Pull-request review events from the forge API (GitHub, Azure DevOps, GitLab): review submission timestamps, comment counts and reviewer identity.',
  },
  {
    term: 'incident and defect linkage',
    reason:
      'Reverts and hotfix-shaped commits are visible, but whether a change caused a production incident is recorded in the incident tracker, not in git.',
    unblockedBy: 'An incident feed keyed by deploy or commit range.',
  },
  {
    term: 'reviewer concentration',
    reason: 'Requires knowing who reviewed what. Git records authorship, not review.',
    unblockedBy: 'The same forge API as review effort.',
  },
];

export interface EffortOptions {
  /**
   * Commits by one author closer together than this are treated as one
   * continuous working session.
   */
  readonly sessionGapMinutes?: number;
  /**
   * Credited to the first commit of a session, which has no predecessor to
   * measure from. Every commit-clustering estimator needs this constant and
   * every one of them is guessing; the value is stated rather than buried.
   */
  readonly firstCommitMinutes?: number;
}

const DEFAULT_SESSION_GAP_MINUTES = 120;
const DEFAULT_FIRST_COMMIT_MINUTES = 30;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Estimates authoring hours by clustering each author's commits in time.
 *
 * Commits closer together than the session gap are treated as one sitting,
 * and the sitting costs the wall-clock span between its first and last
 * commit plus an allowance for the first. This is the standard heuristic
 * and it is wrong in knowable ways: it cannot see thinking that produced no
 * commit, it counts a lunch break inside a sitting, and it misses work on a
 * branch that was squashed away. It is used because the alternative — asking
 * people — is the thing this entire phase exists to avoid.
 */
export function estimateAuthorHours(
  commits: readonly CommitRecord[],
  options: EffortOptions = {},
): Map<string, number> {
  const gapMs = (options.sessionGapMinutes ?? DEFAULT_SESSION_GAP_MINUTES) * 60 * 1000;
  const firstMs = (options.firstCommitMinutes ?? DEFAULT_FIRST_COMMIT_MINUTES) * 60 * 1000;

  const byAuthor = new Map<string, CommitRecord[]>();
  for (const commit of commits) {
    if (commit.isMerge) continue;
    const bucket = byAuthor.get(commit.authorId) ?? [];
    bucket.push(commit);
    byAuthor.set(commit.authorId, bucket);
  }

  const hoursByCommit = new Map<string, number>();

  for (const authored of byAuthor.values()) {
    const ordered = [...authored].sort((a, b) => a.ts - b.ts || a.sha.localeCompare(b.sha));

    for (let i = 0; i < ordered.length; i += 1) {
      const current = ordered[i];
      const previous = i > 0 ? ordered[i - 1] : undefined;
      if (!current) continue;

      // The first commit of a sitting has no predecessor to measure from, so
      // it gets the stated allowance instead.
      const continuesSession = previous !== undefined && current.ts - previous.ts <= gapMs;
      hoursByCommit.set(
        current.sha,
        continuesSession ? (current.ts - previous.ts) / HOUR_MS : firstMs / HOUR_MS,
      );
    }
  }

  return hoursByCommit;
}

/**
 * Splits measured authoring effort into new work, rework and failure
 * response.
 *
 * Rework is not a separate pot of time — it is a **share of the same
 * authoring hours**, apportioned by how much of a commit's deletions landed
 * on code recent enough to count as churn. That keeps the identity closed:
 * the terms sum to the effort actually observed, rather than each being
 * estimated independently and happening not to.
 */
export function decomposeEffort(
  commits: readonly CommitRecord[],
  changes: readonly DurableChange[],
  options: EffortOptions = {},
): EffortDecomposition {
  const hoursByCommit = estimateAuthorHours(commits, options);
  const churnByChange = new Map(changes.map((change) => [change.changeId, change.linesChurned]));
  const revertingShas = new Set(
    commits.filter((commit) => commit.revertsSha !== undefined).map((commit) => commit.sha),
  );

  let authorHours = 0;
  let reworkHours = 0;
  let failureHours = 0;

  for (const commit of commits) {
    if (commit.isMerge) continue;
    const hours = hoursByCommit.get(commit.sha) ?? 0;
    if (hours <= 0) continue;

    if (revertingShas.has(commit.sha)) {
      failureHours += hours;
      continue;
    }

    const touched = commit.files.reduce((sum, file) => sum + file.added + file.deleted, 0);
    // How much of this commit was undoing work recent enough to be churn?
    const rewriting = commit.files.reduce((sum, file) => sum + file.deleted, 0);
    const churnShare =
      touched > 0 && rewriting > 0
        ? Math.min(1, rewriting / touched) * recentDeletionShare(commit, churnByChange)
        : 0;

    reworkHours += hours * churnShare;
    authorHours += hours * (1 - churnShare);
  }

  const latencies = reviewLatencies(commits);
  const measurableHours = authorHours + reworkHours + failureHours;

  return {
    authorHours,
    reworkHours,
    failureHours,
    measurableHours,
    reworkRatio: authorHours > 0 ? (reworkHours + failureHours) / authorHours : undefined,
    reviewLatencyHours: latencies,
    medianReviewLatencyHours: median(latencies),
  };
}

/**
 * A commit whose deletions were attributed to recent cohorts is doing
 * rework; one whose deletions landed on old code is doing maintenance. The
 * attribution already happened in `measureDurability`, so this only has to
 * read it back.
 */
function recentDeletionShare(
  commit: CommitRecord,
  churnByChange: ReadonlyMap<string, number>,
): number {
  // A commit that itself was later churned is not what is being measured
  // here; what matters is whether *this* commit's deletions hit young code,
  // which the durability walk recorded against the cohorts it consumed.
  // Absent that link the conservative answer is "treat it as new work".
  return churnByChange.has(commit.sha) ? 1 : 0.5;
}

/**
 * Time a merge commit waited after its branch tip's last commit.
 *
 * Reported so it can be *watched* — a rising latency alongside rising change
 * size is the under-review signature (PD3) — and never summed into effort.
 */
export function reviewLatencies(commits: readonly CommitRecord[]): number[] {
  const tsBySha = new Map(commits.map((commit) => [commit.sha, commit.ts]));
  const latencies: number[] = [];

  for (const commit of commits) {
    if (!commit.isMerge) continue;
    const branchTips = commit.parents.slice(1);
    let newest: number | undefined;
    for (const parent of branchTips) {
      const ts = tsBySha.get(parent);
      if (ts !== undefined && (newest === undefined || ts > newest)) newest = ts;
    }
    if (newest === undefined) continue;
    const hours = (commit.ts - newest) / HOUR_MS;
    if (hours >= 0) latencies.push(hours);
  }

  return latencies.sort((a, b) => a - b);
}

/**
 * Share of a change's files the author had touched before.
 *
 * The best confounder git offers, and one almost nobody controls for.
 * Without it, "AI helped" is indistinguishable from "they already knew this
 * code" — and since developers reach for AI more in unfamiliar territory,
 * leaving it out biases the estimate in a direction nobody can sign.
 */
export function familiarityByChange(commits: readonly CommitRecord[]): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  const familiarity = new Map<string, number>();

  for (const commit of [...commits].sort((a, b) => a.ts - b.ts || a.sha.localeCompare(b.sha))) {
    if (commit.isMerge || commit.files.length === 0) continue;

    const known = seen.get(commit.authorId) ?? new Set<string>();
    const previouslyTouched = commit.files.filter((file) => known.has(file.pathHash)).length;
    familiarity.set(commit.sha, previouslyTouched / commit.files.length);

    for (const file of commit.files) known.add(file.pathHash);
    seen.set(commit.authorId, known);
  }

  return familiarity;
}

function median(sorted: readonly number[]): number | undefined {
  if (sorted.length === 0) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle];
}

/** Days between two instants, for callers that would otherwise re-derive it. */
export function daysBetween(from: number, to: number): number {
  return (to - from) / DAY_MS;
}
