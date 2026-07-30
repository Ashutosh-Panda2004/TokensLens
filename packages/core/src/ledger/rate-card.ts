import { measured, modelled, type Value } from '../model/provenance.js';

const TOKENS_PER_RATE_UNIT = 1000;

/**
 * The minimal shape `deriveRateCard` needs — deliberately not `TurnRecord`
 * itself, so both in-memory `TurnRecord[]` and flattened database rows
 * (which represent `credits` as `number | null`, not `number | undefined`)
 * can satisfy it without an awkward conversion step.
 */
export interface RateCardSample {
  readonly model: string;
  readonly credits?: number;
  readonly promptTokens: number;
}

export interface ModelRate {
  readonly model: string;
  readonly creditsPerKPromptToken: number;
  /** How many measured (real `copilotCredits`) requests this model's rate is averaged over. 0 means the blended fallback was used. */
  readonly sampleSize: number;
  readonly provenance: Value<number>['provenance'];
}

/**
 * Derives a credits-per-1k-prompt-token rate for every model seen in
 * `samples`, from whichever subset carries a real `copilotCredits` value
 * (empirically ~9.4% of requests — F12).
 *
 * Every model gets an entry, even ones with zero measured samples: those
 * fall back to the *blended* rate (the average across every measured
 * request, regardless of model) and are tagged `Modelled`, never silently
 * defaulted to zero. A model with its own measured samples gets a
 * `Measured` entry — the empirical mean of `credits / (promptTokens/1000)`
 * over just that model's measured requests.
 */
export function deriveRateCard(samples: readonly RateCardSample[]): ModelRate[] {
  const measuredByModel = new Map<
    string,
    { totalCredits: number; totalKTokens: number; count: number }
  >();
  const allModels = new Set<string>();
  let blendedCredits = 0;
  let blendedKTokens = 0;

  for (const record of samples) {
    allModels.add(record.model);
    if (record.credits === undefined || record.promptTokens <= 0) continue;

    const kTokens = record.promptTokens / TOKENS_PER_RATE_UNIT;
    blendedCredits += record.credits;
    blendedKTokens += kTokens;

    const bucket = measuredByModel.get(record.model) ?? {
      totalCredits: 0,
      totalKTokens: 0,
      count: 0,
    };
    bucket.totalCredits += record.credits;
    bucket.totalKTokens += kTokens;
    bucket.count += 1;
    measuredByModel.set(record.model, bucket);
  }

  const blendedRate = blendedKTokens > 0 ? blendedCredits / blendedKTokens : 0;

  return [...allModels].map((model): ModelRate => {
    const bucket = measuredByModel.get(model);
    if (bucket && bucket.totalKTokens > 0) {
      const rate = bucket.totalCredits / bucket.totalKTokens;
      return {
        model,
        creditsPerKPromptToken: rate,
        sampleSize: bucket.count,
        provenance: measured(
          rate,
          `derived from ${String(bucket.count)} measured request(s) for "${model}"`,
        ).provenance,
      };
    }

    return {
      model,
      creditsPerKPromptToken: blendedRate,
      sampleSize: 0,
      provenance: modelled(blendedRate, 'blended rate across all measured requests', [
        `no request for model "${model}" carried a measured copilotCredits value`,
        "assumes this model's real rate resembles the fleet-wide blend",
      ]).provenance,
    };
  });
}

/** Looks up one model's rate, if the rate card has an entry for it. */
export function findRate(rateCard: readonly ModelRate[], model: string): ModelRate | undefined {
  return rateCard.find((entry) => entry.model === model);
}

/**
 * Estimates credits for a request that lacks a measured `copilotCredits`
 * value, using the rate card. Returns `Modelled` unconditionally — even
 * when the rate card's own entry for this model happens to be `Measured`,
 * *this specific request's* credits are still an estimate, not a reading.
 */
export function estimateCredits(
  promptTokens: number,
  model: string,
  rateCard: readonly ModelRate[],
): Value<number> {
  const rate = findRate(rateCard, model);
  const creditsPerKPromptToken = rate?.creditsPerKPromptToken ?? 0;
  const estimated = (promptTokens / TOKENS_PER_RATE_UNIT) * creditsPerKPromptToken;

  return modelled(estimated, `rate-card estimate for "${model}"`, [
    rate && rate.sampleSize > 0
      ? `uses the measured rate for "${model}" (${String(rate.sampleSize)} sample(s))`
      : `no rate card entry for "${model}" — used the blended fallback (or zero if none exists)`,
  ]);
}
