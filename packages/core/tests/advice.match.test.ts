import { describe, expect, it } from 'vitest';
import { matchAdvice } from '../src/advice/match.js';
import { MAX_CANDIDATES_PER_FINDING, toolFixableClasses } from '../src/advice/taxonomy.js';
import { CATALOGUE } from '../src/advice/catalogue.data.js';
import { modelled } from '../src/model/provenance.js';
import type { CatalogueEntry } from '../src/advice/catalogue.js';
import type { ResidualSignal } from '../src/advice/residual.js';
import type { WasteClass, WasteFinding } from '../src/waste/types.js';

/**
 * The residual gate, tested as behaviour rather than as prose.
 *
 * Every one of these cases is a way the feature could quietly become a shop
 * window: recommending against a class TokenLens already fixes, recommending on
 * a sample too thin to mean anything, recommending while the catalogue is below
 * its floor, or recommending an entry whose sign-off expired two years ago.
 */

const AS_OF = new Date('2026-08-02T00:00:00.000Z');

function finding(wasteClass: WasteClass): WasteFinding {
  return {
    class: wasteClass,
    title: `${wasteClass} finding`,
    credits: modelled(100, 'test fixture', ['synthetic']),
    confidence: 0.5,
    evidence: [],
    remediation: { summary: 'x', tier: 'B', action: 'y' },
  };
}

function signal(wasteClass: WasteClass, overrides: Partial<ResidualSignal> = {}): ResidualSignal {
  const value = overrides.value ?? 0.6;
  const threshold = overrides.threshold ?? 0.35;
  const sampleSize = overrides.sampleSize ?? 100;
  const minimumSample = overrides.minimumSample ?? 30;
  const sufficientSample = overrides.sufficientSample ?? sampleSize >= minimumSample;

  return {
    class: wasteClass,
    probe: wasteClass === 'W2' ? 'w2-whole-file-first-reads' : 'w3-sub-cap-oversize',
    label: 'test residual',
    unit: 'share',
    value,
    threshold,
    sampleSize,
    minimumSample,
    sufficientSample,
    exceeded: sufficientSample && value > threshold,
    basis: 'test',
    detail: 'test',
    ...overrides,
  };
}

/** A catalogue entry that would genuinely be offered, so tests vary one thing at a time. */
function offerable(overrides: Partial<CatalogueEntry> = {}): CatalogueEntry {
  return {
    id: 'alpha',
    name: 'Alpha',
    repository: 'https://github.com/example/alpha',
    summary: 'Returns a symbol rather than a file.',
    licence: 'MIT',
    mechanisms: ['symbol-scoped-retrieval'],
    surfaces: ['mcp-server'],
    addresses: ['W2'],
    wouldAddress: [],
    install: { command: 'npx alpha', complexity: 'one-line', reversible: true },
    requiresLocalModel: false,
    status: 'recommended',
    statusReason: undefined,
    evidence: 'mechanism',
    verification: {
      checkedOn: '2026-08-01',
      checkedBy: 'a named human',
      upstreamLastCommit: { date: '2026-07-20', precision: 'day', tag: undefined },
      upstreamLastRelease: { date: '2026-07-20', precision: 'day', tag: 'v2.0.0' },
      source: 'maintainer-verified',
    },
    ...overrides,
  };
}

function match(input: {
  findings?: readonly WasteFinding[];
  signals?: readonly ResidualSignal[];
  catalogue?: readonly CatalogueEntry[];
  mode?: 'catalogue' | 'guidance-only';
  asOf?: Date;
}): ReturnType<typeof matchAdvice> {
  return matchAdvice({
    findings: input.findings ?? [finding('W2')],
    signals: input.signals ?? [signal('W2'), signal('W3', { value: 0 })],
    catalogue: input.catalogue ?? [offerable()],
    mode: input.mode ?? 'catalogue',
    asOf: input.asOf ?? AS_OF,
  });
}

