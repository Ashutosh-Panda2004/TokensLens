import { describe, expect, it } from 'vitest';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { buildDetectContext } from '../src/waste/context.js';
import { buildWasteReport } from '../src/waste/report.js';
import { buildGitSurvival, survivedAfter, SETTLING_WINDOW_MS } from '../src/waste/git-survival.js';
import { conditionallyUnavailable, UNAVAILABLE_CLASSES } from '../src/waste/registry.js';
import {
  AbandonedWorkDetector,
  assessSurvivalCoverage,
} from '../src/waste/detectors/w7-abandoned-work.js';
import {
  ReferenceLeakageDetector,
  assessReferencePricing,
} from '../src/waste/detectors/w11-reference-leakage.js';
import { InstructionBloatDetector } from '../src/waste/detectors/w10-instruction-bloat.js';
import { UtilityModelDriftDetector } from '../src/waste/detectors/w12-utility-model-drift.js';
import { CrossDeveloperDuplicationDetector } from '../src/waste/detectors/w8-cross-dev-duplication.js';
import { detectDuplication } from '../src/org/duplication.js';
import { MIN_GROUP_SIZE } from '../src/privacy/scope.js';
import type Database from 'better-sqlite3';
import type { CommitRecord } from '../src/outcomes/git.js';
import type { QuestionObservation } from '../src/org/duplication.js';
import type { CostCentre, TurnRecord } from '../src/model/turn-record.js';
import type { DetectContextInputs } from '../src/waste/context.js';

/**
 * D12 — the five classes D3 declared undetectable.
 *
 * Each detector here is charging something a previous phase said could not be
 * seen, so each gets the same treatment: a case where it fires, and at least one
 * case where it is *tempted* to fire and must not. The second kind matters more.
 * A detector that only has tests for finding things will find things.
 */

const COMMIT_LATE = 1_000_000_000;

function centres(promptTokens: number, extra: readonly CostCentre[] = []): CostCentre[] {
  return [
    {
      category: 'System',
      label: 'Tool Definitions',
      percentageOfPrompt: 20,
      tokens: Math.round(promptTokens * 0.2),
    },
    ...extra,
  ];
}

function record(overrides: Partial<TurnRecord> & Pick<TurnRecord, 'requestId' | 'ts'>): TurnRecord {
  const promptTokens = overrides.promptTokens ?? 10_000;
  return {
    sessionId: 'session-a',
    model: 'model-cheap',
    promptTokens,
    outputTokens: 200,
    costCentres: centres(promptTokens),
    rounds: [],
    edits: [],
    compactions: [],
    contentReferences: [],
    turnIndex: 0,
    source: { file: 'f', offset: 0 },
    ...overrides,
  };
}

function save(records: readonly TurnRecord[]): Database.Database {
  const db = openDatabase(':memory:');
  saveTurnRecords(db, records);
  return db;
}

/**
 * One request carrying a real credit figure.
 *
 * Without a single measured price anywhere in the corpus the rate card has
 * nothing to blend and every credit figure is legitimately zero — which would
 * make these tests pass or fail for a reason that has nothing to do with the
 * detector under test.
 */
const PRICED_ANCHOR = record({ requestId: 'rate-anchor', ts: 1, credits: 5 });

function commit(ts: number, files: readonly string[], isMerge = false): CommitRecord {
  return {
    sha: String(ts).padStart(40, '0'),
    authorId: 'dev-1',
    ts,
    parents: [],
    isMerge,
    files: files.map((pathHash) => ({ pathHash, extension: 'ts', added: 1, deleted: 0 })),
  };
}

// ---------------------------------------------------------------------------
// W7 · Abandoned work
// ---------------------------------------------------------------------------

interface W7Shape {
  readonly abandoned: number;
  readonly kept: number;
  readonly untracked?: number;
  /** Requests placed inside the settling window at the end of the observed period. */
  readonly recent?: number;
}

