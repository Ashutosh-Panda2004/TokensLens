import { describe, it, expect } from 'vitest';
import { deriveRateCard, findRate, estimateCredits } from '../src/ledger/rate-card.js';

describe('deriveRateCard', () => {
  it('reproduces known per-model rates from measured samples (PLAN.md §1.2)', () => {
    const rateCard = deriveRateCard([
      { model: 'copilot/claude-opus-4.8', credits: 177.8, promptTokens: 100_000 },
      { model: 'copilot/claude-sonnet-5', credits: 24.2, promptTokens: 100_000 },
      { model: 'copilot/claude-haiku-4.5', credits: 11.8, promptTokens: 100_000 },
    ]);

    expect(findRate(rateCard, 'copilot/claude-opus-4.8')?.creditsPerKPromptToken).toBeCloseTo(
      1.778,
      3,
    );
    expect(findRate(rateCard, 'copilot/claude-sonnet-5')?.creditsPerKPromptToken).toBeCloseTo(
      0.242,
      3,
    );
    expect(findRate(rateCard, 'copilot/claude-haiku-4.5')?.creditsPerKPromptToken).toBeCloseTo(
      0.118,
      3,
    );
  });

  it('tags a model with measured samples as "measured" provenance', () => {
    const rateCard = deriveRateCard([{ model: 'm', credits: 10, promptTokens: 1000 }]);
    expect(findRate(rateCard, 'm')?.provenance.kind).toBe('measured');
    expect(findRate(rateCard, 'm')?.sampleSize).toBe(1);
  });

  it('averages multiple measured samples for the same model', () => {
    const rateCard = deriveRateCard([
      { model: 'm', credits: 10, promptTokens: 1000 }, // 10/1 = 10 cr/1k
      { model: 'm', credits: 20, promptTokens: 1000 }, // 20/1 = 20 cr/1k
    ]);
    // (10 + 20) total credits / (1 + 1) total k-tokens = 15
    expect(findRate(rateCard, 'm')?.creditsPerKPromptToken).toBeCloseTo(15, 6);
    expect(findRate(rateCard, 'm')?.sampleSize).toBe(2);
  });

  it('gives a model with zero measured samples the blended rate, tagged "modelled"', () => {
    const rateCard = deriveRateCard([
      { model: 'expensive', credits: 100, promptTokens: 1000 }, // 100 cr/1k
      { model: 'cheap', credits: 10, promptTokens: 1000 }, // 10 cr/1k
      { model: 'unmeasured', promptTokens: 500 }, // never carries credits
    ]);

    const unmeasured = findRate(rateCard, 'unmeasured');
    expect(unmeasured?.sampleSize).toBe(0);
    expect(unmeasured?.provenance.kind).toBe('modelled');
    // blended = (100 + 10) / (1 + 1) = 55
    expect(unmeasured?.creditsPerKPromptToken).toBeCloseTo(55, 6);
  });

  it('never fabricates a rate of zero for an unmeasured model when no measured samples exist at all', () => {
    const rateCard = deriveRateCard([{ model: 'only-unmeasured', promptTokens: 1000 }]);
    const rate = findRate(rateCard, 'only-unmeasured');
    expect(rate?.sampleSize).toBe(0);
    expect(rate?.creditsPerKPromptToken).toBe(0); // no measured data anywhere -> honestly zero, not fabricated
    expect(rate?.provenance.kind).toBe('modelled');
  });

  it('gives every distinct model in the input an entry', () => {
    const rateCard = deriveRateCard([
      { model: 'a', credits: 1, promptTokens: 1000 },
      { model: 'b', promptTokens: 1000 },
      { model: 'c', promptTokens: 1000 },
    ]);
    expect(rateCard.map((r) => r.model).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('estimateCredits', () => {
  it('estimates using the model-specific rate when one exists', () => {
    const rateCard = deriveRateCard([{ model: 'm', credits: 10, promptTokens: 1000 }]); // 10 cr/1k
    const estimate = estimateCredits(2000, 'm', rateCard);
    expect(estimate.value).toBeCloseTo(20, 6); // 2000/1000 * 10
    expect(estimate.provenance.kind).toBe('modelled'); // always modelled — this specific request wasn't measured
  });

  it('falls back to zero when the model has no rate card entry at all', () => {
    const estimate = estimateCredits(1000, 'unknown-model', []);
    expect(estimate.value).toBe(0);
    expect(estimate.provenance.kind).toBe('modelled');
  });
});