describe('residual gating', () => {
  it('offers a tool when a finding, a residual and an admissible entry all line up', () => {
    const result = match({});
    expect(result.offers.map((offer) => offer.entry.id)).toEqual(['alpha']);
    expect(result.offers[0]?.class).toBe('W2');
    expect(result.offers[0]?.rank).toBe(1);
  });

  it('offers nothing for a class TokenLens already fixes itself', () => {
    const result = match({ findings: [finding('W1'), finding('W5'), finding('W6')] });
    expect(result.offers).toEqual([]);
    for (const wasteClass of ['W1', 'W5', 'W6'] as const) {
      const silence = result.silences.find((item) => item.class === wasteClass);
      expect(silence?.code).toBe('self-fixed');
    }
  });

  it('offers guidance rather than a dependency for a habit', () => {
    const result = match({ findings: [finding('W4'), finding('W9')] });
    expect(result.offers).toEqual([]);
    expect(result.behaviour.map((item) => item.class).sort()).toEqual(['W4', 'W9']);
    expect(result.silences.find((item) => item.class === 'W4')?.code).toBe('behaviour-fixable');
  });

  it('stays silent when the residual is below its threshold', () => {
    // The whole point of the gate. A finding is not a licence to recommend:
    // if the lever already reached the waste, the dependency earns nothing.
    const result = match({ signals: [signal('W2', { value: 0.05 })] });
    expect(result.offers).toEqual([]);
    const silence = result.silences.find((item) => item.class === 'W2');
    expect(silence?.code).toBe('residual-below-threshold');
    expect(silence?.reason).toContain('dedupe-reads');
  });

  it('stays silent when the sample is too thin to judge', () => {
    const result = match({ signals: [signal('W2', { sampleSize: 4, sufficientSample: false })] });
    expect(result.offers).toEqual([]);
    expect(result.silences.find((item) => item.class === 'W2')?.code).toBe('insufficient-sample');
  });

  it('stays silent when the class produced no finding at all', () => {
    const result = match({ findings: [] });
    expect(result.offers).toEqual([]);
    expect(result.silences.find((item) => item.class === 'W2')?.code).toBe('no-finding');
  });

  it('names no tool while the catalogue is below its floor', () => {
    const result = match({ mode: 'guidance-only' });
    expect(result.offers).toEqual([]);
    expect(result.silences.find((item) => item.class === 'W2')?.code).toBe('guidance-only');
    // Degraded, not silent: the mechanism is still described.
    expect(result.mechanisms.map((item) => item.mechanism)).toContain('symbol-scoped-retrieval');
  });

  it('describes the mechanism whenever a residual is present', () => {
    const result = match({});
    const mechanisms = result.mechanisms.filter((item) => item.class === 'W2');
    expect(mechanisms.length).toBeGreaterThan(0);
    for (const suggestion of mechanisms) {
      expect(suggestion.headline.length).toBeGreaterThan(10);
      expect(suggestion.howYouWouldKnow.length).toBeGreaterThan(20);
    }
  });

  it('accounts for every waste class exactly once', () => {
    // A class missing from the output is indistinguishable from a class the
    // engine forgot about.
    const result = match({});
    const covered = new Set([
      ...result.offers.map((offer) => offer.class),
      ...result.silences.map((item) => item.class),
    ]);
    expect(covered.size).toBe(14);
  });
});

describe('admissibility at match time', () => {
  it('refuses an entry no named human signed off', () => {
    const result = match({
      catalogue: [
        offerable({
          verification: { ...offerable().verification, source: 'primary-fetch' },
        }),
      ],
    });
    expect(result.offers).toEqual([]);
    expect(result.silences.find((item) => item.class === 'W2')?.code).toBe('no-admissible-entry');
  });

  it('refuses an entry whose sign-off has aged out, however good it was', () => {
    const result = match({ asOf: new Date('2029-01-01T00:00:00.000Z') });
    expect(result.offers).toEqual([]);
    expect(result.silences.find((item) => item.class === 'W2')?.code).toBe('no-admissible-entry');
  });
});

