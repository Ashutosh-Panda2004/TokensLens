import { describe, it, expect } from 'vitest';
import { buildSimulationCorpus, record } from './fixtures/simulate-corpus.js';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { buildSimulation } from '../src/simulate/report.js';
import { parsePolicy } from '../src/simulate/policy.js';
import type { Policy } from '../src/simulate/policy.js';

const NOW = new Date('2026-07-15T12:00:00Z');

function policyOf(source: string): Policy {
  return parsePolicy(source).policy;
}

/**
 * Phase D3's waste report had to print a warning that its findings could not
 * be added up, because one request can be claimed by several detectors. This
 * is the phase that resolves that, and these are the tests that hold it.
 */
describe('lever overlap', () => {
  it('does not let two levers bill the same tokens twice', () => {
    const db = buildSimulationCorpus();

    // Both levers act on the *same* runaway requests: those carry a 400k
    // character tool result and run 40 rounds.
    const payloadOnly = buildSimulation(
      db,
      policyOf('version: 1\npayload:\n  max_result_tokens: 1000\n'),
      { now: NOW },
    );
    const loopOnly = buildSimulation(db, policyOf('version: 1\nsession:\n  max_rounds: 10\n'), {
      now: NOW,
    });
    const both = buildSimulation(
      db,
      policyOf('version: 1\npayload:\n  max_result_tokens: 1000\nsession:\n  max_rounds: 10\n'),
      { now: NOW },
    );

    const naive = payloadOnly.combined.theoretical + loopOnly.combined.theoretical;

    expect(payloadOnly.combined.theoretical).toBeGreaterThan(0);
    expect(loopOnly.combined.theoretical).toBeGreaterThan(0);
    // The joint replay is strictly less than the sum, and the report says
    // by how much rather than quietly reporting the smaller number.
    expect(both.combined.theoretical).toBeLessThan(naive);
    expect(both.naiveSumCredits).toBeCloseTo(naive, 6);
    expect(both.overlapCredits).toBeCloseTo(naive - both.combined.theoretical, 6);
    expect(both.overlapCredits).toBeGreaterThan(0);
  });

  it('adds up exactly when levers touch disjoint requests', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      // Only a deep loop.
      record({
        requestId: 'loopy',
        ts: 1,
        sessionId: 's1',
        promptTokens: 20_000,
        credits: 40,
        rounds: Array.from({ length: 20 }, (_, r) => ({
          id: `l${String(r)}`,
          ts: 1,
          retries: 0,
          toolCalls: [],
        })),
      }),
      // Only an oversized payload.
      record({
        requestId: 'fat',
        ts: 2,
        sessionId: 's2',
        promptTokens: 20_000,
        credits: 40,
        rounds: [
          {
            id: 'f0',
            ts: 2,
            retries: 0,
            toolCalls: [{ id: 'fc', name: 'run_in_terminal', resultChars: 200_000 }],
          },
        ],
      }),
    ]);

    const both = buildSimulation(
      db,
      policyOf('version: 1\npayload:\n  max_result_tokens: 1000\nsession:\n  max_rounds: 5\n'),
      { now: NOW },
    );

    // No shared request, so there is nothing to over-claim and the joint
    // figure equals the sum. Overlap correction that fired here would be
    // subtracting money that was never double-counted.
    expect(both.overlapCredits).toBeCloseTo(0, 9);
    expect(both.combined.theoretical).toBeCloseTo(both.naiveSumCredits, 9);
  });

  /**
   * PLAN.md §20.1 combines levers as `1 − ∏(1 − tᵢ)` because, with only
   * marginal shares available, assuming independence is the best that can be
   * done. Here the per-request data is available, so the replay computes the
   * answer instead of approximating it. The formula is kept as a
   * cross-check, and the two should land in the same region.
   */
  it('agrees broadly with the multiplicative formula without depending on it', () => {
    const db = buildSimulationCorpus();
    const report = buildSimulation(
      db,
      policyOf(`
version: 1
payload:
  max_result_tokens: 1000
session:
  max_rounds: 10
  nudge_after_turns: 8
retrieval:
  dedupe_reads: true
`),
      { now: NOW },
    );

    expect(report.multiplicativeEstimateCredits).toBeGreaterThan(0);
    // Both are below the naive sum: that is the property the formula exists
    // to provide, and the replay provides it exactly.
    expect(report.multiplicativeEstimateCredits).toBeLessThan(report.naiveSumCredits);
    expect(report.combined.theoretical).toBeLessThan(report.naiveSumCredits);

    const divergence =
      Math.abs(report.combined.theoretical - report.multiplicativeEstimateCredits) /
      report.combined.theoretical;
    expect(divergence).toBeLessThan(0.5);
  });

  it('never claims more than the corpus actually cost', () => {
    const db = buildSimulationCorpus();
    const report = buildSimulation(
      db,
      policyOf(`
version: 1
model:
  route:
    - when: { complexity: low }
      to: model-cheap
payload:
  max_result_tokens: 100
session:
  max_rounds: 1
  nudge_after_turns: 1
retrieval:
  dedupe_reads: true
`),
      { now: NOW },
    );

    // Even with every lever set to its most aggressive, the joint replay
    // cannot exceed the baseline: each request's counterfactual is bounded
    // below by zero, so the saving is bounded above by what was spent.
    expect(report.combined.theoretical).toBeLessThanOrEqual(report.baselineCredits + 1e-9);
    expect(report.reduction.theoretical).toBeLessThanOrEqual(1);
  });
});
