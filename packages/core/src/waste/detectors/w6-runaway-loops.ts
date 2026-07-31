import { modelled } from '../../model/provenance.js';
import { groupBy, quantile, sampleConfidence, withEffectSize } from '../scoring.js';
import { formatCount } from '../format.js';
import type { DetectContext, Evidence, WasteDetector, WasteFinding } from '../types.js';

/**
 * **W6 · Runaway loops** (F11).
 *
 * An agent loop that runs for dozens of rounds and produces **no surviving
 * edit** spent real money and left nothing behind. The round count alone is
 * not the signal — a 60-round refactor that lands a large change is exactly
 * what the tool is for. The signal is *depth without output*.
 *
 * ## Why `done` matters and what it does not prove
 *
 * `EditRecord.done` records that VS Code marked an edit batch complete. It
 * is a local signal: it does **not** prove the change was kept, committed,
 * or survived review. A stronger version of this detector joins against git
 * history (W7), which needs a data source outside the journal.
 *
 * So this detector claims only what it can see: the request ran unusually
 * long *for this corpus* and finished with no completed edit. That is a
 * strong smell, not a proof of waste, and the confidence and assumptions
 * say so.
 */
export class RunawayLoopDetector implements WasteDetector {
  readonly class = 'W6' as const;
  readonly name = 'Runaway agent loops';

  detect(ctx: DetectContext): WasteFinding[] {
    const roundsByRequest = groupBy(ctx.rounds, (round) => round.requestId);
    if (roundsByRequest.size < MIN_SAMPLE) return [];

    const editsByRequest = groupBy(ctx.edits, (edit) => edit.requestId);

    // "Unusually long" is relative to this corpus, not an absolute number:
    // round counts differ enormously between a chat-heavy and an agent-heavy
    // team, and a fixed threshold would be wrong for at least one of them.
    const roundCounts = ctx.requests
      .map((request) => roundsByRequest.get(request.requestId)?.length ?? 0)
      .sort((a, b) => a - b);
    const threshold = Math.max(ABSOLUTE_MIN_ROUNDS, quantile(roundCounts, DEEP_PERCENTILE));

    let wastedCredits = 0;
    const offenders: { requestId: string; rounds: number; credits: number }[] = [];

    for (const request of ctx.requests) {
      const rounds = roundsByRequest.get(request.requestId)?.length ?? 0;
      if (rounds < threshold) continue;

      const edits = editsByRequest.get(request.requestId) ?? [];
      const producedSomething = edits.some((edit) => edit.done === 1 && edit.editCount > 0);
      if (producedSomething) continue;

      const credits = ctx.creditsByRequest.get(request.requestId) ?? 0;
      wastedCredits += credits;
      offenders.push({ requestId: request.requestId, rounds, credits });
    }

    if (offenders.length === 0) return [];

    const worst = [...offenders].sort((a, b) => b.credits - a.credits).slice(0, MAX_LISTED);
    const deepest = Math.max(...offenders.map((o) => o.rounds));

    const evidence: Evidence[] = [
      {
        kind: 'request',
        ref: 'ALL',
        detail:
          `${formatCount(offenders.length)} request(s) ran ${String(threshold)}+ rounds ` +
          `and completed no edit — deepest was ${String(deepest)} rounds`,
      },
      ...worst.map((o): Evidence => ({
        kind: 'request',
        ref: o.requestId,
        detail: `${String(o.rounds)} rounds, no completed edit`,
        credits: o.credits,
      })),
    ];

    return [
      {
        class: this.class,
        title: `${String(offenders.length)} deep agent loop(s) finished without producing an edit`,
        credits: modelled(
          wastedCredits,
          `full credit cost of requests running ${String(threshold)}+ rounds that completed no edit`,
          [
            'a request producing no edit is not necessarily wasted — investigation, review and answering a question are legitimate outcomes',
            "edit completion is VS Code's local signal; it does not prove the change was kept or committed",
            `"deep" is the ${String(Math.round(DEEP_PERCENTILE * 100))}th percentile of this corpus's own round counts, not a fixed number`,
          ],
        ),
        confidence: withEffectSize(
          sampleConfidence(offenders.length, 15),
          // Charging the *whole* request cost is aggressive, so the ceiling
          // here is deliberately lower than the other detectors'.
          0.7,
        ),
        evidence,
        remediation: {
          summary: 'Deep loops that produce nothing are the most expensive failure mode',
          tier: 'B',
          action:
            `Cap agent loops at around ${String(threshold)} rounds and surface a checkpoint, ` +
            'so a loop that is not converging stops rather than continuing to spend.',
        },
      },
    ];
  }
}

const DEEP_PERCENTILE = 0.9;
const ABSOLUTE_MIN_ROUNDS = 10;
const MIN_SAMPLE = 20;
const MAX_LISTED = 10;