function w7Corpus(shape: W7Shape): { db: Database.Database; inputs: DetectContextInputs } {
  const records: TurnRecord[] = [PRICED_ANCHOR];
  const push = (id: string, ts: number, fileHash: string): void => {
    records.push(
      record({
        requestId: id,
        ts,
        sessionId: `s-${id}`,
        edits: [{ fileHash, editCount: 1, done: true }],
      }),
    );
  };

  for (let i = 0; i < shape.abandoned; i++)
    push(`ab-${String(i)}`, 1_000 + i, `stale-${String(i)}`);
  for (let i = 0; i < shape.kept; i++) push(`kept-${String(i)}`, 2_000 + i, `kept-${String(i)}`);
  for (let i = 0; i < (shape.untracked ?? 0); i++) {
    push(`ig-${String(i)}`, 3_000 + i, `ignored-${String(i)}`);
  }
  for (let i = 0; i < (shape.recent ?? 0); i++) {
    push(`new-${String(i)}`, COMMIT_LATE - 1_000, `stale-recent-${String(i)}`);
  }

  const commits = [
    // Tracked, but last touched long before the agent edited them.
    commit(
      1,
      Array.from({ length: shape.abandoned }, (_, i) => `stale-${String(i)}`).concat(
        Array.from({ length: shape.recent ?? 0 }, (_, i) => `stale-recent-${String(i)}`),
      ),
    ),
    commit(
      COMMIT_LATE,
      Array.from({ length: shape.kept }, (_, i) => `kept-${String(i)}`),
    ),
  ];

  return { db: save(records), inputs: { git: buildGitSurvival(commits) } };
}

describe('W7 · abandoned work', () => {
  const detector = new AbandonedWorkDetector();

  it('charges requests whose every tracked edit was never committed', () => {
    const { db, inputs } = w7Corpus({ abandoned: 20, kept: 20 });
    const findings = detector.detect(buildDetectContext(db, inputs));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.credits.value).toBeGreaterThan(0);
    expect(findings[0]?.title).toContain('50.0%');
    expect(findings[0]?.remediation.tier).toBe('C');
  });

  it('does not charge an edit that reached a commit afterwards', () => {
    const { db, inputs } = w7Corpus({ abandoned: 0, kept: 40 });
    expect(detector.detect(buildDetectContext(db, inputs))).toEqual([]);
  });

  it('excludes files git has never committed, so .gitignore is not a waste finding', () => {
    // 20 abandoned, 20 kept, 40 targeting files git has never seen. If the
    // untracked ones counted, the rate would read 75% rather than 50% — and a
    // build directory would be the most expensive thing in the report.
    const { db, inputs } = w7Corpus({ abandoned: 20, kept: 20, untracked: 40 });
    const finding = detector.detect(buildDetectContext(db, inputs))[0];

    expect(finding?.title).toContain('50.0%');
    const untracked = finding?.evidence.find((item) => item.ref === 'UNTRACKED');
    expect(untracked?.detail).toContain('40');
  });

  it('does not judge work inside the settling window', () => {
    // Recent edits target files that would score as abandoned. They must be
    // held back: work from ten minutes ago has not failed, it is unfinished.
    const { db, inputs } = w7Corpus({ abandoned: 20, kept: 20, recent: 20 });
    const finding = detector.detect(buildDetectContext(db, inputs))[0];

    expect(finding?.title).toContain('50.0%');
    const settling = finding?.evidence.find((item) => item.ref === 'SETTLING');
    expect(settling?.detail).toContain('20');
    expect(settling?.detail).toContain(String(SETTLING_WINDOW_MS / 3_600_000));
  });

  it('abstains when no commit history was supplied', () => {
    const { db } = w7Corpus({ abandoned: 20, kept: 20 });
    expect(detector.detect(buildDetectContext(db))).toEqual([]);
  });

  it('abstains when the history covers too few of the edited files to judge', () => {
    const { db, inputs } = w7Corpus({ abandoned: 20, kept: 5, untracked: 200 });
    expect(detector.detect(buildDetectContext(db, inputs))).toEqual([]);
  });

  it('says why it abstained rather than reading as an absence of waste', () => {
    // The corpus this was first run against had a perfect join — 189 of 191
    // committed files matched an edit — and W7 still declined, because most of
    // the edited files lived in directories the repository does not contain.
    // Silence there is indistinguishable from "no abandoned work", which is the
    // opposite conclusion.
    const { db, inputs } = w7Corpus({ abandoned: 20, kept: 5, untracked: 200 });
    const ctx = buildDetectContext(db, inputs);

    const coverage = assessSurvivalCoverage(ctx);
    expect(coverage?.sufficient).toBe(false);
    expect(coverage?.untrackedFiles).toBe(200);

    const conditional = conditionallyUnavailable(ctx);
    const w7 = conditional.find((item) => item.class === 'W7');
    expect(w7?.reason).toContain('Commit history was read');
    expect(w7?.reason).toContain('%');
  });
});

