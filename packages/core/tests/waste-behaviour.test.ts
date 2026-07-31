import { describe, it, expect } from 'vitest';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { buildDetectContext } from '../src/waste/context.js';
import { buildMcpRoi } from '../src/waste/report.js';
import { DuplicateRetrievalDetector } from '../src/waste/detectors/w2-duplicate-retrieval.js';
import { ModelOverSelectionDetector } from '../src/waste/detectors/w5-model-over-selection.js';
import { ToolDefinitionTaxDetector } from '../src/waste/detectors/w1-tool-definitions.js';
import type { CostCentre, ToolCallInvocation, TurnRecord } from '../src/model/turn-record.js';
import type { WasteFinding } from '../src/waste/types.js';

function record(overrides: Partial<TurnRecord> & Pick<TurnRecord, 'requestId' | 'ts'>): TurnRecord {
  const promptTokens = overrides.promptTokens ?? 10_000;
  return {
    sessionId: 'session-a',
    model: 'model-cheap',
    promptTokens,
    outputTokens: 200,
    costCentres: [
      {
        category: 'System',
        label: 'Tool Definitions',
        percentageOfPrompt: 20,
        tokens: Math.round(promptTokens * 0.2),
      },
      {
        category: 'User Context',
        label: 'Messages',
        percentageOfPrompt: 80,
        tokens: Math.round(promptTokens * 0.8),
      },
    ] satisfies CostCentre[],
    rounds: [],
    edits: [],
    compactions: [],
    contentReferences: [],
    turnIndex: 0,
    source: { file: 'f', offset: 0 },
    ...overrides,
  };
}

function reads(requestId: string, calls: readonly ToolCallInvocation[]): TurnRecord['rounds'] {
  return [{ id: `${requestId}-round`, ts: 1, retries: 0, toolCalls: calls }];
}

