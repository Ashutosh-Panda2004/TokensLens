import { describe, it, expect } from 'vitest';
import { record } from './fixtures/simulate-corpus.js';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import { buildDetectContext } from '../src/waste/context.js';
import { LEVERS } from '../src/simulate/levers.js';
import { parsePolicy } from '../src/simulate/policy.js';
import { buildSimulation } from '../src/simulate/report.js';
import type { LeverId, LeverPlan } from '../src/simulate/levers.js';
import type { TurnRecord } from '../src/model/turn-record.js';

const NOW = new Date('2026-07-15T12:00:00Z');

function planOf(id: LeverId, records: TurnRecord[], source: string): LeverPlan | undefined {
  const db = openDatabase(':memory:');
  saveTurnRecords(db, records);
  const lever = LEVERS.find((entry) => entry.id === id);
  if (!lever) throw new Error(`no lever ${id}`);
  return lever.plan(parsePolicy(source).policy, buildDetectContext(db));
}

function risks(plan: LeverPlan | undefined): string {
  return (plan?.risks ?? []).map((risk) => `${risk.severity}:${risk.text}`).join('\n');
}

/**
 * Every lever is obliged to say what its policy takes away, not only what it
 * saves. These tests exist because a risk note that never fires is a risk
 * note nobody has checked — and on this project the disclosure is the part
 * that has to be trustworthy.
 */
