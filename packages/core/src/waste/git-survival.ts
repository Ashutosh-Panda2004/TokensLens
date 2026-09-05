import type { CommitRecord } from '../outcomes/git.js';

/**
 * D12.1 / D12.8 — turning a commit history into the one question W7 needs to
 * ask: *did this file get committed after the agent edited it?*
 *
 * ## Why this is a separate, pure module
 *
 * `DetectContext` exists so that a detector "physically cannot reach the
 * network or the filesystem". Git is a filesystem read and a subprocess, so it
 * cannot happen inside a detector. The caller reads the history — the same
 * `readGitHistory` D10 already ships — and hands the result here, which reduces
 * it to an index. The detector then sees data, never a repository.
 *
 * ## The join, and why it works at all
 *
 * D10 hashes git paths with `hashPath` and the **same per-install salt** the
 * ingest pipeline uses for tool-call targets. That was done for D10's own
 * reasons, and it is what makes W7 possible today: `EditRecord.fileHash` and
 * `FileChange.pathHash` are the same value for the same file, and neither side
 * ever holds the path. The blocker recorded in D3 — *"requires a data source
 * outside the journal"* — was cleared by a phase that was not trying to clear
 * it.
 *
 * ## What this index deliberately does not claim
 *
 * That a commit touching a file proves *a particular edit* survived. It does
 * not: the agent may have written something the developer then rewrote by hand
 * before committing. The index answers the weaker, checkable question, and the
 * detector states the difference in its assumptions rather than quietly
 * treating the two as one. Being wrong in the safe direction matters here —
 * this over-credits survival, so it **understates** abandonment.
 */

export interface GitSurvival {
  /**
   * Commit timestamps per salted file hash, ascending. Only files that were
   * ever committed appear.
   */
  readonly commitsByFile: ReadonlyMap<string, readonly number[]>;
  /** Latest commit instant observed, in epoch milliseconds. */
  readonly latestCommitTs: number;
  readonly commitCount: number;
  /** Distinct files the history touched. Used to report join coverage. */
  readonly filesTouched: number;
}

/**
 * How long an edit is given to reach a commit before it is judged.
 *
 * Two hours. An edit made ten minutes ago is work in progress; calling it
 * abandoned would report the developer's current task as waste, which is both
 * wrong and the fastest way to have the whole report dismissed. Two hours is a
 * parameter rather than a truth — it is passed through to the finding's
 * assumptions and `w7.survival.test.ts` pins the behaviour at its boundary.
 */
export const SETTLING_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Reduces a commit history to the per-file timeline W7 joins against. */
export function buildGitSurvival(commits: readonly CommitRecord[]): GitSurvival {
  const commitsByFile = new Map<string, number[]>();
  let latestCommitTs = 0;

  for (const commit of commits) {
    // Merges carry no diff of their own — `readGitHistory` reads them without
    // `-m` precisely so the work is attributed to the commits they bring in.
    // Counting them here would credit survival twice.
    if (commit.isMerge) continue;
    latestCommitTs = Math.max(latestCommitTs, commit.ts);

    for (const file of commit.files) {
      const bucket = commitsByFile.get(file.pathHash);
      if (bucket) bucket.push(commit.ts);
      else commitsByFile.set(file.pathHash, [commit.ts]);
    }
  }

  for (const bucket of commitsByFile.values()) bucket.sort((a, b) => a - b);

  return {
    commitsByFile,
    latestCommitTs,
    commitCount: commits.filter((commit) => !commit.isMerge).length,
    filesTouched: commitsByFile.size,
  };
}

/**
 * Whether `fileHash` was committed at or after `ts`.
 *
 * A commit *before* the edit is not survival — it is the file's earlier life.
 * This is the whole of the judgement, and it is deliberately this small.
 */
export function survivedAfter(survival: GitSurvival, fileHash: string, ts: number): boolean {
  const commits = survival.commitsByFile.get(fileHash);
  if (commits === undefined) return false;
  // Ascending, so the last entry is the most recent commit that touched it.
  const latest = commits[commits.length - 1] ?? -Infinity;
  return latest >= ts;
}
