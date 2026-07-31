import { creditsForChars, sampleConfidence, withEffectSize } from '../scoring.js';
import { scanDuplicateReads } from '../duplicate-reads.js';
import { formatCount, formatPercent } from '../format.js';
import type { DetectContext, Evidence, WasteDetector, WasteFinding } from '../types.js';

/**
 * **W2 · Duplicate retrieval** — the same file content fetched more than
 * once inside a single chat session (F8).
 *
 * Once a file has been read, its content is already in the conversation and
 * is re-transmitted on every subsequent step anyway. Reading it again does
 * not refresh anything the model lacks — it appends a second copy, which is
 * then also re-transmitted for the rest of the session.
 *
 * ## Why the line range matters
 *
 * A naive detector counts "same file read twice" and reports a huge number.
 * That would be wrong, and worse, it would penalise exactly the behaviour
 * worth encouraging: reading lines 1–50 and later lines 400–450 of a large
 * file is *disciplined* retrieval, not waste.
 *
 * So a re-read only counts when the requested range **overlaps** a range
 * already fetched in that session — and only when nothing has edited the
 * file since. See `waste/duplicate-reads.ts` for why that edit exemption is
 * load-bearing rather than a refinement: without it this detector
 * overstated itself roughly fivefold on real data.
 *
 * The cost attributed is the measured character length of the redundant
 * result — not an assumption about file size.
 */
export class DuplicateRetrievalDetector implements WasteDetector {
  readonly class = 'W2' as const;
  readonly name = 'Duplicate retrieval';

  detect(ctx: DetectContext): WasteFinding[] {
    const scan = scanDuplicateReads(ctx);
    if (scan.readCalls === 0 || scan.duplicates.length === 0) return [];

    const redundantChars = scan.duplicates.reduce((sum, entry) => sum + entry.chars, 0);
    const duplicateRate = scan.duplicates.length / scan.readCalls;

    const perFile = new Map<string, { session: string; repeats: number; chars: number }>();
    for (const entry of scan.duplicates) {
      const key = `${entry.sessionId}:${entry.fileHash}`;
      const bucket = perFile.get(key) ?? { session: entry.sessionId, repeats: 0, chars: 0 };
      bucket.repeats += 1;
      bucket.chars += entry.chars;
      perFile.set(key, bucket);
    }

    const worst = [...perFile.entries()]
      .sort((a, b) => b[1].chars - a[1].chars)
      .slice(0, MAX_LISTED_FILES);

    const evidence: Evidence[] = [
      {
        kind: 'file',
        ref: 'ALL',
        detail:
          `${formatCount(scan.duplicates.length)} of ${formatCount(scan.readCalls)} file reads ` +
          `re-fetched a range already retrieved in the same session (${formatPercent(duplicateRate)})`,
      },
      {
        kind: 'file',
        ref: 'REFRESHED',
        detail:
          `a further ${formatCount(scan.refreshedAfterEdit)} re-read(s) followed an edit to the same file ` +
          'and are excluded — the content had genuinely changed, so re-reading it was correct',
      },
      ...worst.map(([key, entry]): Evidence => {
        const fileHash = key.slice(entry.session.length + 1);
        return {
          kind: 'file',
          ref: fileHash,
          detail:
            `re-read ${String(entry.repeats)} time(s) in session ${entry.session.slice(0, 8)} ` +
            `— ${formatCount(entry.chars)} redundant characters`,
        };
      }),
    ];

    return [
      {
        class: this.class,
        title: `${formatPercent(duplicateRate)} of file reads fetched content already in context`,
        credits: creditsForChars(
          redundantChars,
          ctx,
          'measured result size of reads that overlapped a range already fetched in the same session, with no intervening edit',
          [
            'excludes re-reads that followed an edit to the same file — those refresh genuinely changed content and are not waste',
            'edit times are the timestamp of the request the edit belongs to, the finest resolution the journal records',
            'counts only the redundant copy, not the original read',
          ],
        ),
        confidence: withEffectSize(sampleConfidence(scan.readCalls, 50), duplicateRate / 0.3),
        evidence,
        remediation: {
          summary: 'The agent re-reads files it has already been given',
          tier: 'B',
          action:
            'Deny a read whose range was already returned in the same session, ' +
            'and return a pointer to the earlier result instead. The cache must invalidate on edit.',
        },
      },
    ];
  }
}

const MAX_LISTED_FILES = 10;