describe('lever disclosures', () => {
  const toolCorpus = (): TurnRecord[] =>
    Array.from({ length: 20 }, (_, i) =>
      record({
        requestId: `r${String(i)}`,
        ts: i,
        sessionId: `s${String(i)}`,
        credits: 10,
        rounds: [
          {
            id: `round-${String(i)}`,
            ts: i,
            retries: 0,
            toolCalls: [
              { id: `a${String(i)}`, name: 'read_file', resultChars: 1_000 },
              { id: `b${String(i)}`, name: 'mcp_aws_describe', resultChars: 1_000 },
              ...(i < 3
                ? [{ id: `c${String(i)}`, name: 'mcp_legacy_lookup', resultChars: 1_000 }]
                : []),
            ],
          },
        ],
      }),
    );

  it('an allow list removes every MCP server not on it, and never a built-in', () => {
    const plan = planOf('tool-trim', toolCorpus(), 'version: 1\ntools:\n  allow_mcp: [aws]\n');
    const removed = (plan?.evidence ?? []).filter((item) => item.ref !== 'ALL').map((i) => i.ref);

    expect(removed).toEqual(['mcp_legacy_lookup']);
    expect(removed).not.toContain('read_file');
    expect(plan?.changes.length).toBeGreaterThan(0);
  });

  it('names the capability a trim takes away, in invocations', () => {
    const plan = planOf(
      'tool-trim',
      toolCorpus(),
      'version: 1\ntools:\n  deny: ["mcp_legacy_*"]\n',
    );

    expect(risks(plan)).toMatch(
      /warning:3 recorded invocation\(s\) used a tool this policy removes/,
    );
    expect(risks(plan)).toMatch(/does not price it/);
  });

  it('says so when a trim removes nothing observed, and names the blind spot', () => {
    const plan = planOf(
      'tool-trim',
      toolCorpus(),
      'version: 1\ntools:\n  deny: [not_a_real_tool]\n',
    );

    expect(plan?.changes).toEqual([]);
    expect(risks(plan)).toMatch(/removes none of the tools observed/);
    // The most wasteful case is the one that cannot be seen at all.
    expect(risks(plan)).toMatch(/never invoked leave no trace/);
  });

  it('says so when there is no tool surface at all', () => {
    const plan = planOf(
      'tool-trim',
      [record({ requestId: 'r1', ts: 1, credits: 5 })],
      'version: 1\ntools:\n  deny: [anything]\n',
    );

    expect(plan?.changes).toEqual([]);
    expect(risks(plan)).toMatch(/no tool surface to trim/);
  });

  /**
   * Without a measured `Tool Results` cost centre there is no ceiling to cap
   * the removal against, so the request is skipped rather than estimated —
   * understating the saving, which is the direction to be wrong in.
   */
  it('skips a request whose tool-result cost was never decomposed, and counts it', () => {
    const plan = planOf(
      'payload-cap',
      [
        record({
          requestId: 'no-centres',
          ts: 1,
          credits: 10,
          costCentres: [],
          rounds: [
            {
              id: 'r',
              ts: 1,
              retries: 0,
              toolCalls: [{ id: 'c', name: 'run_in_terminal', resultChars: 500_000 }],
            },
          ],
        }),
      ],
      'version: 1\npayload:\n  max_result_tokens: 100\n',
    );

    expect(plan?.changes).toEqual([]);
    expect(risks(plan)).toMatch(/no cost-centre breakdown/);
    expect(risks(plan)).toMatch(/understates the saving/);
  });

  it('warns that truncation can be paid for twice', () => {
    const plan = planOf(
      'payload-cap',
      [
        record({
          requestId: 'fat',
          ts: 1,
          credits: 10,
          rounds: [
            {
              id: 'r',
              ts: 1,
              retries: 0,
              toolCalls: [{ id: 'c', name: 'run_in_terminal', resultChars: 500_000 }],
            },
          ],
        }),
      ],
      'version: 1\npayload:\n  max_result_tokens: 100\n',
    );

    expect(risks(plan)).toMatch(/re-runs the tool to get the rest/);
  });

  it('says so when no session is long enough to nudge', () => {
    const plan = planOf(
      'session-hygiene',
      [record({ requestId: 'r1', ts: 1, turnIndex: 0, credits: 5 })],
      'version: 1\nsession:\n  nudge_after_turns: 50\n',
    );

    expect(plan?.changes).toEqual([]);
    expect(risks(plan)).toMatch(/No session ran past 50 turns/);
    // The tier C caveat is unconditional: it is true whether or not the
    // lever fired.
    expect(risks(plan)).toMatch(/depends entirely on a person changing a habit/);
  });

  it('says so when nothing was re-read', () => {
    const plan = planOf(
      'dedupe-reads',
      [record({ requestId: 'r1', ts: 1, credits: 5 })],
      'version: 1\nretrieval:\n  dedupe_reads: true\n',
    );

    expect(risks(plan)).toMatch(/No read in this corpus re-fetched/);
  });

  /**
   * Routing hard work to a cheap model is where a routing policy does damage
   * rather than saving money, so a rule that reaches the top complexity band
   * has to say so before its saving is read.
   */
  it('warns when a routing rule reaches the highest complexity band', () => {
    const records: TurnRecord[] = [];
    // Three distinct effort clusters, so the terciles land between them and
    // the top cluster genuinely scores `high`.
    for (let i = 0; i < 12; i++) {
      records.push(
        record({
          requestId: `cheap-${String(i)}`,
          ts: i,
          sessionId: `sc${String(i)}`,
          model: 'model-cheap',
          promptTokens: 5_000,
          credits: 1,
          outputTokens: 200,
        }),
      );
      records.push(
        record({
          requestId: `middling-${String(i)}`,
          ts: 100 + i,
          sessionId: `sm${String(i)}`,
          model: 'model-premium',
          promptTokens: 5_000,
          credits: 30,
          outputTokens: 2_500,
        }),
      );
    }
    for (let i = 0; i < 6; i++) {
      records.push(
        record({
          requestId: `hard-${String(i)}`,
          ts: 200 + i,
          sessionId: `sh${String(i)}`,
          model: 'model-premium',
          promptTokens: 5_000,
          credits: 30,
          outputTokens: 5_000,
          edits: [{ fileHash: `f${String(i)}`, editCount: 5, done: true }],
        }),
      );
    }

    const plan = planOf('model-routing', records, 'version: 1\nmodel:\n  default: model-cheap\n');
    expect(risks(plan)).toMatch(/highest\* complexity band/);
    expect(risks(plan)).toMatch(/narrow the rule/);
  });

  it('surfaces every warning on the report, not only under --explain', () => {
    const db = openDatabase(':memory:');
    saveTurnRecords(db, toolCorpus());

    const report = buildSimulation(
      db,
      parsePolicy('version: 1\ntools:\n  deny: ["mcp_legacy_*"]\n').policy,
      {
        now: NOW,
      },
    );

    const warnings = report.levers.flatMap((lever) =>
      lever.risks.filter((risk) => risk.severity === 'warning'),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });
});
