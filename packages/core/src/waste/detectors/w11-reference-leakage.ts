import { creditsForTokens, groupBy, sampleConfidence, withEffectSize } from '../scoring.js';
import { formatCount, formatPercent } from '../format.js';
import type { DetectContext, Evidence, WasteDetector, WasteFinding } from '../types.js';

/** Tools whose invocation means the model actually opened the file it was shown. */
const READ_TOOLS = new Set(['read_file', 'get_errors']);

/**
 * **W11 · Search-snippet leakage** (§18.5) — files the model was shown and
 * never opened.
 *
 * Search results, attachments and previews arrive as `contentReferences[]`.
 * Each one costs prompt tokens on the request that carried it, and then keeps
 * costing them for the rest of the turn. A reference the model went on to read
 * earned its place. A reference it never touched was paid for and ignored.
 *
 * ## Why this was undetectable until now
 *
 * D3 recorded the blocker as *"file references shown to the model are recorded,
 * but the token cost of each preview is not, so the leaked amount cannot be
 * priced"*. The first half is still true and the second half was too strong.
 * The journal records a **`Files` cost centre per request** — the decomposed
 * token cost of exactly this material. It does not say how those tokens split
 * across references, but it says what they total, and apportioning a measured
 * total across the items that produced it is the same move W1 already makes for
 * tool definitions.
 *
 * ## The apportionment, and the direction it fails in
 *
 * Uniform: each reference on a request is charged an equal share of that
 * request's `Files` tokens. References are of course not equal — a one-line hit
 * and a nine-hundred-line preview get the same share. The assumption is stated
 * on the finding rather than buried, and it fails **safe**: it cannot make a
 * leaked reference look free, and it cannot concentrate the whole cost onto one
 * reference and produce a dramatic number from a single observation.
 *
 * ## What is deliberately not counted
 *
 * A reference opened *later in the same session* is not waste, even if it was
 * shown on an earlier request. The model was given something it went on to use;
 * that the use came two turns afterwards is retrieval working, not leaking.
 */
/**
 * Whether the references in this corpus can be priced at all.
 *
 * Exported for the same reason W7's coverage is: on the corpus this was first
 * run against, 224 references were recorded and **13** sat on a request with a
 * decomposed `Files` cost. The detector abstained, correctly and silently — and
 * silently is indistinguishable from "retrieval here is fine", which the
 * residual probe put at 97.8% unopened. A reader deserves the difference.
 */
export interface ReferencePricing {
  readonly referencesSeen: number;
  readonly priceable: number;
  readonly sufficient: boolean;
  readonly reason: string;
}

export function assessReferencePricing(ctx: DetectContext): ReferencePricing {
  const priced = new Set(
    ctx.costCentres
      .filter((centre) => centre.label === 'Files' && centre.tokens > 0)
      .map((centre) => centre.requestId),
  );
  const priceable = ctx.contentReferences.filter((reference) =>
    priced.has(reference.requestId),
  ).length;
  const referencesSeen = ctx.contentReferences.length;
  const sufficient = priceable >= MIN_REFERENCES;

  return {
    referencesSeen,
    priceable,
    sufficient,
    reason: sufficient
      ? ''
      : `${formatCount(referencesSeen)} file reference(s) were recorded, but only ` +
        `${formatCount(priceable)} sat on a request whose prompt cost was broken down far enough ` +
        `to price them \u2014 below the ${String(MIN_REFERENCES)} needed. Borrowing another ` +
        'request\u2019s average would be an estimate dressed as a measurement',
  };
}

export class ReferenceLeakageDetector implements WasteDetector {
  readonly class = 'W11' as const;
  readonly name = 'Search-snippet leakage';

