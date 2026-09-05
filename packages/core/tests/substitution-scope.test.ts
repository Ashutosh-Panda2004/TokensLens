import { describe, it, expect } from 'vitest';
import { buildSubstitutionAdvice } from '../src/ledger/substitution.js';
import { resolveScope, describeScope } from '../src/scope/resolve.js';
import { measured, modelled } from '../src/model/provenance.js';
import type { LedgerSummary } from '../src/ledger/ledger.js';
import type { ModelRate } from '../src/ledger/rate-card.js';
import type { WorkspaceLocation } from '../src/scope/types.js';

function rate(model: string, creditsPerKPromptToken: number, isMeasured: boolean): ModelRate {
  return {
    model,
    creditsPerKPromptToken,
    sampleSize: isMeasured ? 20 : 0,
    provenance: isMeasured
      ? measured(creditsPerKPromptToken, 'test').provenance
      : modelled(creditsPerKPromptToken, 'test', []).provenance,
  };
}

function ledgerWith(
  models: readonly { model: string; credits: number; requests: number }[],
  rateCard: readonly ModelRate[],
): LedgerSummary {
  return {
    totalCredits: models.reduce((sum, entry) => sum + entry.credits, 0),
    measuredCredits: models.reduce((sum, entry) => sum + entry.credits, 0),
    modelledCredits: 0,
    requestCount: models.reduce((sum, entry) => sum + entry.requests, 0),
    byDay: [],
    byModel: models.map((entry) => ({
      model: entry.model,
      credits: entry.credits,
      measuredCredits: entry.credits,
      modelledCredits: 0,
      requestCount: entry.requests,
      rate: measured(0, 'test'),
    })),
    bySession: [],
    byCostCentre: [],
    rateCard,
  } as unknown as LedgerSummary;
}

describe('buildSubstitutionAdvice', () => {
  it('prices a swap by the ratio of the two measured rates', () => {
    const advice = buildSubstitutionAdvice(
      ledgerWith(
        [{ model: 'expensive', credits: 1000, requests: 10 }],
        [rate('expensive', 10, true), rate('cheap', 1, true)],
      ),
    );

    expect(advice.substitutions).toHaveLength(1);
    expect(advice.substitutions[0]?.to).toBe('cheap');
    expect(advice.substitutions[0]?.substitutedCredits).toBeCloseTo(100, 6);
    expect(advice.substitutions[0]?.savedCredits).toBeCloseTo(900, 6);
    expect(advice.substitutions[0]?.savedUsd).toBeCloseTo(9, 6);
  });

  it('refuses to price against a rate that was never measured here', () => {
    // Pricing one estimate against another compounds two guesses into a
    // single confident-looking number.
    const advice = buildSubstitutionAdvice(
      ledgerWith(
        [{ model: 'expensive', credits: 1000, requests: 10 }],
        [rate('expensive', 10, true), rate('never-billed', 1, false)],
      ),
    );

    expect(advice.substitutions).toHaveLength(0);
    expect(advice.totalSavedUsd).toBe(0);
  });

  it('never suggests swapping a model for itself or for something dearer', () => {
    const advice = buildSubstitutionAdvice(
      ledgerWith(
        [
          { model: 'cheap', credits: 100, requests: 5 },
          { model: 'dear', credits: 900, requests: 5 },
        ],
        [rate('cheap', 1, true), rate('dear', 10, true)],
      ),
    );

    expect(advice.substitutions.map((entry) => entry.from)).toEqual(['dear']);
  });

  it('ranks by saving, so the largest lever is first', () => {
    const advice = buildSubstitutionAdvice(
      ledgerWith(
        [
          { model: 'a', credits: 100, requests: 1 },
          { model: 'b', credits: 5000, requests: 1 },
        ],
        [rate('a', 10, true), rate('b', 10, true), rate('cheap', 1, true)],
      ),
    );

    expect(advice.substitutions[0]?.from).toBe('b');
  });

  it('states the counterfactual rather than presenting a saving as a fact', () => {
    const advice = buildSubstitutionAdvice(
      ledgerWith([{ model: 'x', credits: 10, requests: 1 }], [rate('x', 1, true)]),
    );
    expect(advice.caveats.join(' ')).toMatch(/counterfactual/i);
  });

  it('declares the window it covers, so it cannot be read against the month figure', () => {
    // The HUD headline is month-to-date and this is all-time; two figures
    // that look comparable and are not is the same defect as an unlabelled
    // scope.
    const advice = buildSubstitutionAdvice(
      ledgerWith([{ model: 'x', credits: 10, requests: 1 }], [rate('x', 1, true)]),
    );
    expect(advice.window).toBe('all-time');
    expect(advice.caveats.join(' ')).toMatch(/not just this month/i);
  });

  it('reports the auto-selection discount as a value, not as a missing saving', () => {
    const advice = buildSubstitutionAdvice(
      ledgerWith([{ model: 'x', credits: 1000, requests: 1 }], [rate('x', 1, true)]),
    );
    expect(advice.autoSelectionDiscountUsd).toBeCloseTo(1, 6);
    expect(advice.caveats.join(' ')).toMatch(/cannot tell/i);
  });
});

describe('multi-root scope', () => {
  const locations: WorkspaceLocation[] = [
    { workspaceId: 'w1', canonicalPath: '/repos/alpha', displayPath: '/repos/alpha' },
    { workspaceId: 'w2', canonicalPath: '/repos/beta', displayPath: '/repos/beta' },
    { workspaceId: 'w3', canonicalPath: '/repos/gamma', displayPath: '/repos/gamma' },
  ];

  it('selects every workspace under any of the anchors', async () => {
    const scope = await resolveScope({
      mode: 'folder',
      at: ['/repos/alpha', '/repos/beta'],
      locations,
    });

    expect(scope.matchedWorkspaceCount).toBe(2);
    expect([...(scope.workspaceIds ?? [])].sort()).toEqual(['w1', 'w2']);
  });

  it('still accepts a single anchor as a plain string', async () => {
    const scope = await resolveScope({ mode: 'folder', at: '/repos/alpha', locations });
    expect([...(scope.workspaceIds ?? [])]).toEqual(['w1']);
    expect(scope.rootDisplayPaths).toBeUndefined();
  });

  it('describes several anchors as folders rather than naming only the first', async () => {
    // Naming one folder while reporting three would understate the workspace
    // in exactly the way the scope work exists to prevent.
    const scope = await resolveScope({
      mode: 'folder',
      at: ['/repos/alpha', '/repos/beta'],
      locations,
    });

    expect(describeScope(scope)).toContain('2 folders');
    expect(scope.rootDisplayPaths).toEqual(['/repos/alpha', '/repos/beta']);
  });

  it('ignores blank anchors rather than matching everything', async () => {
    const scope = await resolveScope({ mode: 'folder', at: ['/repos/alpha', '  '], locations });
    expect(scope.matchedWorkspaceCount).toBe(1);
  });
});
