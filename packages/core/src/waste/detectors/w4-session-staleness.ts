import { creditsForTokens, groupBy, sampleConfidence, withEffectSize } from '../scoring.js';
import { formatCount } from '../format.js';
import type { DetectContext, Evidence, WasteDetector, WasteFinding } from '../types.js';

/**
 * **W4 · Session staleness** (F5).
 *
 * The whole conversation is re-sent on every turn, so a chat gets steadily
 * more expensive the longer it stays open. A session kept open across
 * several unrelated tasks pays, on every turn, to re-transmit a discussion
 * that stopped being relevant hours ago.
 *
 * ## How the excess is separated from the legitimate growth
 *
 * Some growth is real: turn 10 of a genuinely long task legitimately has
 * more context than turn 1. The detector therefore does not charge for
 * *all* late-turn cost. It establishes each session's own **early-turn
 * baseline** (the mean prompt size over its first few turns) and charges
 * only the amount by which late turns exceed that baseline.
 *
 * Using a per-session baseline rather than a global one matters: a session
 * that starts with a large attached file is not penalised for staying
 * large, only for *growing*.
 */
export class SessionStalenessDetector implements WasteDetector {
  readonly class = 'W4' as const;
  readonly name = 'Stale chat sessions';

  detect(ctx: DetectContext): WasteFinding[] {
    const bySession = groupBy(ctx.requests, (request) => request.sessionId);

    let excessTokens = 0;
    let staleTurns = 0;
    const offenders: { sessionId: string; turns: number; excessTokens: number }[] = [];

    for (const [sessionId, requests] of bySession) {
      if (requests.length <= STALE_TURN_THRESHOLD) continue;

      const ordered = [...requests].sort((a, b) => a.turnIndex - b.turnIndex);
      const baselineTurns = ordered.slice(0, BASELINE_TURNS);
      const baseline =
        baselineTurns.reduce((sum, r) => sum + r.promptTokens, 0) / baselineTurns.length;
      if (baseline <= 0) continue;

      let sessionExcess = 0;
      for (const request of ordered.slice(STALE_TURN_THRESHOLD)) {
        const excess = request.promptTokens - baseline;
        if (excess > 0) {
          sessionExcess += excess;
          staleTurns += 1;
        }
      }

      if (sessionExcess > 0) {
        excessTokens += sessionExcess;
        offenders.push({ sessionId, turns: ordered.length, excessTokens: sessionExcess });
      }
    }

    if (offenders.length === 0) return [];

    const worst = [...offenders]
      .sort((a, b) => b.excessTokens - a.excessTokens)
      .slice(0, MAX_LISTED);
    const longestSession = Math.max(...offenders.map((o) => o.turns));

    const evidence: Evidence[] = [
      {
        kind: 'session',
        ref: 'ALL',
        detail:
          `${formatCount(offenders.length)} session(s) ran past ${String(STALE_TURN_THRESHOLD)} turns, ` +
          `accumulating ${formatCount(excessTokens)} tokens above their own early-turn baseline`,
      },
      ...worst.map((o): Evidence => ({
        kind: 'session',
        ref: o.sessionId,
        detail: `${String(o.turns)} turns — ${formatCount(o.excessTokens)} tokens above this session's own baseline`,
      })),
    ];

    return [
      {
        class: this.class,
        title: `Long-running chats carried ${formatCount(excessTokens)} tokens of accumulated history`,
        credits: creditsForTokens(
          excessTokens,
          ctx,
          "prompt tokens beyond each session's own early-turn baseline, after turn " +
            String(STALE_TURN_THRESHOLD),
          [
            'assumes the early-turn prompt size represents the context the task genuinely needed',
            'charges only growth above that baseline, not the whole late-turn prompt',
            'some growth is legitimate — a long task really does accumulate relevant context',
          ],
        ),
        confidence: withEffectSize(
          sampleConfidence(staleTurns, 40),
          offenders.length / Math.max(1, bySession.size),
        ),
        evidence,
        remediation: {
          summary: `The longest session ran to ${String(longestSession)} turns`,
          tier: 'C',
          action:
            'Start a new chat when starting a new task. Free, needs no tooling — ' +
            'and a session-age indicator makes it visible at the moment the decision is made.',
        },
      },
    ];
  }
}

/** Turns beyond this are candidates for the accumulated-history charge (F5 measured the penalty from ~turn 5). */
const STALE_TURN_THRESHOLD = 8;
const BASELINE_TURNS = 3;
const MAX_LISTED = 10;
