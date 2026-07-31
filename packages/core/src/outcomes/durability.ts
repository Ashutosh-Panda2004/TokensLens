import { kaplanMeier, type SurvivalCurve, type SurvivalObservation } from './survival.js';
import type { CommitRecord } from './git.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A unit of landed work, and how much of it was still there later.
 *
 * ## Why the unit is a commit and not a pull request
 *
 * It would be tidier to make the unit a PR. It is not reliably available:
 * a squash-merge repository has no merge commits at all, a rebase workflow
 * has neither, and only some forges put the number in the subject. Making
 * the unit depend on the branching convention would mean the metric meant
 * something different in each repository, which is worse than a slightly
 * coarser unit that means the same thing everywhere.
 *
 * So the unit is the commit that introduced the lines, and PR numbers are
 * recorded where they can be recovered so that changes can be rolled up
 * afterwards by anyone whose repository supports it.
 */
export interface DurableChange {
  readonly changeId: string;
  readonly authorId: string;
  readonly ts: number;
  readonly linesAdded: number;
  readonly linesDeleted: number;
  readonly filesTouched: number;
  readonly pullRequest?: number;
  /**
   * Added lines that had been deleted again by the end of the horizon,
   * attributed by the cohort walk below.
   */
  readonly linesChurned: number;
  /** Added lines still present at the horizon, or at the end of observation. */
  readonly linesSurviving: number;
  /** `linesSurviving / linesAdded`. 1 when the change added nothing. */
  readonly survivingFraction: number;
  /** Was this change reverted outright? */
  readonly reverted: boolean;
  /** Has it been observed for the full horizon yet? */
  readonly fullyObserved: boolean;
  /**
   * Not reverted, fully observed, and enough of it survived. `undefined`
   * when the horizon has not elapsed — a change merged yesterday is
   * **unknown**, not durable, and calling it durable is how a report makes
   * the most recent work look perfect every time it runs.
   */
  readonly durable: boolean | undefined;
}

export interface DurabilityOptions {
  /** Days a change must survive to count. */
  readonly horizonDays?: number;
  /** Share of added lines that must survive. */
  readonly survivalThreshold?: number;
  /** End of observation. Injectable so a report is not a function of the clock. */
  readonly now?: number;
}

export interface DurabilityReport {
  readonly changes: readonly DurableChange[];
  readonly horizonDays: number;
  readonly survivalThreshold: number;
  /** Line-level survival curve, in days. */
  readonly curve: SurvivalCurve;
  /** Deletions that landed on code older than the horizon and were therefore not attributed. */
  readonly backgroundDeletions: number;
  readonly attributedDeletions: number;
}

interface Cohort {
  readonly changeId: string;
  readonly ts: number;
  remaining: number;
}

const DEFAULT_HORIZON_DAYS = 30;
const DEFAULT_SURVIVAL_THRESHOLD = 0.5;

/**
 * Attributes deletions back to the changes that added the lines, and from
 * that derives per-change survival.
 *
 * ## The attribution rule, and its bias
 *
 * Knowing which change wrote a deleted line exactly would need a blame walk
 * at every revision, which is quadratic and unaffordable on a real
 * repository. Instead, each file carries a stack of line cohorts and a
 * deletion consumes the **most recent** cohorts first.
 *
 * That is a real assumption and it has a direction: last-in-first-out
 * matches the "wrote it, then rewrote it" pattern this metric exists to
 * detect, and therefore **overstates** churn against new code if deletions
 * were in fact spread evenly. Two things bound the error. Deletions are
 * only attributed to cohorts **younger than the horizon** — anything older
 * is counted as background and excluded — and the ratio of attributed to
 * background deletions is reported, so a reader can see how much of the
 * repository's deletion activity the assumption is actually carrying.
 */
