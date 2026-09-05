import { sampleConfidence, withEffectSize } from '../scoring.js';
import { formatCount, formatCredits, formatPercent } from '../format.js';
import { findRate } from '../../ledger/rate-card.js';
import { modelled } from '../../model/provenance.js';
import type { ModelRate } from '../../ledger/rate-card.js';
import type { DetectContext, Evidence, WasteDetector, WasteFinding } from '../types.js';

/**
 * **W12 · Utility-model drift** (§18.5) — housekeeping running on the expensive
 * model.
 *
 * Summarising a conversation, naming a thread, drafting a commit message: work
 * where the answer is short, the judgement is shallow, and the cheapest model in
 * the fleet would be indistinguishable. When it lands on the premium model
 * anyway, the bill is the difference, and nobody chose it — the sub-step simply
 * inherited whatever the conversation was already using.
 *
 * ## What is measurable today, and what is not
 *
 * D3 recorded the blocker as *"only the model that handled compaction is
 * recorded per sub-step; titles, summaries and commit messages are not
 * attributed to a model"*. Half of that is the finding rather than the
 * obstacle: **compaction is the largest utility sub-step there is**, and it is
 * recorded, with its model, its round count and the context length it chewed
 * through. Rounds also carry an optional `modelId`, so a sub-step that ran on a
 * different model from its parent request is visible wherever the journal
 * bothered to write it down.
 *
 * Titles and commit messages remain invisible. They are also small. This
 * detector charges what it can see and says what it cannot, rather than
 * inferring the rest from the shape of the part it can — which would produce a
 * number that looks measured and is not.
 *
 * ## Pricing a counterfactual without compounding two guesses
 *
 * The saving is *"this would have cost less on the cheap model"*, which is a
 * counterfactual and can only be priced against a rate that was actually
 * observed. If the cheapest model's rate is itself an estimate, there is no
 * measurement to compare against and the detector returns nothing. That is the
 * same rule `simulate/levers.ts` applies to routing, for the same reason: two
 * estimates multiplied together produce a confident-looking number with no
 * measurement anywhere inside it.
 */
export class UtilityModelDriftDetector implements WasteDetector {
  readonly class = 'W12' as const;
  readonly name = 'Utility-model drift';

