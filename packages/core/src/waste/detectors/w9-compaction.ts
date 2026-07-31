import { creditsForTokens, sampleConfidence, withEffectSize } from '../scoring.js';
import { formatCount } from '../format.js';
import type { DetectContext, Evidence, WasteDetector, WasteFinding } from '../types.js';

/**
 * **W9 · Compaction overhead** (F9).
 *
 * When a conversation outgrows the model's context window, VS Code
 * automatically summarises it. That costs tokens — the entire context is
 * read in order to write the summary — and it costs the developer *time*,
 * because they sit and wait for it.
 *
 * Compaction is a **symptom**, not a cause. It fires because context was
 * allowed to grow unmanaged, which is the same root cause as W4. The two
 * are reported separately because they have different fixes, but a reader
 * should understand that eliminating one reduces the other.
 *
 * ## The figure that lands hardest is not the money
 *
 * The token cost is real but modest. The **waiting time** is the finding an
 * executive reacts to: this is measured wall-clock latency, recorded by VS
 * Code itself, during which an engineer is watching a progress indicator.
 * That number is `Measured` and is reported alongside the credits.
 */
export class CompactionOverheadDetector implements WasteDetector {
  readonly class = 'W9' as const;
  readonly name = 'Context compaction';

  detect(ctx: DetectContext): WasteFinding[] {
    const events = ctx.compactions;
    if (events.length === 0) return [];

    // Summarising requires reading the whole context that triggered it, so
    // `contextLengthBefore` is the best available proxy for the tokens the
    // compaction itself had to process.
    const tokensProcessed = events.reduce((sum, event) => sum + event.contextLengthBefore, 0);
    const totalWaitMs = events.reduce((sum, event) => sum + event.durationMs, 0);

    const durations = events.map((e) => e.durationMs).sort((a, b) => a - b);
    const medianWaitMs = durations[Math.floor(durations.length / 2)] ?? 0;
    const waitHours = totalWaitMs / 3_600_000;

    const worst = [...events]
      .sort((a, b) => b.contextLengthBefore - a.contextLengthBefore)
      .slice(0, MAX_LISTED);

    const failed = events.filter((event) => !event.outcome.toLowerCase().includes('success'));

    const evidence: Evidence[] = [
      {
        kind: 'request',
        ref: 'ALL',
        detail:
          `${String(events.length)} compaction event(s) — ${waitHours.toFixed(2)} hours of measured ` +
          `developer waiting, median ${(medianWaitMs / 1000).toFixed(0)}s each`,
      },
      ...worst.map((event): Evidence => ({
        kind: 'request',
        ref: event.requestId,
        detail:
          `context reached ${formatCount(event.contextLengthBefore)} tokens before summarising ` +
          `(${(event.durationMs / 1000).toFixed(0)}s, outcome: ${event.outcome})`,
      })),
      ...(failed.length > 0
        ? [
            {
              kind: 'request' as const,
              ref: 'FAILED',
              detail: `${String(failed.length)} compaction(s) did not complete successfully — that context was paid for and discarded`,
            },
          ]
        : []),
    ];

    return [
      {
        class: this.class,
        title: `Automatic summarisation cost ${waitHours.toFixed(1)} hours of waiting`,
        credits: creditsForTokens(
          tokensProcessed,
          ctx,
          'context length at the moment each compaction fired, summed across all events',
          [
            'uses context-length-before as a proxy for the tokens the summarisation itself processed',
            'compaction is a symptom of unmanaged context growth — this cost overlaps with W4 and the two must not simply be added',
            'excludes the developer waiting time, which is a real cost but not a credit cost',
          ],
        ),
        confidence: withEffectSize(
          sampleConfidence(events.length, 10),
          // Latency is directly measured, so the evidence here is unusually solid.
          0.9,
        ),
        evidence,
        remediation: {
          summary: `${String(events.length)} compaction(s), median wait ${(medianWaitMs / 1000).toFixed(0)} seconds`,
          tier: 'C',
          action:
            'Keep sessions short enough that automatic summarisation never fires. ' +
            'Compaction is the bill for context that was allowed to grow unmanaged.',
        },
      },
    ];
  }
}

const MAX_LISTED = 8;
