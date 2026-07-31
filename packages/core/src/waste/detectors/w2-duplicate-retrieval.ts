import { creditsForChars, groupBy, sampleConfidence, withEffectSize } from '../scoring.js';
import { formatCount, formatPercent } from '../format.js';
import type { DetectContext, Evidence, WasteDetector, WasteFinding } from '../types.js';
import type { ToolCallRow } from '../../store/database.js';

/** Tools whose results are file content and therefore re-readable. */
const READ_TOOLS = new Set(['read_file', 'get_errors']);

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
 * already fetched in that session. Whole-file reads (no range) are treated
 * as covering everything, which is what they do.
 *
 * The cost attributed is the measured character length of the redundant
 * result — not an assumption about file size.
 */
export class DuplicateRetrievalDetector implements WasteDetector {
  readonly class = 'W2' as const;
  readonly name = 'Duplicate retrieval';

  detect(ctx: DetectContext): WasteFinding[] {
    const readCalls = ctx.toolCalls.filter(
      (call) => READ_TOOLS.has(call.name) && call.targetFileHash !== null,
    );
    if (readCalls.length === 0) return [];

    const bySession = groupBy(readCalls, (call) => call.sessionId);

    let redundantCalls = 0;
    let redundantChars = 0;
    const perFile = new Map<string, { session: string; repeats: number; chars: number }>();

    for (const [sessionId, calls] of bySession) {
      // Ranges already fetched in this session, per file.
      const seen = new Map<string, { start: number; end: number }[]>();

      for (const call of calls) {
        const fileHash = call.targetFileHash;
        if (fileHash === null) continue;

        const range = rangeOf(call);
        const priorRanges = seen.get(fileHash) ?? [];
        const isRedundant = priorRanges.some((prior) => overlaps(prior, range));

        if (isRedundant) {
          redundantCalls += 1;
          redundantChars += call.resultChars ?? 0;

          const key = `${sessionId}:${fileHash}`;
          const entry = perFile.get(key) ?? { session: sessionId, repeats: 0, chars: 0 };
          entry.repeats += 1;
          entry.chars += call.resultChars ?? 0;
          perFile.set(key, entry);
        }

        priorRanges.push(range);
        seen.set(fileHash, priorRanges);
      }
    }

    if (redundantCalls === 0) return [];

    const duplicateRate = redundantCalls / readCalls.length;
    const worst = [...perFile.entries()]
      .sort((a, b) => b[1].chars - a[1].chars)
      .slice(0, MAX_LISTED_FILES);

    const evidence: Evidence[] = [
      {
        kind: 'file',
        ref: 'ALL',
        detail:
          `${formatCount(redundantCalls)} of ${formatCount(readCalls.length)} file reads ` +
          `re-fetched a range already retrieved in the same session (${formatPercent(duplicateRate)})`,
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
          'measured result size of reads that overlapped a range already fetched in the same session',
          [
            'assumes the re-fetched content added no information, which holds unless the file changed mid-session',
            'counts only the redundant copy, not the original read',
          ],
        ),
        confidence: withEffectSize(sampleConfidence(readCalls.length, 50), duplicateRate / 0.3),
        evidence,
        remediation: {
          summary: 'The agent re-reads files it has already been given',
          tier: 'B',
          action:
            'Deny a read whose range was already returned in the same session, ' +
            'and return a pointer to the earlier result instead.',
        },
      },
    ];
  }
}

interface Range {
  readonly start: number;
  readonly end: number;
}

/** A read with no explicit range covers the whole file. */
function rangeOf(call: ToolCallRow): Range {
  return {
    start: call.targetStartLine ?? 0,
    end: call.targetEndLine ?? Number.MAX_SAFE_INTEGER,
  };
}

function overlaps(a: Range, b: Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}

const MAX_LISTED_FILES = 10;
