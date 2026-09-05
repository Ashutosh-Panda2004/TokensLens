import { describe, expect, it } from 'vitest';

import {
  ADMISSIBLE_SURFACES,
  CLASS_TAXONOMY,
  MAX_CANDIDATES_PER_FINDING,
  taxonomyFor,
  toolFixableClasses,
} from '../src/advice/taxonomy.js';
import { CATALOGUE } from '../src/advice/catalogue.data.js';
import {
  MAX_MONTHS_SINCE_COMMIT,
  MAX_MONTHS_SINCE_RELEASE,
  MAX_MONTHS_SINCE_VERIFICATION,
  MIN_RECOMMENDED_ENTRIES,
  OMITTED_BY_DESIGN,
  catalogueDigest,
  catalogueReadiness,
  entryAdmissibility,
} from '../src/advice/catalogue.js';
import type { CatalogueEntry } from '../src/advice/catalogue.js';
import type { WasteClass } from '../src/waste/types.js';

/** Every temporal assertion is made against a fixed instant, never against the wall clock. */
const AS_OF = new Date('2026-08-02T00:00:00.000Z');

const ALL_CLASSES: readonly WasteClass[] = [
  'W1',
  'W2',
  'W3',
  'W4',
  'W5',
  'W6',
  'W7',
  'W8',
  'W9',
  'W10',
  'W11',
  'W12',
  'W13',
  'W14',
];

describe('advice taxonomy', () => {
  it('classifies every waste class exactly once', () => {
    const seen = CLASS_TAXONOMY.map((entry) => entry.class);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...ALL_CLASSES].sort());
  });

  it('gives every class a rationale, because an unexplained mapping rots', () => {
    for (const entry of CLASS_TAXONOMY) {
      expect(entry.rationale.length).toBeGreaterThan(40);
    }
  });

  it('attaches a residual model to exactly the tool-fixable classes', () => {
    for (const entry of CLASS_TAXONOMY) {
      if (entry.nature === 'residual-tool-fixable') {
        expect(entry.residual, `${entry.class} is tool-fixable but has no residual`).toBeDefined();
      } else {
        expect(
          entry.residual,
          `${entry.class} is ${entry.nature} but carries a residual model`,
        ).toBeUndefined();
      }
    }
  });

  it('describes both what the lever reaches and what survives it', () => {
    for (const entry of CLASS_TAXONOMY) {
      if (entry.residual === undefined) continue;
      expect(entry.residual.leverReaches.length).toBeGreaterThan(20);
      expect(entry.residual.residual.length).toBeGreaterThan(20);
      expect(entry.residual.mechanisms.length).toBeGreaterThan(0);
    }
  });

  it('gives every residual a probe, so the gate is a number rather than a hope', () => {
    // Without this, "only recommend against residual waste" is unfalsifiable:
    // every finding would produce a recommendation, including the corpus whose
    // entire finding is the part the tier-B guard already denies.
    const probes = CLASS_TAXONOMY.flatMap((entry) =>
      entry.residual === undefined ? [] : [entry.residual.probe],
    );
    expect(probes.length).toBe(toolFixableClasses().length);
    expect(new Set(probes).size).toBe(probes.length);
  });

  it('keeps the tool-fixable surface deliberately small', () => {
    // The finding, asserted. D12 added W8 and W11 by building their detectors;
    // the list grew because the evidence did, not because the catalogue felt
    // thin. Everything else is either already fixed, a habit, or has no
    // detector behind it. If this list grows again, a human decided it should.
    expect(toolFixableClasses()).toEqual(['W2', 'W3', 'W8', 'W11']);
  });

  it('gives a residual with no lever behind it the whole class as its residual', () => {
    // W8 and W11 have no D4 lever, so nothing is subtracted. That is the gating
    // rule applied honestly rather than a loophole in it — the probe still has
    // to fire, so "we have no lever" never becomes "therefore recommend
    // something".
    for (const entry of CLASS_TAXONOMY) {
      if (entry.residual === undefined || entry.residual.lever !== undefined) continue;
      expect(entry.residual.leverReaches).toMatch(/nothing/i);
      expect(entry.residual.residual).toMatch(/whole class/i);
    }
  });

  it('never marks a class both self-fixed and tool-fixable', () => {
    for (const wasteClass of ALL_CLASSES) {
      const entry = taxonomyFor(wasteClass);
      expect(['self-fixed', 'residual-tool-fixable', 'behaviour-fixable', 'dormant']).toContain(
        entry.nature,
      );
    }
  });

  it('excludes proxies and libraries from the admissible surfaces', () => {
    expect(ADMISSIBLE_SURFACES).not.toContain('proxy');
    expect(ADMISSIBLE_SURFACES).not.toContain('library');
  });
});