export function measureDurability(
  commits: readonly CommitRecord[],
  options: DurabilityOptions = {},
): DurabilityReport {
  const horizonDays = options.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const survivalThreshold = options.survivalThreshold ?? DEFAULT_SURVIVAL_THRESHOLD;
  const horizonMs = horizonDays * DAY_MS;
  const now = options.now ?? Date.now();

  const ordered = [...commits].sort((a, b) => a.ts - b.ts || a.sha.localeCompare(b.sha));
  const reverted = new Set(
    ordered.map((commit) => commit.revertsSha).filter((sha): sha is string => sha !== undefined),
  );

  const cohortsByFile = new Map<string, Cohort[]>();
  const churnedByChange = new Map<string, number>();
  const observations: SurvivalObservation[] = [];

  let attributedDeletions = 0;
  let backgroundDeletions = 0;

  for (const commit of ordered) {
    if (commit.isMerge) continue; // A merge is a boundary, not a change.

    for (const file of commit.files) {
      const cohorts = cohortsByFile.get(file.pathHash) ?? [];

      let toDelete = file.deleted;
      // Newest first. Only cohorts still inside the horizon are eligible:
      // a deletion in code older than that is maintenance, not churn.
      for (let i = cohorts.length - 1; i >= 0 && toDelete > 0; i -= 1) {
        const cohort = cohorts[i];
        if (!cohort || cohort.remaining <= 0) continue;
        if (commit.ts - cohort.ts > horizonMs) break;

        const consumed = Math.min(cohort.remaining, toDelete);
        cohort.remaining -= consumed;
        toDelete -= consumed;
        attributedDeletions += consumed;

        churnedByChange.set(
          cohort.changeId,
          (churnedByChange.get(cohort.changeId) ?? 0) + consumed,
        );
        observations.push({
          duration: (commit.ts - cohort.ts) / DAY_MS,
          event: true,
          weight: consumed,
        });
      }
      backgroundDeletions += toDelete;

      if (file.added > 0) {
        cohorts.push({ changeId: commit.sha, ts: commit.ts, remaining: file.added });
      }
      cohortsByFile.set(file.pathHash, cohorts);
    }
  }

  // Everything left alive is censored at however long it has been observed,
  // capped at the horizon — beyond it the question stops being asked.
  for (const cohorts of cohortsByFile.values()) {
    for (const cohort of cohorts) {
      if (cohort.remaining <= 0) continue;
      observations.push({
        duration: Math.min((now - cohort.ts) / DAY_MS, horizonDays),
        event: false,
        weight: cohort.remaining,
      });
    }
  }

  const changes = ordered
    .filter((commit) => !commit.isMerge)
    .map((commit): DurableChange => {
      const linesAdded = commit.files.reduce((sum, file) => sum + file.added, 0);
      const linesDeleted = commit.files.reduce((sum, file) => sum + file.deleted, 0);
      const linesChurned = Math.min(churnedByChange.get(commit.sha) ?? 0, linesAdded);
      const linesSurviving = linesAdded - linesChurned;
      const survivingFraction = linesAdded > 0 ? linesSurviving / linesAdded : 1;
      const fullyObserved = now - commit.ts >= horizonMs;
      const isReverted = reverted.has(commit.sha);

      return {
        changeId: commit.sha,
        authorId: commit.authorId,
        ts: commit.ts,
        linesAdded,
        linesDeleted,
        filesTouched: commit.files.length,
        ...(commit.pullRequest !== undefined ? { pullRequest: commit.pullRequest } : {}),
        linesChurned,
        linesSurviving,
        survivingFraction,
        reverted: isReverted,
        fullyObserved,
        durable: fullyObserved ? !isReverted && survivingFraction >= survivalThreshold : undefined,
      };
    });

  return {
    changes,
    horizonDays,
    survivalThreshold,
    curve: kaplanMeier(observations),
    attributedDeletions,
    backgroundDeletions,
  };
}

/**
 * Counts of durable, non-durable and not-yet-known changes.
 *
 * The third category is the point. A ratio of durable to total silently
 * treats "too recent to tell" as a failure; excluding it without saying so
 * treats the remainder as if it were the whole. Both are reported.
 */
export interface DurabilitySummary {
  readonly durable: number;
  readonly notDurable: number;
  readonly unknown: number;
  readonly durableRate: number | undefined;
  readonly durableLineEquivalents: number;
}

export function summariseDurability(changes: readonly DurableChange[]): DurabilitySummary {
  let durable = 0;
  let notDurable = 0;
  let unknown = 0;
  let durableLineEquivalents = 0;

  for (const change of changes) {
    if (change.durable === undefined) unknown += 1;
    else if (change.durable) durable += 1;
    else notDurable += 1;

    if (change.fullyObserved) durableLineEquivalents += change.linesSurviving;
  }

  const decided = durable + notDurable;
  return {
    durable,
    notDurable,
    unknown,
    durableRate: decided > 0 ? durable / decided : undefined,
    durableLineEquivalents,
  };
}