describe('W2 · duplicate retrieval', () => {
  const detector = new DuplicateRetrievalDetector();

  /**
   * Every corpus needs at least one request carrying a real credit figure,
   * otherwise the rate card has nothing to derive from, the blended rate is
   * zero, and every priced finding correctly comes out at zero credits.
   */
  const pricingAnchor = record({
    requestId: 'pricing-anchor',
    ts: 0,
    sessionId: 'anchor-session',
    promptTokens: 10_000,
    credits: 5,
  });

  function run(records: readonly TurnRecord[]): WasteFinding[] {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [pricingAnchor, ...records]);
    return detector.detect(buildDetectContext(db));
  }

  it('flags the same whole file read twice in one session', () => {
    const findings = run([
      record({
        requestId: 'r1',
        ts: 1,
        turnIndex: 0,
        rounds: reads('r1', [
          { id: 'c1', name: 'read_file', resultChars: 5_000, targetFileHash: 'file-a' },
        ]),
      }),
      record({
        requestId: 'r2',
        ts: 2,
        turnIndex: 1,
        rounds: reads('r2', [
          { id: 'c2', name: 'read_file', resultChars: 5_000, targetFileHash: 'file-a' },
        ]),
      }),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.credits.value).toBeGreaterThan(0);
  });

  it('does NOT flag reads of non-overlapping ranges of the same file', () => {
    // The behaviour worth encouraging. A detector that penalised this would
    // be telling engineers off for retrieving precisely.
    const findings = run([
      record({
        requestId: 'r1',
        ts: 1,
        turnIndex: 0,
        rounds: reads('r1', [
          {
            id: 'c1',
            name: 'read_file',
            resultChars: 2_000,
            targetFileHash: 'file-a',
            targetStartLine: 1,
            targetEndLine: 50,
          },
        ]),
      }),
      record({
        requestId: 'r2',
        ts: 2,
        turnIndex: 1,
        rounds: reads('r2', [
          {
            id: 'c2',
            name: 'read_file',
            resultChars: 2_000,
            targetFileHash: 'file-a',
            targetStartLine: 400,
            targetEndLine: 450,
          },
        ]),
      }),
    ]);

    expect(findings).toHaveLength(0);
  });

  it('DOES flag reads of overlapping ranges', () => {
    const findings = run([
      record({
        requestId: 'r1',
        ts: 1,
        turnIndex: 0,
        rounds: reads('r1', [
          {
            id: 'c1',
            name: 'read_file',
            resultChars: 2_000,
            targetFileHash: 'file-a',
            targetStartLine: 1,
            targetEndLine: 100,
          },
        ]),
      }),
      record({
        requestId: 'r2',
        ts: 2,
        turnIndex: 1,
        rounds: reads('r2', [
          {
            id: 'c2',
            name: 'read_file',
            resultChars: 2_000,
            targetFileHash: 'file-a',
            targetStartLine: 50,
            targetEndLine: 150,
          },
        ]),
      }),
    ]);

    expect(findings).toHaveLength(1);
  });

  it('does NOT flag the same file read in two DIFFERENT sessions', () => {
    // Context is per session. A different session has no memory of the first
    // read, so fetching it again is necessary, not redundant.
    const findings = run([
      record({
        requestId: 'r1',
        ts: 1,
        sessionId: 'session-one',
        rounds: reads('r1', [
          { id: 'c1', name: 'read_file', resultChars: 5_000, targetFileHash: 'file-a' },
        ]),
      }),
      record({
        requestId: 'r2',
        ts: 2,
        sessionId: 'session-two',
        rounds: reads('r2', [
          { id: 'c2', name: 'read_file', resultChars: 5_000, targetFileHash: 'file-a' },
        ]),
      }),
    ]);

    expect(findings).toHaveLength(0);
  });

  it('does NOT flag reads of different files', () => {
    const findings = run([
      record({
        requestId: 'r1',
        ts: 1,
        turnIndex: 0,
        rounds: reads('r1', [
          { id: 'c1', name: 'read_file', resultChars: 5_000, targetFileHash: 'file-a' },
        ]),
      }),
      record({
        requestId: 'r2',
        ts: 2,
        turnIndex: 1,
        rounds: reads('r2', [
          { id: 'c2', name: 'read_file', resultChars: 5_000, targetFileHash: 'file-b' },
        ]),
      }),
    ]);

    expect(findings).toHaveLength(0);
  });

  it('charges only the redundant copy, never the first read', () => {
    const once = run([
      record({
        requestId: 'r1',
        ts: 1,
        turnIndex: 0,
        rounds: reads('r1', [
          { id: 'c1', name: 'read_file', resultChars: 4_000, targetFileHash: 'file-a' },
        ]),
      }),
      record({
        requestId: 'r2',
        ts: 2,
        turnIndex: 1,
        rounds: reads('r2', [
          { id: 'c2', name: 'read_file', resultChars: 4_000, targetFileHash: 'file-a' },
        ]),
      }),
    ]);

    const twice = run([
      record({
        requestId: 'r1',
        ts: 1,
        turnIndex: 0,
        rounds: reads('r1', [
          { id: 'c1', name: 'read_file', resultChars: 4_000, targetFileHash: 'file-a' },
        ]),
      }),
      record({
        requestId: 'r2',
        ts: 2,
        turnIndex: 1,
        rounds: reads('r2', [
          { id: 'c2', name: 'read_file', resultChars: 4_000, targetFileHash: 'file-a' },
        ]),
      }),
      record({
        requestId: 'r3',
        ts: 3,
        turnIndex: 2,
        rounds: reads('r3', [
          { id: 'c3', name: 'read_file', resultChars: 4_000, targetFileHash: 'file-a' },
        ]),
      }),
    ]);

    // Three reads means two redundant copies, not three.
    expect(twice[0]?.credits.value).toBeCloseTo((once[0]?.credits.value ?? 0) * 2, 5);
  });
});

describe('W5 · model over-selection', () => {
  const detector = new ModelOverSelectionDetector();

  function corpus(): TurnRecord[] {
    const records: TurnRecord[] = [
      // Two measured rates, ~60x apart.
      record({ requestId: 'rate-cheap', ts: 1, model: 'cheap', promptTokens: 10_000, credits: 1 }),
      record({
        requestId: 'rate-prem',
        ts: 2,
        model: 'premium',
        promptTokens: 10_000,
        credits: 60,
      }),
    ];

    // Simple work on the premium model — the target.
    for (let i = 0; i < 15; i++) {
      records.push(
        record({
          requestId: `simple-${String(i)}`,
          ts: 100 + i,
          sessionId: `s${String(i)}`,
          model: 'premium',
          promptTokens: 5_000,
          outputTokens: 10,
        }),
      );
    }

    // Genuinely complex work on the premium model — must NOT be flagged.
    for (let i = 0; i < 15; i++) {
      records.push(
        record({
          requestId: `complex-${String(i)}`,
          ts: 200 + i,
          sessionId: `c${String(i)}`,
          model: 'premium',
          promptTokens: 5_000,
          outputTokens: 8_000,
          edits: [{ fileHash: `f${String(i)}`, editCount: 20, done: true }],
          rounds: Array.from({ length: 25 }, (_, r) => ({
            id: `cr-${String(i)}-${String(r)}`,
            ts: 200 + i,
            retries: 0,
            toolCalls: [{ id: `cc-${String(i)}-${String(r)}`, name: 'read_file' }],
          })),
        }),
      );
    }
    return records;
  }

  it('flags low-complexity requests running on a premium model', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, corpus());
    const findings = detector.detect(buildDetectContext(db));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.credits.value).toBeGreaterThan(0);
    expect(findings[0]?.remediation.tier).toBe('A');
  });

  it('does not flag complex work — the counterfactual is only claimed for simple requests', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, corpus());
    const finding = detector.detect(buildDetectContext(db))[0];

    const flaggedRefs = finding?.evidence.map((e) => e.ref) ?? [];
    expect(flaggedRefs).not.toContain('complex-0');
  });

  it('states that the cheaper model sufficing is an unobservable counterfactual', () => {
    // The single easiest place in the engine to fabricate confidence. The
    // assumption must be on the record.
    const db = openDatabase(':memory:');
    saveTurnRecords(db, corpus());
    const finding = detector.detect(buildDetectContext(db))[0];

    const assumptions =
      finding?.credits.provenance.kind === 'modelled'
        ? finding.credits.provenance.assumptions.join(' ')
        : '';
    expect(assumptions).toContain('counterfactual');
  });

  it('stays silent when only one model has a measured rate', () => {
    // With nothing to compare against, there is no defensible saving to claim.
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({ requestId: 'only', ts: 1, model: 'solo', promptTokens: 10_000, credits: 5 }),
    ]);
    expect(detector.detect(buildDetectContext(db))).toHaveLength(0);
  });
});

