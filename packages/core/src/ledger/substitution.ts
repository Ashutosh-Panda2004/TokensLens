import { creditsToUsd } from './budget.js';
import type { LedgerSummary } from './ledger.js';
import { findRate, type ModelRate } from './rate-card.js';

/**
 * **D14.9 — the cheapest model that was actually billed here.**
 *
 * Model mix is the largest single lever on Copilot spend, and it is the one
 * a developer can act on inside a second. This prices that lever from the
 * rate card rather than from an opinion about which models are "good
 * enough".
 *
 * ## The discipline borrowed from the routing lever
 *
 * A counterfactual is only priced against a rate that was **measured in this
 * corpus**. Pricing one estimate against another compounds two guesses into
 * a single confident-looking number, which is the specific way a savings
 * figure becomes a sales pitch. A model that has never actually been billed
 * here has an unknown cost, and is left out visibly rather than guessed at.
 *
 * ## What this is not
 *
 * It is not a claim that the cheaper model would have done the job. That is
 * a counterfactual and is not observable in the data, so it is stated as a
 * caveat on every result rather than buried.
 */
export interface ModelSubstitution {
  readonly from: string;
  readonly to: string;
  readonly requests: number;
  readonly currentCredits: number;
  readonly substitutedCredits: number;
  readonly savedCredits: number;
  readonly savedUsd: number;
  /** How many measured requests the target model's rate averages over. */
  readonly targetSampleSize: number;
}

export interface SubstitutionAdvice {
  /**
   * What the figures below cover.
   *
   * The advice is computed over the whole scoped history, because a rate
   * needs samples, while the HUD's headline is month-to-date. Two figures
   * that look comparable and are not is the same defect as an unlabelled
   * scope, so the window travels with the numbers.
   */
  readonly window: 'all-time';
  readonly substitutions: readonly ModelSubstitution[];
  readonly totalSavedCredits: number;
  readonly totalSavedUsd: number;
  /**
   * GitHub applies a documented 10% discount on model costs under auto model
   * selection. Whether it is *already* being applied is not recorded in the
   * journal, so this is what it would be worth, not a claim that it is
   * missing. Saying otherwise would be inventing a finding.
   */
  readonly autoSelectionDiscountUsd: number;
  readonly caveats: readonly string[];
}

/** Only a rate the corpus actually billed may price a counterfactual. */
function measuredRate(rateCard: readonly ModelRate[], model: string): ModelRate | undefined {
  const rate = findRate(rateCard, model);
  return rate?.provenance.kind === 'measured' && rate.creditsPerKPromptToken > 0 ? rate : undefined;
}

const AUTO_SELECTION_DISCOUNT = 0.1;

export function buildSubstitutionAdvice(ledger: LedgerSummary): SubstitutionAdvice {
  const rateCard = ledger.rateCard;

  // The cheapest model with a rate this corpus actually measured. Anything
  // cheaper on paper but never billed here is not a priceable alternative.
  const candidates = rateCard
    .filter((rate) => rate.provenance.kind === 'measured' && rate.creditsPerKPromptToken > 0)
    .sort((a, b) => a.creditsPerKPromptToken - b.creditsPerKPromptToken);
  const cheapest = candidates[0];

  const substitutions: ModelSubstitution[] = [];

  if (cheapest !== undefined) {
    for (const spend of ledger.byModel) {
      if (spend.model === cheapest.model) continue;

      const from = measuredRate(rateCard, spend.model);
      if (from === undefined) continue;
      if (cheapest.creditsPerKPromptToken >= from.creditsPerKPromptToken) continue;

      // A rate ratio rather than a token re-count: the same shape the
      // routing lever uses, so the two cannot disagree about what a swap
      // is worth.
      const scale = cheapest.creditsPerKPromptToken / from.creditsPerKPromptToken;
      const substitutedCredits = spend.credits * scale;
      const savedCredits = spend.credits - substitutedCredits;

      substitutions.push({
        from: spend.model,
        to: cheapest.model,
        requests: spend.requestCount,
        currentCredits: spend.credits,
        substitutedCredits,
        savedCredits,
        savedUsd: creditsToUsd(savedCredits),
        targetSampleSize: cheapest.sampleSize,
      });
    }
  }

  substitutions.sort((a, b) => b.savedCredits - a.savedCredits);

  const totalSavedCredits = substitutions.reduce((sum, entry) => sum + entry.savedCredits, 0);

  return {
    window: 'all-time',
    substitutions,
    totalSavedCredits,
    totalSavedUsd: creditsToUsd(totalSavedCredits),
    autoSelectionDiscountUsd: creditsToUsd(ledger.totalCredits * AUTO_SELECTION_DISCOUNT),
    caveats: [
      'Covers the whole recorded history for this scope, not just this month — a rate needs samples to be worth anything.',
      'Assumes the cheaper model would have produced an acceptable result. That is a counterfactual and is not observable in the recorded data.',
      'Priced only against models whose rate was measured on this machine, never one estimate against another.',
      'TokenLens cannot tell from the journal whether auto model selection is already in use, so its discount is shown as what it is worth, not as something you are missing.',
    ],
  };
}