describe('advice catalogue — the inclusion bar, enforced rather than documented', () => {
  const offerable = CATALOGUE.filter((entry) => entry.status !== 'deprecated');

  it('has unique, stable, lower-kebab-case ids', () => {
    const ids = CATALOGUE.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('identifies every entry by a canonical https repository URL', () => {
    const repositories = CATALOGUE.map((entry) => entry.repository);
    expect(new Set(repositories).size).toBe(repositories.length);
    for (const repository of repositories) {
      expect(repository).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+$/);
    }
  });

  it('offers a tool only against a class the taxonomy calls tool-fixable', () => {
    const fixable = new Set<WasteClass>(toolFixableClasses());
    for (const entry of offerable) {
      expect(entry.addresses.length, `${entry.id} addresses nothing`).toBeGreaterThan(0);
      for (const wasteClass of entry.addresses) {
        expect(
          fixable.has(wasteClass),
          `${entry.id} claims ${wasteClass}, which TokenLens already fixes or which is a habit`,
        ).toBe(true);
      }
    }
  });

  it('offers a tool only through an admissible integration surface', () => {
    const admissible = new Set(ADMISSIBLE_SURFACES);
    for (const entry of offerable) {
      for (const surface of entry.surfaces) {
        expect(admissible.has(surface), `${entry.id} would reach the agent as a ${surface}`).toBe(
          true,
        );
      }
    }
  });

  it('offers only reversible installs', () => {
    for (const entry of offerable) {
      expect(entry.install.reversible, `${entry.id} cannot be undone`).toBe(true);
    }
  });

  it('requires a reason whenever an entry is not plainly recommended', () => {
    for (const entry of CATALOGUE) {
      if (entry.status === 'recommended') continue;
      expect(entry.statusReason, `${entry.id} is ${entry.status} without a reason`).toBeDefined();
      expect(entry.statusReason?.length ?? 0).toBeGreaterThan(40);
    }
  });

  it('promotes nothing to recommended without a named human behind it', () => {
    for (const entry of CATALOGUE) {
      if (entry.status !== 'recommended') continue;
      expect(entry.verification.source, `${entry.id} is recommended on unverified metadata`).toBe(
        'maintainer-verified',
      );
    }
  });

  it('records when every entry was last checked', () => {
    for (const entry of CATALOGUE) {
      expect(entry.verification.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.verification.checkedBy.length).toBeGreaterThan(0);
    }
  });

  it('records upstream activity as dates, because rule 2 is arithmetic', () => {
    // The first draft of this schema held prose here ("roughly a year ago"),
    // which meant the staleness rule could only be applied by a human re-reading
    // the sentence. That is a note, not a rule.
    for (const entry of CATALOGUE) {
      for (const activity of [
        entry.verification.upstreamLastCommit,
        entry.verification.upstreamLastRelease,
      ]) {
        if (activity === undefined) continue;
        expect(activity.date, `${entry.id} has an unparseable date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(['day', 'month']).toContain(activity.precision);
      }
    }
  });

  it('never records upstream activity dated after the day it was checked', () => {
    for (const entry of CATALOGUE) {
      for (const activity of [
        entry.verification.upstreamLastCommit,
        entry.verification.upstreamLastRelease,
      ]) {
        if (activity === undefined) continue;
        expect(
          activity.date <= entry.verification.checkedOn,
          `${entry.id} claims upstream activity after its own verification date`,
        ).toBe(true);
      }
    }
  });

  it('flags a local model requirement rather than burying it', () => {
    // Not a prohibition — a disclosure. An entry that downloads and runs a model
    // over the developer's prompts is a materially different ask, and it must be
    // impossible to omit.
    for (const entry of CATALOGUE) {
      expect(typeof entry.requiresLocalModel).toBe('boolean');
    }
    const modelBacked = CATALOGUE.filter((entry) => entry.requiresLocalModel);
    for (const entry of modelBacked) {
      expect(
        entry.status,
        `${entry.id} needs a local model and must not be offered without a caveat`,
      ).not.toBe('recommended');
    }
  });

  it('claims a percentage only where it measured one', () => {
    const claimsNumber = (entry: CatalogueEntry): boolean => /\d\s*%|\d+x\b/.test(entry.summary);
    for (const entry of CATALOGUE) {
      if (!claimsNumber(entry)) continue;
      expect(
        entry.evidence,
        `${entry.id} states a figure in its summary without having measured it`,
      ).toBe('measured-local');
    }
  });

  it('carries none of the fields omitted by design', () => {
    for (const entry of CATALOGUE) {
      for (const field of OMITTED_BY_DESIGN) {
        expect(Object.hasOwn(entry, field), `${entry.id} carries ${field}`).toBe(false);
      }
    }
  });

  it('keeps refused entries on the record instead of deleting them', () => {
    const deprecated = CATALOGUE.filter((entry) => entry.status === 'deprecated');
    expect(deprecated.length).toBeGreaterThan(0);
    for (const entry of deprecated) {
      expect(entry.addresses).toEqual([]);
      // Without this the refusal is unreachable: the engine could not say "the
      // obvious candidate here is X, and here is why it is not being offered".
      expect(
        entry.wouldAddress.length,
        `${entry.id} is refused but records nothing it would have addressed`,
      ).toBeGreaterThan(0);
    }
  });

  it('lets only refused entries carry a would-have-addressed list', () => {
    for (const entry of offerable) {
      expect(entry.wouldAddress, `${entry.id} is offerable and should simply address`).toEqual([]);
    }
  });

  it('stays within the size the taxonomy can justify', () => {
    // Two tool-fixable classes cannot justify a long list. If this cap is
    // raised, it should be because a detector came online, not because the
    // catalogue felt thin.
    expect(CATALOGUE.length).toBeLessThanOrEqual(25);
  });
});

describe('advice catalogue readiness', () => {
  /** Signs an entry off as of `AS_OF`, so freshness is not the thing under test. */
  function signOff(entry: CatalogueEntry): CatalogueEntry {
    return {
      ...entry,
      status: 'recommended',
      statusReason: undefined,
      verification: {
        ...entry.verification,
        checkedOn: '2026-08-01',
        checkedBy: 'a named human',
        source: 'maintainer-verified',
        upstreamLastCommit: { date: '2026-07-01', precision: 'day', tag: undefined },
        upstreamLastRelease: { date: '2026-07-01', precision: 'day', tag: 'v1.0.0' },
      },
    };
  }

  it('derives the floor from the offer cap rather than asserting a number', () => {
    // The floor exists because a class served by one entry has a single point of
    // failure. Deriving it means the number cannot drift away from that
    // reasoning: D12 built two more detectors, two more classes became
    // tool-fixable, and the bar the catalogue must clear rose by itself.
    expect(MIN_RECOMMENDED_ENTRIES).toBe(MAX_CANDIDATES_PER_FINDING * toolFixableClasses().length);
    expect(MIN_RECOMMENDED_ENTRIES).toBe(8);
  });

  /** Enough distinct signed-off entries to clear the floor, whatever it is today. */
  function signedOffFloor(): CatalogueEntry[] {
    const base = CATALOGUE.filter((entry) => entry.status !== 'deprecated').map(signOff);
    return Array.from({ length: MIN_RECOMMENDED_ENTRIES }, (_, index) => {
      const source = base[index % base.length];
      if (source === undefined) throw new Error('no offerable seed entries');
      return { ...source, id: `${source.id}-${String(index)}` };
    });
  }

  it('degrades to guidance-only until enough entries are signed off', () => {
    const readiness = catalogueReadiness(CATALOGUE, AS_OF);
    expect(readiness.recommended).toBeLessThan(MIN_RECOMMENDED_ENTRIES);
    expect(readiness.meetsFloor).toBe(false);
    expect(readiness.mode).toBe('guidance-only');
    expect(readiness.awaitingSignOff).toBeGreaterThan(0);
    expect(readiness.reason).toContain('sign-off');
  });

  it('switches to catalogue mode once the floor is met', () => {
    const readiness = catalogueReadiness(signedOffFloor(), AS_OF);
    expect(readiness.recommended).toBe(MIN_RECOMMENDED_ENTRIES);
    expect(readiness.meetsFloor).toBe(true);
    expect(readiness.mode).toBe('catalogue');
  });

  it('stops counting a sign-off that has aged out', () => {
    // The catalogue is compiled into a binary, and a binary outlives its build.
    // A run two years later must not be handed entries verified against a world
    // that no longer exists, stated with the confidence they had on the day.
    const muchLater = new Date('2028-08-02T00:00:00.000Z');
    const readiness = catalogueReadiness(signedOffFloor(), muchLater);

    expect(readiness.recommended).toBe(0);
    expect(readiness.staleRecommended).toBe(MIN_RECOMMENDED_ENTRIES);
    expect(readiness.mode).toBe('guidance-only');
    expect(readiness.reason).toContain('freshness');
  });

  it('counts deprecated entries without ever offering them', () => {
    const readiness = catalogueReadiness(CATALOGUE, AS_OF);
    expect(readiness.deprecated).toBeGreaterThan(0);
    expect(readiness.recommended + readiness.deprecated).toBeLessThanOrEqual(CATALOGUE.length);
  });
});

describe('advice entry admissibility — the temporal half of the inclusion bar', () => {
  const base = CATALOGUE.find((entry) => entry.id === 'serena');

  function entryWith(overrides: Partial<CatalogueEntry['verification']>): CatalogueEntry {
    if (base === undefined) throw new Error('seed entry missing');
    return {
      ...base,
      status: 'recommended',
      statusReason: undefined,
      verification: {
        checkedOn: '2026-08-01',
        checkedBy: 'a named human',
        source: 'maintainer-verified',
        upstreamLastCommit: { date: '2026-07-01', precision: 'day', tag: undefined },
        upstreamLastRelease: { date: '2026-07-01', precision: 'day', tag: 'v1.0.0' },
        ...overrides,
      },
    };
  }

  it('admits a signed-off, current entry', () => {
    expect(entryAdmissibility(entryWith({}), AS_OF).offerable).toBe(true);
  });

  it('refuses anything no named human has signed off', () => {
    const result = entryAdmissibility(entryWith({ source: 'primary-fetch' }), AS_OF);
    expect(result.offerable).toBe(false);
    expect(result.blockers.join(' ')).toContain('named human');
  });

  it('refuses an entry whose upstream has gone quiet', () => {
    const result = entryAdmissibility(
      entryWith({ upstreamLastCommit: { date: '2025-01-01', precision: 'day', tag: undefined } }),
      AS_OF,
    );
    expect(result.offerable).toBe(false);
    expect(result.breaches.map((breach) => breach.rule)).toContain('commit');
    expect(result.breaches[0]?.limit).toBe(MAX_MONTHS_SINCE_COMMIT);
  });

  it('refuses an entry that has never cut a release', () => {
    const result = entryAdmissibility(entryWith({ upstreamLastRelease: undefined }), AS_OF);
    expect(result.offerable).toBe(false);
    expect(result.blockers.join(' ')).toContain('never published a release');
  });

  it('treats a release older than the limit as a breach', () => {
    const result = entryAdmissibility(
      entryWith({ upstreamLastRelease: { date: '2024-01-01', precision: 'day', tag: 'v0.1' } }),
      AS_OF,
    );
    const release = result.breaches.find((breach) => breach.rule === 'release');
    expect(release?.limit).toBe(MAX_MONTHS_SINCE_RELEASE);
    expect(release?.months).toBeGreaterThan(MAX_MONTHS_SINCE_RELEASE);
  });

  it('marks freshness derived from a month-precision date as approximate', () => {
    // A date read as \"roughly a year ago\" must not be quoted back as a day
    // nobody observed.
    const result = entryAdmissibility(
      entryWith({ upstreamLastCommit: { date: '2024-01-01', precision: 'month', tag: undefined } }),
      AS_OF,
    );
    const commit = result.breaches.find((breach) => breach.rule === 'commit');
    expect(commit?.approximate).toBe(true);
    expect(commit?.text).toContain('approximately');
  });

  it('ages a sign-off out on the verification rule alone', () => {
    // Nothing upstream has gone wrong here: the commit and release are current
    // for their own dates. What has expired is the human's attention.
    const result = entryAdmissibility(entryWith({}), new Date('2027-08-01T00:00:00.000Z'));
    const verification = result.breaches.find((breach) => breach.rule === 'verification');
    expect(verification?.limit).toBe(MAX_MONTHS_SINCE_VERIFICATION);
    expect(result.offerable).toBe(false);
  });

  it('never admits a deprecated entry, whatever its dates say', () => {
    for (const entry of CATALOGUE.filter((candidate) => candidate.status === 'deprecated')) {
      expect(entryAdmissibility(entry, AS_OF).offerable).toBe(false);
    }
  });

  it('reports every blocker rather than stopping at the first', () => {
    const result = entryAdmissibility(
      entryWith({
        source: 'reported-unverified',
        upstreamLastCommit: { date: '2023-01-01', precision: 'day', tag: undefined },
        upstreamLastRelease: undefined,
      }),
      AS_OF,
    );
    expect(result.blockers.length).toBeGreaterThanOrEqual(3);
  });
});

describe('advice catalogue digest', () => {
  it('is stable across reordering, because a set has no order', () => {
    expect(catalogueDigest([...CATALOGUE].reverse())).toBe(catalogueDigest(CATALOGUE));
  });

  it('ignores prose, so rewording a summary cannot void an evaluation', () => {
    const reworded = CATALOGUE.map((entry) => ({ ...entry, summary: `${entry.summary} (edited)` }));
    expect(catalogueDigest(reworded)).toBe(catalogueDigest(CATALOGUE));
  });

  it('changes when a decision-bearing field changes', () => {
    const first = CATALOGUE[0];
    if (first === undefined) throw new Error('catalogue is empty');
    const altered = [
      { ...first, install: { ...first.install, command: 'curl | sh' } },
      ...CATALOGUE.slice(1),
    ];
    expect(catalogueDigest(altered)).not.toBe(catalogueDigest(CATALOGUE));
  });
});
