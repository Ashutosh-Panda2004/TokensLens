import { describe, it, expect } from 'vitest';
import { auditBundle, BUNDLE_MANIFEST, type OrgBundle } from '../src/org/bundle.js';
import { measuredDistribution, rollUp, MIN_INSTALLS_FOR_DISTRIBUTION } from '../src/org/rollup.js';
import { buildAlert, buildExecutiveReport, detectAnomalies } from '../src/org/alerts.js';
import { detectDrift, snapshotFit, REFIT_INTERVAL_DAYS } from '../src/org/drift.js';
import {
  assessCache,
  assessPrefixStability,
  detectDuplication,
  UNAVAILABLE_DUPLICATION,
  type QuestionObservation,
} from '../src/org/duplication.js';
import { CONTENT_ATTRIBUTES, ingestOtel, type OtelPayload } from '../src/org/otel.js';
import { MIN_GROUP_SIZE } from '../src/privacy/scope.js';
import type { Policy } from '../src/simulate/policy.js';

function bundle(overrides: Partial<OrgBundle> = {}): OrgBundle {
  return {
    bundleVersion: 1,
    producedBy: 'tokenlens test',
    installId: 'abcdef0123456789',
    team: 'platform',
    periodFrom: '2026-06-01',
    periodTo: '2026-06-30',
    developers: 5,
    totalCredits: 1000,
    measuredCredits: 400,
    modelledCredits: 600,
    requestCount: 500,
    byModel: [{ model: 'gpt-4.1', credits: 1000, requests: 500 }],
    byCostCentre: [{ label: 'Tool Definitions', credits: 300 }],
    byWasteClass: [{ class: 'W1', credits: 300, confidence: 0.8 }],
    toolSurface: [{ server: 'github', toolCount: 40, invocations: 120 }],
    daily: [{ day: '2026-06-01', credits: 1000, requests: 500 }],
    manifest: BUNDLE_MANIFEST,
    ...overrides,
  };
}

