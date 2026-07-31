import { creditsForChars, groupBy, sampleConfidence, withEffectSize } from '../scoring.js';
import { formatCount } from '../format.js';
import { estimateTokensFromChars } from '../../ingest/tool-results.js';
import type { DetectContext, Evidence, WasteDetector, WasteFinding } from '../types.js';

/**
 * **W3 · Oversized tool payloads** (F10).
 *
 * A single tool call can return an enormous result — a whole diff, an
 * unfiltered directory listing, a verbose build log. The damage is not the
 * one-off cost: the result then sits in the conversation and is
 * re-transmitted on **every subsequent step of that turn**, so an oversized
 * payload is billed many times over.
 *
 * ## What counts as oversized
 *
 * Not an arbitrary constant, and deliberately **not a high percentile**.
 *
 * A 99th percentile computed over a few dozen calls sits *on top of the
 * outliers themselves*: with 60 calls of which 3 are enormous, p99 lands on
 * the enormous ones and nothing exceeds it. The detector would go blind in
 * exactly the case it exists to catch.
 *
 * So the threshold is a **multiple of that tool's own median** result size,
 * floored at an absolute cap. The median is robust — a handful of extreme
 * values cannot drag it — which is the property this needs.
 *
 * Judging each tool against its own distribution still matters: 8,000
 * characters is routine for a web fetch and pathological for a string
 * replacement, and one global threshold would either miss the latter or
 * drown in the former.
 *
 * The excess above the threshold — not the whole payload — is what gets
 * costed, because a result of the typical size for that tool was work that
 * genuinely needed doing.
 */
export class OversizedPayloadDetector implements WasteDetector {
  readonly class = 'W3' as const;
  readonly name = 'Oversized tool results';

  detect(ctx: DetectContext): WasteFinding[] {
    const measured = ctx.toolCalls.filter((call) => call.resultChars !== null);
    if (measured.length < MIN_SAMPLE) return [];

    const byTool = groupBy(measured, (call) => call.name);
    const offenders: { name: string; requestId: string; chars: number; threshold: number }[] = [];

    for (const [name, calls] of byTool) {
      if (calls.length < MIN_CALLS_PER_TOOL) continue;

      const sizes = calls.map((c) => c.resultChars ?? 0).sort((a, b) => a - b);
      const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
      const threshold = Math.max(ABSOLUTE_CAP_CHARS, median * OUTLIER_MULTIPLE);

      for (const call of calls) {
        const chars = call.resultChars ?? 0;
        if (chars > threshold) {
          offenders.push({ name, requestId: call.requestId, chars, threshold });
        }
      }
    }

    if (offenders.length === 0) return [];

    const excessChars = offenders.reduce((sum, o) => sum + (o.chars - o.threshold), 0);
    const worst = [...offenders].sort((a, b) => b.chars - a.chars).slice(0, MAX_LISTED);
    const largest = worst[0];

    const evidence: Evidence[] = [
      {
        kind: 'tool',
        ref: 'ALL',
        detail:
          `${formatCount(offenders.length)} tool result(s) exceeded ${String(OUTLIER_MULTIPLE)}× their own tool's median size, ` +
          `by ${formatCount(estimateTokensFromChars(excessChars))} estimated tokens in total`,
      },
      ...worst.map((o): Evidence => ({
        kind: 'request',
        ref: o.requestId,
        detail:
          `${o.name} returned ~${formatCount(estimateTokensFromChars(o.chars))} tokens ` +
          `(typical ceiling for this tool: ~${formatCount(estimateTokensFromChars(o.threshold))})`,
      })),
    ];

    return [
      {
        class: this.class,
        title: largest
          ? `A single ${largest.name} result cost ~${formatCount(estimateTokensFromChars(largest.chars))} tokens`
          : 'Some tool results are far larger than their own tool norm',
        credits: creditsForChars(
          excessChars,
          ctx,
          `measured characters returned above ${String(OUTLIER_MULTIPLE)}× each tool's own median result size`,
          [
            'counts only the excess above the threshold, not the whole result',
            'charges the payload once — in an agent loop an oversized result is re-transmitted on every later step, so the true cost is higher',
            'uses a median multiple rather than a percentile so that a handful of extreme results cannot raise the bar above themselves',
          ],
        ),
        confidence: withEffectSize(
          sampleConfidence(measured.length, 200),
          offenders.length / (measured.length * 0.01),
        ),
        evidence,
        remediation: {
          summary: 'A few tool calls return payloads far larger than their tool normally does',
          tier: 'B',
          action:
            `Cap tool results at roughly ${String(ABSOLUTE_CAP_CHARS)} characters and paginate beyond that, ` +
            'so an outlier result cannot ride along in context for the rest of the turn.',
        },
      },
    ];
  }
}

/** A result under this size is never worth flagging, whatever the tool's distribution looks like. */
const ABSOLUTE_CAP_CHARS = 16_000;
/** How many times its own tool's median a result must reach before it counts as an outlier. */
const OUTLIER_MULTIPLE = 20;
const MIN_SAMPLE = 50;
const MIN_CALLS_PER_TOOL = 10;
const MAX_LISTED = 10;