describe('git survival index', () => {
  it('treats only a commit at or after the edit as survival', () => {
    const survival = buildGitSurvival([commit(100, ['f'])]);
    expect(survivedAfter(survival, 'f', 100)).toBe(true);
    expect(survivedAfter(survival, 'f', 101)).toBe(false);
    expect(survivedAfter(survival, 'unknown', 1)).toBe(false);
  });

  it('ignores merge commits, which carry no diff of their own', () => {
    const survival = buildGitSurvival([commit(100, ['f'], true)]);
    expect(survival.commitCount).toBe(0);
    expect(survivedAfter(survival, 'f', 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W11 · Search-snippet leakage
// ---------------------------------------------------------------------------

function w11Corpus(options: {
  readonly requests: number;
  readonly openFirstReference: boolean;
  readonly filesTokens?: number;
  /** Opens the reference on a *later* request in the same session. */
  readonly openLate?: boolean;
}): Database.Database {
  const records: TurnRecord[] = [PRICED_ANCHOR];

  for (let i = 0; i < options.requests; i++) {
    const filesTokens = options.filesTokens ?? 1_000;
    const sessionId = options.openLate === true ? 'shared-session' : `s-ref-${String(i)}`;
    records.push(
      record({
        requestId: `ref-${String(i)}`,
        ts: 1_000 + i,
        sessionId,
        turnIndex: i,
        costCentres: centres(
          10_000,
          filesTokens > 0
            ? [
                {
                  category: 'User Context',
                  label: 'Files',
                  percentageOfPrompt: 10,
                  tokens: filesTokens,
                },
              ]
            : [],
        ),
        contentReferences: [{ fileHash: `ref-${String(i)}-a` }, { fileHash: `ref-${String(i)}-b` }],
        rounds: options.openFirstReference
          ? [
              {
                id: `r-${String(i)}`,
                ts: 1_000 + i,
                retries: 0,
                toolCalls: [
                  {
                    id: `c-${String(i)}`,
                    name: 'read_file',
                    resultChars: 400,
                    targetFileHash: `ref-${String(i)}-a`,
                    targetStartLine: 1,
                    targetEndLine: 10,
                  },
                ],
              },
            ]
          : [],
      }),
    );
  }

  if (options.openLate === true) {
    // One final request that reads every reference the session was ever shown.
    records.push(
      record({
        requestId: 'late-reader',
        ts: 9_999,
        sessionId: 'shared-session',
        turnIndex: options.requests,
        rounds: [
          {
            id: 'late-r',
            ts: 9_999,
            retries: 0,
            toolCalls: Array.from({ length: options.requests * 2 }, (_, i) => ({
              id: `late-c-${String(i)}`,
              name: 'read_file',
              resultChars: 400,
              targetFileHash: `ref-${String(Math.floor(i / 2))}-${i % 2 === 0 ? 'a' : 'b'}`,
              targetStartLine: 1,
              targetEndLine: 10,
            })),
          },
        ],
      }),
    );
  }

  return save(records);
}

describe('W11 · search-snippet leakage', () => {
  const detector = new ReferenceLeakageDetector();

  it('charges references the model was shown and never opened', () => {
    const findings = detector.detect(
      buildDetectContext(w11Corpus({ requests: 40, openFirstReference: false })),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toContain('100.0%');
    expect(findings[0]?.credits.value).toBeGreaterThan(0);
    expect(findings[0]?.remediation.tier).toBe('B');
  });

  it('does not charge a reference the model went on to read', () => {
    // Half of every request's references are opened, which is below the rate
    // at which retrieval breadth stops looking like retrieval working.
    const findings = detector.detect(
      buildDetectContext(w11Corpus({ requests: 40, openFirstReference: true })),
    );
    const leaked = findings[0];
    if (leaked !== undefined) expect(leaked.title).toContain('50.0%');
  });

  it('does not charge a reference used later in the same session', () => {
    // Retrieval that surfaces something used two turns on is retrieval working.
    const findings = detector.detect(
      buildDetectContext(w11Corpus({ requests: 40, openFirstReference: false, openLate: true })),
    );
    expect(findings).toEqual([]);
  });

  it('refuses to price references on requests with no decomposed Files cost', () => {
    // Borrowing another request's average would be an estimate dressed as a
    // measurement, so these are counted and excluded instead.
    const findings = detector.detect(
      buildDetectContext(w11Corpus({ requests: 40, openFirstReference: false, filesTokens: 0 })),
    );
    expect(findings).toEqual([]);
  });

  it('says why it could not price them, rather than reading as clean retrieval', () => {
    // On the corpus this was first run against, 224 references were recorded
    // and 13 were priceable. Silence there is indistinguishable from
    // "retrieval is fine" — which the residual probe put at 97.8% unopened.
    const ctx = buildDetectContext(
      w11Corpus({ requests: 40, openFirstReference: false, filesTokens: 0 }),
    );

    const pricing = assessReferencePricing(ctx);
    expect(pricing.sufficient).toBe(false);
    expect(pricing.referencesSeen).toBe(80);
    expect(pricing.priceable).toBe(0);

    const w11 = conditionallyUnavailable(ctx).find((item) => item.class === 'W11');
    expect(w11?.reason).toContain('80 file reference(s)');
    expect(w11?.unblockedBy).toContain('advise --explain W11');
  });

  it('apportions no more than the Files cost centre it was given', () => {
    const ctx = buildDetectContext(w11Corpus({ requests: 40, openFirstReference: false }));
    const finding = detector.detect(ctx)[0];
    const filesTokens = ctx.costCentres
      .filter((centre) => centre.label === 'Files')
      .reduce((sum, centre) => sum + centre.tokens, 0);

    const detail = finding?.evidence.find((item) => item.ref === 'ALL')?.detail ?? '';
    const apportioned = Number(/~([\d,]+) apportioned/.exec(detail)?.[1]?.replace(/,/g, '') ?? '0');
    expect(apportioned).toBeGreaterThan(0);
    expect(apportioned).toBeLessThanOrEqual(filesTokens);
  });
});

// ---------------------------------------------------------------------------
// W10 · Instruction bloat
// ---------------------------------------------------------------------------

function w10Corpus(options: {
  readonly requests: number;
  readonly baselineTokens: number;
  readonly laterTokens: number;
}): Database.Database {
  const records: TurnRecord[] = [PRICED_ANCHOR];
  const baselineSize = Math.max(20, Math.floor(options.requests * 0.25));

  for (let i = 0; i < options.requests; i++) {
    records.push(
      record({
        requestId: `instr-${String(i)}`,
        ts: 1_000 + i,
        sessionId: `s-${String(i)}`,
        costCentres: centres(10_000, [
          {
            category: 'System',
            label: 'System Instructions',
            percentageOfPrompt: 10,
            tokens: i < baselineSize ? options.baselineTokens : options.laterTokens,
          },
        ]),
      }),
    );
  }

  return save(records);
}

describe('W10 · instruction bloat', () => {
  const detector = new InstructionBloatDetector();

  it('charges the growth above the corpus’s own early baseline', () => {
    const findings = detector.detect(
      buildDetectContext(w10Corpus({ requests: 80, baselineTokens: 1_000, laterTokens: 2_000 })),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toContain('100.0%');
    expect(findings[0]?.remediation.tier).toBe('C');
  });

  it('does not flag a large but stable instruction set', () => {
    // Size is not the finding. A big instruction set may be entirely
    // load-bearing, and charging it would be a style opinion with a price on it.
    const findings = detector.detect(
      buildDetectContext(w10Corpus({ requests: 80, baselineTokens: 9_000, laterTokens: 9_000 })),
    );
    expect(findings).toEqual([]);
  });

  it('does not flag a set that shrank', () => {
    const findings = detector.detect(
      buildDetectContext(w10Corpus({ requests: 80, baselineTokens: 4_000, laterTokens: 1_000 })),
    );
    expect(findings).toEqual([]);
  });

  it('abstains on a corpus too short to have a baseline and a trend', () => {
    const findings = detector.detect(
      buildDetectContext(w10Corpus({ requests: 30, baselineTokens: 1_000, laterTokens: 5_000 })),
    );
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// W12 · Utility-model drift
// ---------------------------------------------------------------------------

function w12Corpus(options: {
  readonly premiumCompactions: number;
  readonly cheapCompactions: number;
  /** Withholds the premium model's measured rate, leaving it unpriceable. */
  readonly measurePremium?: boolean;
}): Database.Database {
  const records: TurnRecord[] = [
    record({ requestId: 'rate-cheap', ts: 1, model: 'model-cheap', credits: 1 }),
  ];
  if (options.measurePremium !== false) {
    records.push(record({ requestId: 'rate-premium', ts: 2, model: 'model-premium', credits: 60 }));
  } else {
    records.push(record({ requestId: 'seen-premium', ts: 2, model: 'model-premium' }));
  }

  const push = (id: string, ts: number, model: string): void => {
    records.push(
      record({
        requestId: id,
        ts,
        sessionId: `s-${id}`,
        compactions: [
          {
            toolCallRoundId: id,
            model,
            numRounds: 10,
            durationMs: 60_000,
            outcome: 'full/success',
            contextLengthBefore: 100_000,
          },
        ],
      }),
    );
  };

  for (let i = 0; i < options.premiumCompactions; i++) {
    push(`prem-${String(i)}`, 100 + i, 'model-premium');
  }
  for (let i = 0; i < options.cheapCompactions; i++) {
    push(`cheap-${String(i)}`, 500 + i, 'model-cheap');
  }

  return save(records);
}

describe('W12 · utility-model drift', () => {
  const detector = new UtilityModelDriftDetector();

  it('charges the rate difference on summarisation that ran on a premium model', () => {
    const findings = detector.detect(
      buildDetectContext(w12Corpus({ premiumCompactions: 12, cheapCompactions: 4 })),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.credits.value).toBeGreaterThan(0);
    expect(findings[0]?.remediation.tier).toBe('A');
    expect(findings[0]?.remediation.action).toContain('model-cheap');
  });

  it('charges nothing when summarisation already runs on the cheap model', () => {
    const findings = detector.detect(
      buildDetectContext(w12Corpus({ premiumCompactions: 0, cheapCompactions: 20 })),
    );
    expect(findings).toEqual([]);
  });

  it('excludes a model whose rate was never measured rather than guessing it', () => {
    // Pricing a counterfactual against an estimate compounds two guesses into
    // one confident-looking number. The same rule the routing lever applies.
    const findings = detector.detect(
      buildDetectContext(
        w12Corpus({ premiumCompactions: 12, cheapCompactions: 4, measurePremium: false }),
      ),
    );
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// W8 · Cross-developer duplication
// ---------------------------------------------------------------------------

function duplicationWith(askers: number, shared: number): DetectContextInputs['org'] {
  const observations: QuestionObservation[] = [];
  for (let q = 0; q < 250; q++) {
    observations.push({
      questionHash: `unique-${String(q)}`,
      askedBy: `dev-${String(q % Math.max(1, askers))}`,
      credits: 10,
      ts: q,
    });
  }
  for (let q = 0; q < shared; q++) {
    for (let d = 0; d < askers; d++) {
      observations.push({
        questionHash: `shared-${String(q)}`,
        askedBy: `dev-${String(d)}`,
        credits: 10,
        ts: 1_000 + q,
      });
    }
  }
  return detectDuplication(observations);
}

describe('W8 · cross-developer duplication', () => {
  const detector = new CrossDeveloperDuplicationDetector();
  const db = save([record({ requestId: 'r', ts: 1, credits: 5 })]);

  it('charges every answer after the first, once the rollup is present', () => {
    const findings = detector.detect(
      buildDetectContext(db, { org: duplicationWith(MIN_GROUP_SIZE + 1, 10) }),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.credits.value).toBeGreaterThan(0);
    expect(findings[0]?.remediation.tier).toBe('A');
  });

  it('abstains entirely without a rollup, because one machine cannot see it', () => {
    expect(detector.detect(buildDetectContext(db))).toEqual([]);
  });

  it('suppresses a cluster below the k-anonymity floor', () => {
    // "These three keep asking about the payments SDK" is a performance
    // observation dressed as an efficiency finding.
    const findings = detector.detect(
      buildDetectContext(db, { org: duplicationWith(MIN_GROUP_SIZE - 1, 10) }),
    );
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe('unavailability after D12', () => {
  it('leaves only the two classes blocked upstream permanently unavailable', () => {
    expect(UNAVAILABLE_CLASSES.map((item) => item.class)).toEqual(['W13', 'W14']);
  });

  it('reports W7 and W8 as conditionally unavailable, with what would change it', () => {
    const ctx = buildDetectContext(save([record({ requestId: 'r', ts: 1 })]));
    const conditional = conditionallyUnavailable(ctx);

    expect(conditional.map((item) => item.class)).toEqual(['W7', 'W8']);
    for (const item of conditional) {
      expect(item.reason.length).toBeGreaterThan(20);
      expect(item.unblockedBy.length).toBeGreaterThan(10);
    }
  });

  it('drops a class from the conditional list the moment it can actually judge', () => {
    const { db, inputs } = w7Corpus({ abandoned: 20, kept: 20 });
    const ctx = buildDetectContext(db, inputs);
    expect(conditionallyUnavailable(ctx).map((item) => item.class)).toEqual(['W8']);
  });

  it('keeps W7 listed when history is present but cannot support a judgement', () => {
    // Two very different situations that a single "unavailable" line would have
    // rendered identically: no history at all, and history that does not cover
    // the work. The second is the one that actually happens.
    const { db, inputs } = w7Corpus({ abandoned: 2, kept: 1 });
    const ctx = buildDetectContext(db, inputs);

    const w7 = conditionallyUnavailable(ctx).find((item) => item.class === 'W7');
    expect(w7?.reason).toContain('Commit history was read');
    expect(w7?.unblockedBy).toContain('repository');
  });

  it('never reports a class as both found and unavailable', () => {
    const { db, inputs } = w7Corpus({ abandoned: 20, kept: 20 });
    const report = buildWasteReport(db, { scope: 'self', subjectCount: 1 }, inputs);

    const found = new Set(report.findings.map((finding) => finding.class));
    for (const item of report.unavailable) {
      expect(found.has(item.class), `${item.class} is both found and unavailable`).toBe(false);
    }
  });
});
