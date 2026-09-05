import { sampleConfidence, withEffectSize } from '../scoring.js';
import { formatCount, formatCredits, formatPercent } from '../format.js';
import { SETTLING_WINDOW_MS, survivedAfter } from '../git-survival.js';
import { modelled } from '../../model/provenance.js';
import type { DetectContext, Evidence, WasteDetector, WasteFinding } from '../types.js';

/**
 * **W7 · Abandoned work** (R11) — credits spent on edits that never reached a
 * commit.
 *
 * The most expensive request is not the one that cost the most credits. It is
 * the one that cost credits and produced nothing anybody kept. W6 catches the
 * loop that never wrote a file; this catches the turn that wrote one and had it
 * thrown away.
 *
 * ## Why this was undetectable until now, and why it is not any more
 *
 * D3 recorded the blocker as *"requires knowing whether an edit survived to the
 * current git HEAD — the journal records that VS Code applied an edit locally,
 * not whether it was kept"*. That was true then. What changed is that D10 built
 * a git reader for its own purposes and hashed paths with the **same
 * per-install salt** the ingest pipeline uses, so `EditRecord.fileHash` and
 * `FileChange.pathHash` are already the same value for the same file. The join
 * needed nothing new; it needed noticing.
 *
 * ## Three ways this could overstate, and what stops each
 *
 * 1. **Work in progress read as abandonment.** An edit made ten minutes ago has
 *    not failed, it is simply not finished. Nothing within
 *    {@link SETTLING_WINDOW_MS} of the end of the observed period is judged at
 *    all, and the count of edits held back is reported rather than hidden.
 * 2. **Files git never tracks.** Scratch files, generated output and anything
 *    ignored will never appear in a commit, and charging them would turn a
 *    `.gitignore` entry into a waste finding. Only files with **at least one
 *    commit somewhere in the history** are judged; a file git has never heard
 *    of is excluded, and the exclusion is counted.
 * 3. **A shallow or filtered history.** If the caller read only the last
 *    fortnight, everything older looks uncommitted. Coverage — the share of
 *    edited files the history knows about at all — is computed and the detector
 *    abstains below {@link MIN_COVERAGE}.
 *
 * The remaining error runs the other way: a commit touching a file after an
 * edit is treated as that edit surviving, when the developer may have rewritten
 * it by hand first. That over-credits survival, so this **understates**
 * abandonment. Of the two directions, it is the right one to be wrong in.
 */

/**
 * Whether this corpus can be judged at all, and if not, why not.
 *
 * Exported because the detector is not the only caller: `registry.ts` uses it to
 * report W7 as *conditionally unavailable* with the real numbers attached. That
 * matters more than it looks. On the corpus this was first run against the join
 * worked perfectly — 189 of 191 committed files matched an edit — and the
 * detector still abstained, because the agent had also edited 1,170 files in
 * directories this repository does not contain. Returning nothing for that is
 * correct, and silent, and silent is the half that is wrong: a reader cannot
 * tell it from "no abandoned work here", which is the opposite conclusion.
 */
export interface SurvivalCoverage {
  readonly judgedRequests: number;
  readonly judgedFiles: number;
  readonly untrackedFiles: number;
  readonly tooRecent: number;
  /** Share of edited files this repository knows about at all. */
  readonly coverage: number;
  readonly sufficient: boolean;
  /** Empty when `sufficient`. Otherwise plain language, with the numbers in it. */
  readonly reason: string;
}

interface JudgedEdits {
  readonly perRequest: ReadonlyMap<string, { survived: boolean; files: number }>;
  readonly coverage: SurvivalCoverage;
}

function judgeEdits(ctx: DetectContext): JudgedEdits | undefined {
  const survival = ctx.git;
  if (survival === undefined || survival.commitCount === 0) return undefined;

  const requestById = new Map(ctx.requests.map((request) => [request.requestId, request]));
  const observedUntil = Math.max(
    survival.latestCommitTs,
    ...ctx.requests.map((request) => request.ts),
    0,
  );
  const judgeBefore = observedUntil - SETTLING_WINDOW_MS;

  /** Requests whose every edit was judged, and whether any of them survived. */
  const perRequest = new Map<string, { survived: boolean; files: number }>();
  let tooRecent = 0;
  let untrackedFiles = 0;

  for (const edit of ctx.edits) {
    const request = requestById.get(edit.requestId);
    if (request === undefined) continue;

    if (request.ts > judgeBefore) {
      tooRecent += 1;
      continue;
    }
    // A file git has never seen is not abandoned work — it is a file git was
    // told to ignore, a scratch buffer, or work in a directory this repository
    // does not contain. Judging it would make .gitignore look like waste.
    if (!survival.commitsByFile.has(edit.fileHash)) {
      untrackedFiles += 1;
      continue;
    }

    const bucket = perRequest.get(edit.requestId) ?? { survived: false, files: 0 };
    bucket.files += 1;
    if (survivedAfter(survival, edit.fileHash, request.ts)) bucket.survived = true;
    perRequest.set(edit.requestId, bucket);
  }

  const judgedFiles = [...perRequest.values()].reduce((sum, entry) => sum + entry.files, 0);
  const coverage = judgedFiles / Math.max(1, judgedFiles + untrackedFiles);

  let reason = '';
  if (perRequest.size < MIN_JUDGED_REQUESTS) {
    reason =
      `only ${formatCount(perRequest.size)} request(s) edited a file this repository tracks, ` +
      `below the ${String(MIN_JUDGED_REQUESTS)} needed before an abandonment rate means anything`;
  } else if (coverage < MIN_COVERAGE) {
    reason =
      `this repository accounts for only ${formatPercent(coverage)} of the files edited ` +
      `(${formatCount(judgedFiles)} tracked against ${formatCount(untrackedFiles)} it has never ` +
      'committed). Judging the tracked minority would report a rate drawn from a selected ' +
      'sample as though it described all of the work';
  }

  return {
    perRequest,
    coverage: {
      judgedRequests: perRequest.size,
      judgedFiles,
      untrackedFiles,
      tooRecent,
      coverage,
      sufficient: reason === '',
      reason,
    },
  };
}

