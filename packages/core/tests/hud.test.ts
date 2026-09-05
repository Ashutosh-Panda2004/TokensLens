import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, saveTurnRecords } from '../src/store/database.js';
import type { TurnRecord } from '../src/model/turn-record.js';
import {
  MINIMUM_TURNS_TO_PROJECT,
  longestSessionId,
  projectNextTurnCost,
} from '../src/ledger/next-turn.js';
import { buildHudSnapshot, HUD_SCHEMA_VERSION } from '../src/ledger/hud.js';
import { creditsToUsd, planAllowanceAt, resolveAllowance } from '../src/ledger/budget.js';
import { allScope } from '../src/scope/index.js';

const WORKSPACE = 'ws-a';

function seed(
  db: Database.Database,
  sessionId: string,
  creditsPerTurn: readonly number[],
  workspace = WORKSPACE,
): void {
  const records: TurnRecord[] = creditsPerTurn.map((credits, index) => ({
    requestId: `${sessionId}-${String(index)}`,
    sessionId,
    ts: Date.UTC(2026, 7, 1, 0, index),
    model: 'claude-sonnet-5',
    promptTokens: 1000 * (index + 1),
    outputTokens: 100,
    credits,
    costCentres: [],
    rounds: [],
    edits: [],
    compactions: [],
    contentReferences: [],
    turnIndex: index,
    source: { file: `${workspace}/chatSessions/${sessionId}.jsonl`, offset: index },
  }));
  saveTurnRecords(db, records);
}

describe('projectNextTurnCost', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tokenlens-next-turn-'));
    db = openDatabase(join(dir, 'ledger.sqlite3'));
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('recovers a known linear growth', () => {
    // Ten turns rising by 10 credits each: the eleventh should land near 110.
    seed(
      db,
      'growing',
      Array.from({ length: 10 }, (_, index) => 10 + index * 10),
    );

    const projection = projectNextTurnCost(db, 'growing');

    expect(projection).toBeDefined();
    expect(projection?.nextTurnCredits).toBeCloseTo(110, 0);
    expect(projection?.turnsSoFar).toBe(10);
  });

  it('refuses to answer below the minimum sample size', () => {
    seed(db, 'tiny', [10, 20]);
    expect(projectNextTurnCost(db, 'tiny')).toBeUndefined();
    expect(MINIMUM_TURNS_TO_PROJECT).toBeGreaterThan(2);
  });

  it('never projects a cheaper next turn than the last one actually cost', () => {
    // A noisy tail that slopes downward would otherwise promise a discount
    // the mechanism cannot deliver: context only grows.
    seed(db, 'noisy', [100, 90, 80, 70, 60]);
    const projection = projectNextTurnCost(db, 'noisy');
    expect(projection?.nextTurnCredits).toBeGreaterThanOrEqual(60);
  });

  it('states how many turns the projection is based on', () => {
    seed(db, 'sampled', [10, 20, 30, 40, 50]);
    expect(projectNextTurnCost(db, 'sampled')?.sampleSize).toBe(5);
  });

  it('compares against the median first turn, so a reset has a concrete value', () => {
    seed(db, 'long', [10, 20, 30, 40, 50, 60]);
    seed(db, 'short-a', [10]);
    seed(db, 'short-b', [10]);

    const projection = projectNextTurnCost(db, 'long');

    expect(projection?.freshTurnCredits).toBe(10);
    expect(projection?.multipleOfFreshTurn).toBeCloseTo((projection?.nextTurnCredits ?? 0) / 10, 6);
  });

  it('ignores sessions outside the requested scope', () => {
    seed(db, 'here', [10, 20, 30, 40], 'ws-a');
    seed(db, 'elsewhere', [500, 600, 700, 800, 900, 1000], 'ws-b');

    const scope = {
      mode: 'workspace' as const,
      workspaceIds: new Set(['ws-a']),
      totalWorkspaceCount: 2,
      matchedWorkspaceCount: 1,
    };

    // Machine-wide the longest conversation is the other workspace's; scoped,
    // it must be this one, or the HUD offers an action on a chat the reader
    // cannot see.
    expect(longestSessionId(db)).toBe('elsewhere');
    expect(longestSessionId(db, scope)).toBe('here');
    expect(projectNextTurnCost(db, 'elsewhere', scope)).toBeUndefined();
  });
});