  detect(ctx: DetectContext): WasteFinding[] {
    if (ctx.contentReferences.length < MIN_REFERENCES) return [];

    const sessionOf = new Map(
      ctx.requests.map((request) => [request.requestId, request.sessionId]),
    );

    // Files actually opened, per session. Session-scoped rather than
    // request-scoped on purpose: a reference used two turns later was used.
    const openedBySession = new Map<string, Set<string>>();
    for (const call of ctx.toolCalls) {
      if (!READ_TOOLS.has(call.name) || call.targetFileHash === null) continue;
      const opened = openedBySession.get(call.sessionId) ?? new Set<string>();
      opened.add(call.targetFileHash);
      openedBySession.set(call.sessionId, opened);
    }

    const filesTokensByRequest = new Map<string, number>();
    for (const centre of ctx.costCentres) {
      if (centre.label !== 'Files') continue;
      filesTokensByRequest.set(
        centre.requestId,
        (filesTokensByRequest.get(centre.requestId) ?? 0) + centre.tokens,
      );
    }

    let referencesJudged = 0;
    let unopened = 0;
    let leakedTokens = 0;
    let unpriceable = 0;
    const perSession = new Map<string, { unopened: number; tokens: number }>();

    for (const [requestId, references] of groupBy(
      ctx.contentReferences,
      (reference) => reference.requestId,
    )) {
      const sessionId = sessionOf.get(requestId);
      if (sessionId === undefined) continue;

      const filesTokens = filesTokensByRequest.get(requestId);
      if (filesTokens === undefined || filesTokens <= 0) {
        // The request carried references but no decomposed `Files` cost. There
        // is nothing to apportion, and inventing a per-reference cost from
        // another request's average would be an estimate dressed as a
        // measurement. Counted and skipped.
        unpriceable += references.length;
        continue;
      }

      const opened = openedBySession.get(sessionId) ?? new Set<string>();
      const share = filesTokens / references.length;

      for (const reference of references) {
        referencesJudged += 1;
        if (opened.has(reference.fileHash)) continue;

        unopened += 1;
        leakedTokens += share;
        const bucket = perSession.get(sessionId) ?? { unopened: 0, tokens: 0 };
        bucket.unopened += 1;
        bucket.tokens += share;
        perSession.set(sessionId, bucket);
      }
    }

    if (referencesJudged < MIN_REFERENCES || unopened === 0) return [];

    const leakRate = unopened / referencesJudged;
    if (leakRate < MIN_LEAK_RATE) return [];

    const worst = [...perSession.entries()]
      .sort((a, b) => b[1].tokens - a[1].tokens)
      .slice(0, MAX_LISTED);

    const evidence: Evidence[] = [
      {
        kind: 'file',
        ref: 'ALL',
        detail:
          `${formatCount(unopened)} of ${formatCount(referencesJudged)} file references ` +
          `(${formatPercent(leakRate)}) were shown to the model and never opened, costing ` +
          `~${formatCount(leakedTokens)} apportioned prompt tokens`,
      },
      {
        kind: 'file',
        ref: 'UNPRICEABLE',
        detail:
          `${formatCount(unpriceable)} reference(s) sat on requests with no decomposed Files cost ` +
          'and are excluded rather than priced from another request\u2019s average',
      },
      ...worst.map(([sessionId, entry]): Evidence => ({
        kind: 'session',
        ref: sessionId,
        detail:
          `${formatCount(entry.unopened)} unopened reference(s), ` +
          `~${formatCount(entry.tokens)} apportioned tokens`,
      })),
    ];

    return [
      {
        class: this.class,
        title: `${formatPercent(leakRate)} of files shown to the model were never opened`,
        credits: creditsForTokens(
          leakedTokens,
          ctx,
          'the measured Files cost centre of each request, apportioned equally across the references that request carried, summed over references never opened in that session',
          [
            'apportions each request\u2019s Files tokens equally across its references \u2014 a one-line hit and a long preview receive the same share, which cannot make a leaked reference look free but does blur which one was expensive',
            'counts a reference as used if any read tool opened that file anywhere in the same session, so a reference used two turns later is not charged',
            'excludes references on requests with no decomposed Files cost rather than pricing them from another request\u2019s average',
          ],
        ),
        confidence: withEffectSize(
          sampleConfidence(referencesJudged, 200),
          // Half the references going unopened is a strong signal; 60% saturates.
          leakRate / 0.6,
        ),
        evidence,
        remediation: {
          summary: 'Most of what search puts in front of the model is never opened',
          tier: 'B',
          action:
            `Cap file references at roughly ${String(SUGGESTED_REFERENCE_CAP)} per request and prefer a ` +
            'ranked shortlist to a broad preview set, so the model pays for the files it is going ' +
            'to read rather than for the ones it might.',
        },
      },
    ];
  }
}

/** Below this many references the share is noise rather than a rate. */
const MIN_REFERENCES = 50;
/** A little leakage is retrieval doing its job. This is where it stops being that. */
const MIN_LEAK_RATE = 0.25;
const SUGGESTED_REFERENCE_CAP = 10;
const MAX_LISTED = 10;