/** The coverage assessment alone, for callers that need to explain an absence. */
export function assessSurvivalCoverage(ctx: DetectContext): SurvivalCoverage | undefined {
  return judgeEdits(ctx)?.coverage;
}

export class AbandonedWorkDetector implements WasteDetector {
  readonly class = 'W7' as const;
  readonly name = 'Abandoned work';

  detect(ctx: DetectContext): WasteFinding[] {
    const judged = judgeEdits(ctx);
    if (judged?.coverage.sufficient !== true) return [];

    const { perRequest } = judged;
    const { untrackedFiles: untracked, tooRecent, coverage } = judged.coverage;

    const abandoned = [...perRequest.entries()].filter(([, entry]) => !entry.survived);
    if (abandoned.length === 0) return [];

    const abandonedCredits = abandoned.reduce(
      (sum, [requestId]) => sum + (ctx.creditsByRequest.get(requestId) ?? 0),
      0,
    );
    const abandonRate = abandoned.length / perRequest.size;

    const worst = [...abandoned]
      .sort((a, b) => (ctx.creditsByRequest.get(b[0]) ?? 0) - (ctx.creditsByRequest.get(a[0]) ?? 0))
      .slice(0, MAX_LISTED);

    const evidence: Evidence[] = [
      {
        kind: 'request',
        ref: 'ALL',
        detail:
          `${formatCount(abandoned.length)} of ${formatCount(perRequest.size)} edit-producing requests ` +
          `(${formatPercent(abandonRate)}) touched no file that was later committed`,
        credits: abandonedCredits,
      },
      {
        kind: 'file',
        ref: 'UNTRACKED',
        detail:
          `${formatCount(untracked)} edit(s) targeted files git has never committed and are excluded ` +
          `\u2014 history coverage of edited files is ${formatPercent(coverage)}`,
      },
      {
        kind: 'request',
        ref: 'SETTLING',
        detail:
          `${formatCount(tooRecent)} edit(s) fall inside the ${String(SETTLING_WINDOW_MS / 3_600_000)}-hour ` +
          'settling window and are not judged \u2014 recent work is unfinished, not abandoned',
      },
      ...worst.map(([requestId, entry]): Evidence => ({
        kind: 'request',
        ref: requestId,
        detail: `edited ${formatCount(entry.files)} tracked file(s), none of which were committed afterwards`,
        credits: ctx.creditsByRequest.get(requestId) ?? 0,
      })),
    ];

    return [
      {
        class: this.class,
        title: `${formatPercent(abandonRate)} of edit-producing requests left nothing committed`,
        credits: modelled(
          abandonedCredits,
          'measured credits of requests whose every tracked edit was followed by no commit to that file',
          [
            'treats any commit touching the file after the edit as that edit surviving \u2014 the developer may have rewritten it first, so this over-credits survival and therefore understates abandonment',
            `excludes edits within ${String(SETTLING_WINDOW_MS / 3_600_000)} hours of the end of the observed period, which are work in progress rather than abandoned work`,
            'judges only files this repository has committed at least once, which is a selected sample \u2014 a file git has never seen may have been abandoned too, and cannot be told apart from one that was never meant to be committed',
            'charges the whole request, because a turn whose output was discarded produced nothing of the value the rest of its cost bought',
          ],
        ),
        confidence: withEffectSize(
          sampleConfidence(perRequest.size, 40),
          // A near-total abandonment rate is a stronger signal; 50% saturates.
          abandonRate / 0.5,
        ),
        evidence,
        remediation: {
          summary: `${formatCredits(abandonedCredits)} credits went into edits nobody kept`,
          tier: 'C',
          action:
            'Shorten the loop before the spend, not after: ask for a plan or a diff on the ' +
            'expensive turns, and commit or discard deliberately. This is a feedback-loop habit, ' +
            'not a setting \u2014 no configuration can tell in advance which work will be thrown away.',
        },
      },
    ];
  }
}

/** Below this many judged requests the rate is noise, whatever it reads. */
const MIN_JUDGED_REQUESTS = 20;
/** Below this share of edited files known to git, the history is too partial to judge. */
const MIN_COVERAGE = 0.5;
const MAX_LISTED = 10;