  detect(ctx: DetectContext): WasteFinding[] {
    const cheapest = cheapestMeasured(ctx.ledger.rateCard);
    if (cheapest === undefined) return [];

    const requestById = new Map(ctx.requests.map((request) => [request.requestId, request]));

    /** Compactions that ran on a model dearer than the cheapest measured one. */
    const drifted: {
      requestId: string;
      model: string;
      contextTokens: number;
      excessCredits: number;
    }[] = [];
    let compactionsJudged = 0;
    let unpriceable = 0;

    for (const compaction of ctx.compactions) {
      const rate = findRate(ctx.ledger.rateCard, compaction.model);
      if (rate?.provenance.kind !== 'measured') {
        unpriceable += 1;
        continue;
      }
      compactionsJudged += 1;
      if (rate.creditsPerKPromptToken <= cheapest.creditsPerKPromptToken * MIN_RATE_MULTIPLE) {
        continue;
      }

      // The compaction re-read the context it was summarising. That length is
      // measured, so the excess is the rate difference over it.
      const kTokens = compaction.contextLengthBefore / 1_000;
      drifted.push({
        requestId: compaction.requestId,
        model: compaction.model,
        contextTokens: compaction.contextLengthBefore,
        excessCredits: kTokens * (rate.creditsPerKPromptToken - cheapest.creditsPerKPromptToken),
      });
    }

    // Rounds that named their own model, where it differs from the parent
    // request's. Recorded inconsistently, so counted rather than priced.
    let subStepRounds = 0;
    let subStepOnPremium = 0;
    for (const round of ctx.rounds) {
      if (round.modelId === null) continue;
      const parent = requestById.get(round.requestId);
      if (parent === undefined || round.modelId === parent.model) continue;
      subStepRounds += 1;
      const rate = findRate(ctx.ledger.rateCard, round.modelId);
      if (
        rate !== undefined &&
        rate.creditsPerKPromptToken > cheapest.creditsPerKPromptToken * MIN_RATE_MULTIPLE
      ) {
        subStepOnPremium += 1;
      }
    }

    if (compactionsJudged < MIN_COMPACTIONS || drifted.length === 0) return [];

    const excessCredits = drifted.reduce((sum, entry) => sum + entry.excessCredits, 0);
    const driftRate = drifted.length / compactionsJudged;
    const worst = [...drifted]
      .sort((a, b) => b.excessCredits - a.excessCredits)
      .slice(0, MAX_LISTED);

    const evidence: Evidence[] = [
      {
        kind: 'model',
        ref: 'ALL',
        detail:
          `${formatCount(drifted.length)} of ${formatCount(compactionsJudged)} compactions ` +
          `(${formatPercent(driftRate)}) summarised on a model dearer than ${cheapest.model}, ` +
          `the cheapest whose rate was actually measured`,
        credits: excessCredits,
      },
      {
        kind: 'model',
        ref: 'SUB-STEPS',
        detail:
          `${formatCount(subStepOnPremium)} of ${formatCount(subStepRounds)} rounds that named their ` +
          'own model ran it on a premium one \u2014 counted, not priced, because a round carries no ' +
          'token count of its own',
      },
      {
        kind: 'model',
        ref: 'UNPRICEABLE',
        detail:
          `${formatCount(unpriceable)} compaction(s) ran on a model with no measured rate and are ` +
          'excluded rather than priced against another estimate',
      },
      ...worst.map((entry): Evidence => ({
        kind: 'request',
        ref: entry.requestId,
        detail:
          `${entry.model} summarised ~${formatCount(entry.contextTokens)} tokens of context that ` +
          `${cheapest.model} could have summarised`,
        credits: entry.excessCredits,
      })),
    ];

    return [
      {
        class: this.class,
        title: `${formatPercent(driftRate)} of context summarisation ran on a premium model`,
        credits: modelled(
          excessCredits,
          `measured context length at each compaction, charged at the rate difference between the model that ran it and ${cheapest.model}`,
          [
            'assumes the cheapest measured model would have produced an acceptable summary \u2014 a counterfactual, and not observable in this data',
            'prices only against models whose rate was actually measured in this corpus, never against another estimate',
            'counts compaction only. Titles, thread names and commit messages are not attributed to a model in the journal and are omitted rather than inferred',
            'charges the context length once, though a summarisation reads it and writes a summary that is then carried forward',
          ],
        ),
        confidence: withEffectSize(
          sampleConfidence(compactionsJudged, 20),
          // Half of all compaction on a premium model is unambiguous.
          driftRate / 0.5,
        ),
        evidence,
        remediation: {
          summary: `${formatCredits(excessCredits)} credits of housekeeping ran on the expensive model`,
          tier: 'A',
          action:
            `Pin summarisation and other utility sub-steps to ${cheapest.model} in managed settings. ` +
            'This is a setting, not a dependency: the sub-step inherits the conversation\u2019s model ' +
            'today because nothing has told it otherwise.',
        },
      },
    ];
  }
}

/** The cheapest model whose rate is a measurement rather than an estimate. */
function cheapestMeasured(rateCard: readonly ModelRate[]): ModelRate | undefined {
  return rateCard
    .filter((rate) => rate.provenance.kind === 'measured' && rate.creditsPerKPromptToken > 0)
    .sort((a, b) => a.creditsPerKPromptToken - b.creditsPerKPromptToken)[0];
}

/** How many times the cheap rate a model must cost before the gap is worth naming. */
const MIN_RATE_MULTIPLE = 2;
const MIN_COMPACTIONS = 10;
const MAX_LISTED = 10;