describe('W1 · tool-definition tax', () => {
  const detector = new ToolDefinitionTaxDetector();

  it('attributes cost to a barely-used tool rather than letting it look free', () => {
    // The apportionment-by-invocation bug this guards against: splitting the
    // tax by invocation share gives a near-unused tool almost nothing, when
    // it is the most wasteful case.
    const db = openDatabase(':memory:');
    const records: TurnRecord[] = [];
    for (let i = 0; i < 40; i++) {
      records.push(
        record({
          requestId: `r${String(i)}`,
          ts: i,
          sessionId: `s${String(i)}`,
          promptTokens: 10_000,
          credits: 5,
          rounds: reads(`r${String(i)}`, [
            { id: `busy-${String(i)}`, name: 'busy_tool' },
            ...(i === 0 ? [{ id: 'rare-0', name: 'rare_tool' }] : []),
          ]),
        }),
      );
    }
    saveTurnRecords(db, records);

    const finding = detector.detect(buildDetectContext(db))[0];
    expect(finding).toBeDefined();

    // Two distinct tools, one of them used once in 40 requests.
    const refs = finding?.evidence.map((e) => e.ref) ?? [];
    expect(refs).toContain('rare_tool');
    expect(refs).not.toContain('busy_tool');
    expect(finding?.credits.value).toBeGreaterThan(0);
  });

  it('reports the share against decomposed tokens, matching the ledger view', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({
        requestId: 'r1',
        ts: 1,
        promptTokens: 10_000,
        credits: 5,
        rounds: reads('r1', [{ id: 'c1', name: 'some_tool' }]),
      }),
    ]);

    // Fixture is 20% tool definitions; the title must say so, not a diluted figure.
    expect(detector.detect(buildDetectContext(db))[0]?.title).toContain('20.0%');
  });
});

describe('MCP ROI', () => {
  it('groups namespaced MCP tools by server and separates built-ins', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, [
      record({
        requestId: 'r1',
        ts: 1,
        rounds: reads('r1', [
          { id: 'a', name: 'mcp_github_create_issue' },
          { id: 'b', name: 'mcp_github_list_prs' },
          { id: 'c', name: 'read_file' },
        ]),
      }),
    ]);

    const roi = buildMcpRoi(db);
    const github = roi.find((r) => r.server === 'mcp:github');
    expect(github?.toolCount).toBe(2);
    expect(github?.invocations).toBe(2);
    expect(roi.find((r) => r.server === 'built-in')?.invocations).toBe(1);
  });

  it('marks a tool group invoked on almost no requests as unused in the window', () => {
    const db = openDatabase(':memory:');
    const records: TurnRecord[] = [];
    for (let i = 0; i < 50; i++) {
      records.push(
        record({
          requestId: `r${String(i)}`,
          ts: i,
          sessionId: `s${String(i)}`,
          rounds: reads(`r${String(i)}`, [
            { id: `busy-${String(i)}`, name: 'read_file' },
            ...(i === 0 ? [{ id: 'rare', name: 'mcp_idle_thing' }] : []),
          ]),
        }),
      );
    }
    saveTurnRecords(db, records);

    expect(buildMcpRoi(db).find((r) => r.server === 'mcp:idle')?.verdict).toBe('unused-in-window');
    expect(buildMcpRoi(db).find((r) => r.server === 'built-in')?.verdict).toBe('active');
  });
});