describe('D9.2 · what leaves the machine', () => {
  it('declares every field it carries', () => {
    // The manifest is only worth something if it is enforced. A field added
    // in six months would otherwise ship silently while a security review
    // kept reading the old list.
    const audit = auditBundle(bundle());
    expect(audit.safe).toBe(true);
    expect(audit.undeclaredFields).toHaveLength(0);
  });

  it('refuses a bundle carrying an undeclared field', () => {
    const audit = auditBundle({ ...bundle(), prompts: ['secret'] } as unknown as OrgBundle);
    expect(audit.safe).toBe(false);
    expect(audit.undeclaredFields).toContain('prompts');
    expect(audit.detail).toMatch(/security review will not have seen/);
  });

  it('carries nothing that could name a person, a path or a prompt', () => {
    // The manifest is prose and legitimately uses these words; the payload
    // must not. Checked on the data alone so the test says what it means.
    const payload: Record<string, unknown> = { ...bundle() };
    delete payload.manifest;
    const text = JSON.stringify(payload).toLowerCase();
    for (const forbidden of ['prompt', 'completion', 'filepath', 'sessionid', 'content']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('D9.3 + D9.9 · fleet rollup', () => {
  it('suppresses a team smaller than the k-anonymity floor but keeps its credits in the total', () => {
    // Dropping small teams from the total would make the fleet figure
    // silently wrong, and the reason would be a privacy control — which is
    // how privacy controls get a reputation for ruining numbers.
    const rollup = rollUp([
      bundle({ team: 'platform', developers: 20, totalCredits: 5000 }),
      bundle({ team: 'tiny', developers: 2, totalCredits: 900 }),
    ]);

    expect(rollup.totalCredits).toBe(5900);
    const tiny = rollup.byTeam.find((team) => team.suppressed);
    expect(tiny).toBeDefined();
    expect(tiny?.team).not.toBe('tiny');
    expect(tiny?.team).toContain('withheld');
  });

  it('does not claim the extrapolation is retired on a handful of installs', () => {
    expect(rollUp([bundle(), bundle()]).extrapolationRetired).toBe(false);
    expect(
      rollUp(Array.from({ length: MIN_GROUP_SIZE }, () => bundle())).extrapolationRetired,
    ).toBe(true);
  });

  it('reports a Gini that flags a mean as unsafe to multiply by a seat count', () => {
    const skewed = [
      bundle({ developers: 1, totalCredits: 10_000 }),
      ...Array.from({ length: 9 }, () => bundle({ developers: 1, totalCredits: 100 })),
    ];
    const distribution = measuredDistribution(skewed);

    expect(distribution.gini ?? 0).toBeGreaterThan(0.5);
    expect(distribution.median).toBeLessThan(distribution.mean);
    expect(distribution.detail).toMatch(/not a description of anybody/);
  });

  it('withholds concentration entirely below five installs', () => {
    // Found live: one install produced "Gini 0.00: spend is spread evenly
    // enough that the mean is a reasonable per-seat figure" — an artefact
    // of n=1 being used to reassure a reader about the exact extrapolation
    // this phase exists to retire.
    const distribution = measuredDistribution([bundle({ developers: 1, totalCredits: 10_000 })]);

    expect(distribution.gini).toBeUndefined();
    expect(distribution.topDecileShare).toBeUndefined();
    expect(distribution.estimable).toBe(false);
    expect(distribution.detail).toMatch(/is not a distribution/);
    expect(distribution.detail).not.toMatch(/reasonable per-seat figure/);
    expect(MIN_INSTALLS_FOR_DISTRIBUTION).toBe(MIN_GROUP_SIZE);
  });

  it('reports a Gini near zero for even spend', () => {
    const even = Array.from({ length: 10 }, () => bundle({ developers: 1, totalCredits: 500 }));
    expect(measuredDistribution(even).gini).toBeCloseTo(0, 6);
  });

  it('counts a server installed twice as one surface, not two', () => {
    const rollup = rollUp([bundle(), bundle()]);
    const github = rollup.toolSurface.find((row) => row.server === 'github');
    expect(github?.toolCount).toBe(40);
    expect(github?.invocations).toBe(240);
  });
});

describe('D9.6 · anomaly detection', () => {
  const steady = Array.from({ length: 30 }, (_, i) => ({
    day: `2026-06-${String(i + 1).padStart(2, '0')}`,
    credits: 100 + (i % 3),
  }));

  it('refuses to judge a fortnight it has not seen', () => {
    const report = detectAnomalies(steady.slice(0, 5));
    expect(report.estimable).toBe(false);
    expect(report.detail).toMatch(/switched off in its second/);
  });

  it('finds a spike', () => {
    const withSpike = [...steady];
    withSpike[20] = { day: '2026-06-21', credits: 900 };
    const report = detectAnomalies(withSpike);
    expect(report.anomalies[0]?.day).toBe('2026-06-21');
    expect(report.anomalies[0]?.severity).toBe('critical');
  });

  it('is not blinded by the spike it is looking for', () => {
    // The failure a 3-sigma rule has: the outlier inflates the standard
    // deviation it is compared against until it fits inside it.
    const withSpike = [...steady];
    withSpike[20] = { day: '2026-06-21', credits: 100_000 };

    const values = withSpike.map((p) => p.credits);
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1));
    const sigmaZ = Math.abs((100_000 - mean) / sd);

    const report = detectAnomalies(withSpike);
    expect(sigmaZ).toBeLessThan(6);
    expect(report.anomalies[0]?.robustZ).toBeGreaterThan(1000);
  });

  it('says nothing rather than everything when the series is flat', () => {
    const flat = Array.from({ length: 20 }, (_, i) => ({
      day: `2026-06-${String(i + 1).padStart(2, '0')}`,
      credits: 100,
    }));
    const report = detectAnomalies(flat);
    expect(report.estimable).toBe(false);
    expect(report.anomalies).toHaveLength(0);
  });

  it('produces a payload but never delivers it', () => {
    const withSpike = [...steady];
    withSpike[20] = { day: '2026-06-21', credits: 900 };
    const payload = buildAlert(detectAnomalies(withSpike), rollUp([bundle()]));
    expect(payload?.delivery).toMatch(/does not post this/);
  });
});

describe('D9.6 · executive report', () => {
  it('attaches caveats as a required field, not an appendix', () => {
    const report = buildExecutiveReport(rollUp([bundle(), bundle()]), [bundle(), bundle()]);
    expect(report.caveats.length).toBeGreaterThan(1);
    expect(report.caveats.join(' ')).toMatch(/rate-card estimated/);
    expect(report.caveats.join(' ')).toMatch(/extrapolation error this phase exists to retire/);
  });
});

describe('D9.7 · closed loop', () => {
  const policy: Policy = { version: 1, model: { default: 'gpt-4.1' } };

  it('spots a model that did not exist at fit time', () => {
    const snapshot = snapshotFit([bundle()], new Date('2026-06-01T00:00:00Z'));
    const now = [
      bundle({
        byModel: [
          { model: 'gpt-4.1', credits: 500, requests: 200 },
          { model: 'gpt-6', credits: 500, requests: 200 },
        ],
      }),
    ];

    const drift = detectDrift(snapshot, now, policy, new Date('2026-06-20T00:00:00Z'));
    expect(drift.findings.some((f) => f.kind === 'new-model' && f.subject === 'gpt-6')).toBe(true);
    expect(drift.unseenCreditShare).toBeCloseTo(0.5, 6);
    expect(drift.refitRecommended).toBe(true);
  });

  it('does not count a model the policy deliberately did not route to as drift', () => {
    // Found live: a policy emitted from the fleet's own data, zero days
    // old, with zero drift signals, reported "97% of credits are on models
    // the policy does not mention". It was measuring what the fleet is,
    // not what has changed about it.
    const now = [
      bundle({
        byModel: [
          { model: 'gpt-4.1', credits: 100, requests: 50 },
          { model: 'claude-sonnet-4', credits: 900, requests: 300 },
        ],
      }),
    ];
    const snapshot = snapshotFit(now, new Date('2026-06-01T00:00:00Z'));

    const drift = detectDrift(snapshot, now, policy, new Date('2026-06-02T00:00:00Z'));
    expect(drift.unseenCreditShare).toBe(0);
    expect(drift.refitRecommended).toBe(false);
    expect(drift.detail).toMatch(/already present when the policy was fitted/);
  });

  it('spots a new MCP server, because tool definitions are a standing per-request cost', () => {
    const snapshot = snapshotFit([bundle()], new Date('2026-06-01T00:00:00Z'));
    const now = [
      bundle({
        toolSurface: [
          { server: 'github', toolCount: 40, invocations: 120 },
          { server: 'jira', toolCount: 55, invocations: 5 },
        ],
      }),
    ];

    const drift = detectDrift(snapshot, now, policy, new Date('2026-06-10T00:00:00Z'));
    const finding = drift.findings.find((f) => f.kind === 'new-server');
    expect(finding?.subject).toBe('jira');
    expect(finding?.action).toMatch(/whether the tools are called or not/);
  });

  it('recommends a refit once the fit is a quarter old, even if nothing moved', () => {
    const snapshot = snapshotFit([bundle()], new Date('2026-01-01T00:00:00Z'));
    const drift = detectDrift(snapshot, [bundle()], policy, new Date('2026-06-01T00:00:00Z'));
    expect(drift.daysSinceFit).toBeGreaterThan(REFIT_INTERVAL_DAYS);
    expect(drift.refitRecommended).toBe(true);
  });

  it('stays quiet when nothing has changed', () => {
    const snapshot = snapshotFit([bundle()], new Date('2026-06-01T00:00:00Z'));
    const drift = detectDrift(snapshot, [bundle()], policy, new Date('2026-06-05T00:00:00Z'));
    expect(drift.findings).toHaveLength(0);
    expect(drift.refitRecommended).toBe(false);
  });
});

describe('D9.4 · cross-developer duplication', () => {
  function ask(hash: string, who: string, credits = 10): QuestionObservation {
    return { questionHash: hash, askedBy: who, credits, ts: 0 };
  }

  it('ignores one person asking the same thing repeatedly', () => {
    // That is iteration, which W2 covers and which a shared cache would not
    // help. Counting it would inflate the figure with unshareable work.
    const report = detectDuplication([ask('q1', 'a'), ask('q1', 'a'), ask('q1', 'a')]);
    expect(report.clusters).toHaveLength(0);
    expect(report.redundantCredits).toBe(0);
  });

  it('finds a question many developers asked, and prices the repeats', () => {
    const asks = Array.from({ length: 6 }, (_, i) => ask('q1', `dev${String(i)}`, 10));
    const report = detectDuplication(asks);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0]?.askedBy).toBe(6);
    expect(report.clusters[0]?.redundantCredits).toBeCloseTo(50, 6);
  });

  it('withholds a cluster with fewer than five distinct askers', () => {
    const report = detectDuplication([ask('q1', 'a'), ask('q1', 'b'), ask('q1', 'c')]);
    expect(report.clusters).toHaveLength(0);
    expect(report.suppressedClusters).toBe(1);
    // Still counted in the total: the finding is real even when the row is
    // not publishable.
    expect(report.redundantCredits).toBeGreaterThan(0);
  });

  it('says the semantic half is not built, and why', () => {
    const report = detectDuplication([]);
    expect(report.unavailable[0]?.reason).toMatch(/AI-3/);
    expect(UNAVAILABLE_DUPLICATION[0].unblockedBy).toMatch(/Not a change to this file/);
    expect(report.detail).toMatch(/floor on duplication/);
  });

  it('says not to build a cache when the duplication is a rounding error', () => {
    const asks = Array.from({ length: 6 }, (_, i) => ask('q1', `dev${String(i)}`, 1));
    const cache = assessCache(detectDuplication(asks), 1_000_000);
    expect(cache.worthBuilding).toBe(false);
    expect(cache.detail).toMatch(/Do not build it/);
  });

  it('says to build one when it clears the bar', () => {
    const asks = Array.from({ length: 10 }, (_, i) => ask('q1', `dev${String(i)}`, 100));
    const cache = assessCache(detectDuplication(asks), 1000);
    expect(cache.worthBuilding).toBe(true);
    expect(cache.detail).toMatch(/invalidation problem is worth taking on/);
  });
});

describe('D9.8 · cache prefix', () => {
  it('measures the stable share of a prompt but refuses to call it verified', () => {
    const stability = assessPrefixStability(new Map([['s1', [1000, 2000, 3000, 4000]]]));
    expect(stability.cacheableShare).toBeCloseTo(0.4, 6);
    expect(stability.verification).toMatch(/Not verified/);
    expect(stability.verification).toMatch(/could work and a cache that did/);
  });

  it('reports nothing when no session had a second turn', () => {
    expect(assessPrefixStability(new Map([['s1', [1000]]])).cacheableShare).toBeUndefined();
  });
});

describe('D9.1 · managed OTel ingest', () => {
  function span(attributes: Record<string, string | number>): OtelPayload {
    return {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: 'chat.request',
                  startTimeUnixNano: '1780000000000000000',
                  attributes: Object.entries(attributes).map(([key, value]) => ({
                    key,
                    value:
                      typeof value === 'number' ? { doubleValue: value } : { stringValue: value },
                  })),
                },
              ],
            },
          ],
        },
      ],
    };
  }

  it('reads a well-formed span', () => {
    const result = ingestOtel(
      span({
        'gen_ai.request.model': 'gpt-4.1',
        'gen_ai.usage.input_tokens': 1200,
        'gen_ai.usage.output_tokens': 300,
        'chat.session.id': 'session-abc',
      }),
      'salt',
    );

    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.model).toBe('gpt-4.1');
    expect(result.turns[0]?.promptTokens).toBe(1200);
    expect(result.turns[0]?.sessionId).not.toContain('session-abc');
    expect(result.contentAttributesDropped).toBe(0);
  });

  it('drops content-bearing attributes and counts them loudly', () => {
    // A silent drop is indistinguishable from an empty payload, and the
    // count is the only thing that tells an operator their fleet is
    // emitting more than they think.
    const result = ingestOtel(
      span({
        'gen_ai.request.model': 'gpt-4.1',
        'gen_ai.prompt': 'the entire source file',
        'code.filepath': 'C:/work/secret/app.ts',
      }),
      'salt',
    );

    expect(result.contentAttributesDropped).toBe(2);
    expect(JSON.stringify(result.turns)).not.toContain('secret');
    expect(result.detail).toMatch(/captureContent` is on somewhere/);
  });

  it('skips a span with no model rather than inventing one', () => {
    const result = ingestOtel(span({ 'gen_ai.usage.input_tokens': 10 }), 'salt');
    expect(result.turns).toHaveLength(0);
    expect(result.spansSkipped).toBe(1);
  });

  it('lists every attribute it treats as content', () => {
    expect(CONTENT_ATTRIBUTES).toContain('gen_ai.prompt');
    expect(CONTENT_ATTRIBUTES).toContain('chat.tool.result');
    expect(CONTENT_ATTRIBUTES).toContain('file.path');
  });
});
