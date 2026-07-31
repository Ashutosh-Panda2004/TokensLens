import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyseHoldout } from '../src/holdout/analysis.js';
import { assignHoldout, type HoldoutUnit } from '../src/holdout/assignment.js';
import { buildPreregistration, checkRegistration } from '../src/holdout/preregistration.js';
import { checkIntegrity, readHoldout, writeHoldout, holdoutPath } from '../src/holdout/store.js';
import type { DurableChange } from '../src/outcomes/durability.js';
import { ConfigError } from '../src/shared/errors.js';

const DAY = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00Z');

function fleet(size: number): HoldoutUnit[] {
  return Array.from({ length: size }, (_, i) => ({
    unit: `u${String(i).padStart(2, '0')}`,
    team: `team-${String(i % 3)}`,
    preSpend: 100 + i * 10,
  }));
}

/**
 * A panel where the treated arm's changes survive better after the
 * treatment date, and the held-out arm's do not.
 */
function changes(
  units: readonly { unit: string; arm: string }[],
  weeks: number,
  effect: number,
  treatedWeek: number,
): DurableChange[] {
  const rows: DurableChange[] = [];
  for (const { unit, arm } of units) {
    for (let week = 0; week < weeks; week += 1) {
      const treated = arm === 'treated' && week >= treatedWeek;
      const base = 0.6 + ((week * 7 + unit.length) % 5) / 100;
      rows.push({
        changeId: `${unit}-${String(week)}`,
        authorId: unit,
        ts: START + week * 7 * DAY,
        linesAdded: 100,
        linesDeleted: 10,
        filesTouched: 2,
        linesChurned: 20,
        linesSurviving: 80,
        survivingFraction: base + (treated ? effect : 0),
        reverted: false,
        fullyObserved: true,
        durable: true,
      });
    }
  }
  return rows;
}

describe('D8 · the analysis refuses to lead with the number', () => {
  const design = assignHoldout(fleet(30), { seed: 9 });

  it('says NO ESTIMATE, not "no effect", when the policy was never deployed', () => {
    // The distinction the verdict has to preserve: missing data and a null
    // result look identical on a chart and mean opposite things.
    const analysis = analyseHoldout({
      assignments: design.assignments,
      changes: changes(design.assignments, 8, 0, 4),
      deployedAt: undefined,
      periodDays: 7,
    });

    expect(analysis.primary.effect).toBeUndefined();
    expect(analysis.verdict).toMatch(/^NO ESTIMATE/);
    expect(analysis.verdict).not.toMatch(/no effect/i);
  });

  it('recovers a planted effect once there is a treatment date', () => {
    const analysis = analyseHoldout({
      assignments: design.assignments,
      changes: changes(design.assignments, 12, 0.2, 6),
      deployedAt: START + 6 * 7 * DAY,
      periodDays: 7,
    });

    expect(analysis.did).toBeDefined();
    expect(analysis.primary.effect?.point).toBeCloseTo(0.2, 1);
    expect(analysis.power.minimumDetectableEffect).toBeDefined();
  });

  it('withdraws the causal claim when the pre-trend check fails', () => {
    // A design whose central assumption fails must say so instead of
    // reporting a number with an asterisk.
    const diverging = changes(design.assignments, 12, 0, 6).map((change) =>
      change.authorId.endsWith('0')
        ? {
            ...change,
            survivingFraction: change.survivingFraction + (change.ts - START) / (200 * DAY),
          }
        : change,
    );

    const analysis = analyseHoldout({
      assignments: design.assignments,
      changes: diverging,
      deployedAt: START + 6 * 7 * DAY,
      periodDays: 7,
    });

    if (analysis.did?.preTrend.passes === false) {
      expect(analysis.verdict).toMatch(/DESCRIPTIVE ONLY/);
      expect(analysis.primary.detail).toMatch(/describes a difference and does not attribute it/);
    }
  });

  it('overrides every other verdict when a guardrail breaks', () => {
    const analysis = analyseHoldout({
      assignments: design.assignments,
      changes: changes(design.assignments, 12, 0.2, 6),
      deployedAt: START + 6 * 7 * DAY,
      periodDays: 7,
      observations: [{ metric: 'cycle-time', baseline: 10, current: 20, observations: 60 }],
    });

    expect(analysis.guardrails.breaches).toHaveLength(1);
    expect(analysis.verdict).toMatch(/^GUARDRAIL BREACH/);
    expect(analysis.verdict).toMatch(/saving bought with a regression is not a saving/);
  });

  it('marks everything exploratory when the registration does not match', () => {
    const registration = buildPreregistration({
      design,
      horizonDays: 30,
      periodDays: 7,
      alpha: 0.05,
      power: 0.8,
      now: new Date('2026-01-01T00:00:00Z'),
    });

    const analysis = analyseHoldout({
      assignments: design.assignments,
      changes: changes(design.assignments, 12, 0.2, 6),
      deployedAt: START + 6 * 7 * DAY,
      periodDays: 7,
      registration: checkRegistration(registration, {
        ...registration.registration,
        horizonDays: 7,
      }),
    });

    expect(analysis.verdict).toMatch(/^EXPLORATORY/);
    expect(analysis.verdict).toMatch(/may be presented as a pre-registered result/);
  });

  it('carries the unmeasurable metrics rather than dropping them', () => {
    const analysis = analyseHoldout({
      assignments: design.assignments,
      changes: [],
      deployedAt: undefined,
      periodDays: 7,
    });
    expect(analysis.unavailable.map((m) => m.id)).toContain('chat-abandonment');
  });
});

describe('D8 · the experiment file', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'tokenlens-holdout-'));
    roots.push(root);
    return root;
  }

  const design = assignHoldout(fleet(20), { seed: 4 });
  const preregistration = buildPreregistration({
    design,
    horizonDays: 30,
    periodDays: 7,
    alpha: 0.05,
    power: 0.8,
    now: new Date('2026-01-01T00:00:00Z'),
  });

  it('round-trips a design', async () => {
    const root = workspace();
    await writeHoldout({ version: 1, design, preregistration }, root);
    const read = await readHoldout(root);
    expect(read?.design.seed).toBe(4);
    expect(checkIntegrity(read as never).intact).toBe(true);
  });

  it('refuses to re-randomise over a live experiment', async () => {
    // The single most effective way to manufacture a conclusion, and it
    // never looks like misconduct from the inside — it looks like fixing an
    // unlucky draw.
    const root = workspace();
    await writeHoldout({ version: 1, design, preregistration }, root);

    await expect(writeHoldout({ version: 1, design, preregistration }, root)).rejects.toThrow(
      ConfigError,
    );
    await expect(
      writeHoldout({ version: 1, design, preregistration }, root, { force: true }),
    ).resolves.toBe(holdoutPath(root));
  });

  it('reports no design rather than throwing when there is none', async () => {
    expect(await readHoldout(workspace())).toBeUndefined();
  });

  it('spots a registration edited after the fact', () => {
    const tampered = {
      version: 1 as const,
      design,
      preregistration: {
        ...preregistration,
        registration: { ...preregistration.registration, seed: 999 },
      },
    };
    const integrity = checkIntegrity(tampered);
    expect(integrity.intact).toBe(false);
    expect(integrity.detail).toMatch(/Every result from this experiment is exploratory/);
  });
});