describe('buildHudSnapshot', () => {
  let dir: string;
  let db: Database.Database;

  const allowanceOf = (credits: number | null) =>
    ({ plan: 'enterprise', credits, source: 'config' }) as const;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tokenlens-hud-'));
    db = openDatabase(join(dir, 'ledger.sqlite3'));
    seed(db, 'main', [100, 200, 300, 400, 500]);
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('carries a schema version so a mismatched client can say so', () => {
    const snapshot = buildHudSnapshot(db, {
      allowance: allowanceOf(3900),
      scopeLabel: 'test',
      now: new Date(Date.UTC(2026, 7, 2)),
    });
    expect(snapshot.schemaVersion).toBe(HUD_SCHEMA_VERSION);
  });

  it('reports no remaining figure at all when the allowance is unlimited', () => {
    // The defect this exists to prevent: `null - spend` coerces to a negative
    // number, clamps to zero, and renders "0 cr left" in red.
    const snapshot = buildHudSnapshot(db, {
      allowance: allowanceOf(null),
      scopeLabel: 'test',
      now: new Date(Date.UTC(2026, 7, 2)),
    });

    expect(snapshot.month.unlimited).toBe(true);
    expect(snapshot.month.remainingCredits).toBeNull();
    expect(snapshot.month.percentUsed).toBeNull();
  });

  it('separates value consumed from money actually owed', () => {
    // 1500 credits spent against a 1000 allowance: $15 of value, but only
    // $5 of it is new money — the rest is prepaid by the subscription.
    const snapshot = buildHudSnapshot(db, {
      allowance: allowanceOf(1000),
      scopeLabel: 'test',
      now: new Date(Date.UTC(2026, 7, 2)),
    });

    expect(snapshot.month.credits).toBe(1500);
    expect(snapshot.month.usd).toBeCloseTo(15, 6);
    expect(snapshot.month.incrementalUsd).toBeCloseTo(5, 6);
  });

  it('charges every credit when no allowance is prepaid', () => {
    const snapshot = buildHudSnapshot(db, {
      allowance: allowanceOf(null),
      scopeLabel: 'test',
      now: new Date(Date.UTC(2026, 7, 2)),
    });
    expect(snapshot.month.incrementalUsd).toBeCloseTo(snapshot.month.usd, 6);
  });

  it('includes the next-turn projection and its money value', () => {
    const snapshot = buildHudSnapshot(db, {
      allowance: allowanceOf(3900),
      scopeLabel: 'test',
      now: new Date(Date.UTC(2026, 7, 2)),
    });

    expect(snapshot.session?.turns).toBe(5);
    expect(snapshot.session?.nextTurn?.credits).toBeGreaterThan(500);
    expect(snapshot.session?.nextTurn?.usd).toBeCloseTo(
      creditsToUsd(snapshot.session?.nextTurn?.credits ?? 0),
      6,
    );
  });

  it('states the scope it was built for', () => {
    const snapshot = buildHudSnapshot(db, {
      allowance: allowanceOf(3900),
      scope: allScope(),
      scopeLabel: 'every workspace',
      now: new Date(Date.UTC(2026, 7, 2)),
    });
    expect(snapshot.scope).toBe('every workspace');
  });

  it('carries bounded daily, weekly and monthly consumption history', () => {
    const snapshot = buildHudSnapshot(db, {
      allowance: allowanceOf(3900),
      scopeLabel: 'test',
      now: new Date(Date.UTC(2026, 7, 2)),
    });
    const history = snapshot.history;
    expect(history).toBeDefined();
    if (history === undefined) throw new Error('HUD history was not produced.');

    expect(history.daily.points).toHaveLength(14);
    expect(history.weekly.points).toHaveLength(12);
    expect(history.monthly.points).toHaveLength(12);

    const augustFirst = history.daily.points.at(-2);
    expect(augustFirst).toMatchObject({
      from: '2026-08-01',
      to: '2026-08-01',
      credits: 1500,
      promptTokens: 15_000,
      outputTokens: 500,
      requests: 5,
    });

    expect(history.daily.points.at(-1)).toMatchObject({
      from: '2026-08-02',
      to: '2026-08-02',
      credits: 0,
      requests: 0,
    });
    expect(history.weekly.points.at(-1)).toMatchObject({
      from: '2026-07-27',
      to: '2026-08-02',
      credits: 1500,
    });
    expect(history.monthly.points.at(-1)).toMatchObject({
      from: '2026-08-01',
      to: '2026-08-02',
      credits: 1500,
    });
  });

  it('marks Business and Enterprise as pooled, and Pro as not', () => {
    const pooled = buildHudSnapshot(db, {
      allowance: resolveAllowance({ plan: 'business', now: new Date(Date.UTC(2026, 7, 2)) }),
      scopeLabel: 'test',
      now: new Date(Date.UTC(2026, 7, 2)),
    });
    const personal = buildHudSnapshot(db, {
      allowance: resolveAllowance({ plan: 'pro', now: new Date(Date.UTC(2026, 7, 2)) }),
      scopeLabel: 'test',
      now: new Date(Date.UTC(2026, 7, 2)),
    });

    expect(pooled.month.pooled).toBe(true);
    expect(personal.month.pooled).toBe(false);
    expect(personal.month.allowance).toBe(planAllowanceAt('pro').credits);
  });
});
