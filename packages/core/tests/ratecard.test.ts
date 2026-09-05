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

describe('findRate — the same model, spelled two ways', () => {
  // The journal is not internally consistent: a request records
  // `claude-opus-4-6` while a compaction event on the same model records
  // `claude-opus-4.6`. A lookup that finds nothing is indistinguishable from a
  // model that has no rate, so W12 matched three of 86 compactions, judged the
  // sample too thin, and reported nothing at all.
  const rateCard = deriveRateCard([
    { model: 'claude-opus-4-6', credits: 10, promptTokens: 1000 },
    { model: 'gpt-5.5', credits: 20, promptTokens: 1000 },
    { model: 'gpt-5.5-2026-04-23', credits: 30, promptTokens: 1000 },
  ]);

  it('matches an exact identifier', () => {
    expect(findRate(rateCard, 'claude-opus-4-6')?.creditsPerKPromptToken).toBeCloseTo(10, 6);
  });

  it('matches across separator spellings of the same model', () => {
    expect(findRate(rateCard, 'claude-opus-4.6')?.creditsPerKPromptToken).toBeCloseTo(10, 6);
    expect(findRate(rateCard, 'CLAUDE-OPUS-4_6')?.creditsPerKPromptToken).toBeCloseTo(10, 6);
  });

  it('keeps a dated snapshot distinct from its floating alias when both are priced', () => {
    expect(findRate(rateCard, 'gpt-5-5')?.creditsPerKPromptToken).toBeCloseTo(20, 6);
    expect(findRate(rateCard, 'gpt-5-5-2026-04-23')?.creditsPerKPromptToken).toBeCloseTo(30, 6);
  });

  it('matches an alias to the one dated snapshot that carries its rate', () => {
    // The journal names `claude-haiku-4.5` on a compaction and
    // `claude-haiku-4-5-20251001` on the requests that priced it. Without this,
    // 32 of 86 compactions had no rate and W12 fell one short of its sample
    // floor — a threshold decided by a spelling.
    const dated = deriveRateCard([
      { model: 'claude-haiku-4-5-20251001', credits: 5, promptTokens: 1000 },
    ]);
    expect(findRate(dated, 'claude-haiku-4.5')?.creditsPerKPromptToken).toBeCloseTo(5, 6);
  });

  it('refuses an ambiguous snapshot match rather than picking one', () => {
    // A rate attached to the wrong model is worse than a rate that is missing
    // and says so.
    const ambiguous = deriveRateCard([
      { model: 'claude-haiku-4-5-20251001', credits: 5, promptTokens: 1000 },
      { model: 'claude-haiku-4-5-20260101', credits: 9, promptTokens: 1000 },
    ]);
    expect(findRate(ambiguous, 'claude-haiku-4.5')).toBeUndefined();
  });

  it('will not treat a version bump as a release stamp', () => {
    // `gpt-5` and `gpt-5-5` are different models. Only a date-shaped suffix is
    // allowed to merge, which is what keeps this widening safe.
    const versions = deriveRateCard([{ model: 'gpt-5-5', credits: 7, promptTokens: 1000 }]);
    expect(findRate(versions, 'gpt-5')).toBeUndefined();
  });

  it('still returns nothing for a model the card has never seen', () => {
    expect(findRate(rateCard, 'some-other-model')).toBeUndefined();
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