describe('ordering', () => {
  it('never lets a caveated entry outrank an uncaveated one', () => {
    const result = match({
      catalogue: [
        offerable({ id: 'caution-one', status: 'caution', statusReason: 'a stated caveat' }),
        offerable({ id: 'clean-one' }),
      ],
    });
    expect(result.offers.map((offer) => offer.entry.id)).toEqual(['clean-one', 'caution-one']);
  });

  it('prefers a measured claim to an upstream one', () => {
    const result = match({
      catalogue: [
        offerable({ id: 'claimed', evidence: 'upstream-claim' }),
        offerable({ id: 'measured', evidence: 'measured-local' }),
      ],
    });
    expect(result.offers[0]?.entry.id).toBe('measured');
  });

  it('prefers the entry covering more of the residual’s mechanisms', () => {
    const result = match({
      catalogue: [
        offerable({ id: 'partial', mechanisms: ['symbol-scoped-retrieval'] }),
        offerable({ id: 'full', mechanisms: ['symbol-scoped-retrieval', 'deterministic-cache'] }),
      ],
    });
    expect(result.offers[0]?.entry.id).toBe('full');
  });

  it('prefers the cheaper install between otherwise equal answers', () => {
    const result = match({
      catalogue: [
        offerable({
          id: 'fiddly',
          install: { command: 'x', complexity: 'multi-step', reversible: true },
        }),
        offerable({
          id: 'easy',
          install: { command: 'y', complexity: 'one-line', reversible: true },
        }),
      ],
    });
    expect(result.offers[0]?.entry.id).toBe('easy');
  });

  it('places an entry that needs a local model last among equals', () => {
    const result = match({
      catalogue: [
        offerable({
          id: 'model-backed',
          requiresLocalModel: true,
          status: 'caution',
          statusReason: 'needs a model',
        }),
        offerable({ id: 'plain' }),
      ],
    });
    expect(result.offers[0]?.entry.id).toBe('plain');
  });

  it('is deterministic, so the same corpus always produces the same output', () => {
    const catalogue = [offerable({ id: 'bravo' }), offerable({ id: 'alpha' })];
    const first = match({ catalogue }).offers.map((offer) => offer.entry.id);
    const second = match({ catalogue: [...catalogue].reverse() }).offers.map(
      (offer) => offer.entry.id,
    );
    expect(first).toEqual(second);
    expect(first).toEqual(['alpha', 'bravo']);
  });

  it('names no more candidates than the cap the catalogue floor is derived from', () => {
    const catalogue = ['a', 'b', 'c', 'd', 'e'].map((id) => offerable({ id }));
    const result = match({ catalogue });
    expect(result.offers.length).toBe(MAX_CANDIDATES_PER_FINDING);
  });
});

describe('offers carry their caveats', () => {
  it('attaches the stated reason of a caution entry', () => {
    const result = match({
      catalogue: [offerable({ status: 'caution', statusReason: 'the install pulls a toolchain' })],
    });
    expect(result.offers[0]?.caveats).toContain('the install pulls a toolchain');
  });

  it('never hides a local model requirement', () => {
    const result = match({
      catalogue: [
        offerable({ requiresLocalModel: true, status: 'caution', statusReason: 'model-backed' }),
      ],
    });
    expect(result.offers[0]?.caveats.join(' ')).toContain('reading your prompts');
  });

  it('explains its placement in words that can be re-derived from the entry', () => {
    const result = match({});
    const why = result.offers[0]?.why ?? [];
    expect(why.length).toBeGreaterThanOrEqual(3);
    expect(why.join(' ')).toContain('mcp-server');
    expect(why.join(' ')).toContain('MIT');
  });
});

describe('refusal by name', () => {
  it('names the obvious candidate it is declining, using the real catalogue', () => {
    // RouteLLM is the best-known open-source router and the obvious answer for
    // W5. Saying nothing about it would read as ignorance or evasion.
    const result = match({ findings: [finding('W5')], catalogue: CATALOGUE });
    const refusal = result.refusals.find((item) => item.entry.id === 'routellm');
    expect(refusal?.class).toBe('W5');
    expect(refusal?.reason).toContain('proxy');
  });

  it('never offers a refused entry, only refuses it', () => {
    const result = match({ findings: [finding('W2'), finding('W5')], catalogue: CATALOGUE });
    const offeredIds = new Set(result.offers.map((offer) => offer.entry.id));
    for (const refusal of result.refusals) {
      expect(offeredIds.has(refusal.entry.id)).toBe(false);
    }
  });
});

describe('the shipped catalogue, matched against a corpus with real residuals', () => {
  it('names nothing today, because nothing in it is signed off', () => {
    const result = match({
      findings: toolFixableClasses().map(finding),
      signals: toolFixableClasses().map((wasteClass) => signal(wasteClass)),
      catalogue: CATALOGUE,
      mode: 'guidance-only',
    });

    expect(result.offers).toEqual([]);
    // And yet the run is not empty: the mechanisms are still described.
    expect(result.mechanisms.length).toBeGreaterThan(0);
  });
});
