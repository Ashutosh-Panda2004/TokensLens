import type Database from 'better-sqlite3';
import { buildDetectContext } from '../waste/context.js';
import { buildLedger } from '../ledger/ledger.js';
import { forecastBudget, type CopilotPlan } from '../ledger/budget.js';
import { assertReportSafe } from '../privacy/guard.js';
import {
  assessCeiling,
  splitAtCeiling,
  type CeilingSplit,
  type ContractCeiling,
} from './ceiling.js';
import { LEVERS, type Lever, type LeverId, type LeverPlan, type RiskNote } from './levers.js';
import { Counterfactual, type RealisationBand, type SavingBand } from './replay.js';
import { NULL_POLICY, type NotSimulated, type Policy } from './policy.js';
import type { DetectContext, Evidence, RemediationTier } from '../waste/types.js';
import type { PrivacyContext } from '../privacy/scope.js';

/**
 * A simulation report contains no per-request or per-session reference by
 * construction — every figure is an aggregate and every evidence `ref` is a
 * tool name, a model id or `ALL`. It is therefore safe in either scope, and
 * the default is still the restrictive one: fail closed.
 */
const DEFAULT_PRIVACY: PrivacyContext = { scope: 'shared', subjectCount: 1 };

export interface LeverResult {
  readonly id: LeverId;
  readonly name: string;
  readonly tier: RemediationTier;
  readonly action: string;
  readonly requestsAffected: number;
  /** Saving from this lever **alone**, before any overlap with the others. */
  readonly credits: SavingBand;
  /** `credits.theoretical` as a fraction of baseline spend. */
  readonly shareOfBaseline: number;
  readonly assumptions: readonly string[];
  readonly risks: readonly RiskNote[];
  readonly evidence: readonly Evidence[];
}

export interface SimulationReport {
  readonly baselineCredits: number;
  readonly requestCount: number;
  readonly requestsAffected: number;
  readonly levers: readonly LeverResult[];
  /**
   * The answer: every lever applied to the same requests in one replay.
   * Overlap is resolved exactly, because a token removed by one lever is
   * no longer there for the next to remove.
   */
  readonly combined: SavingBand;
  /** `combined` as a fraction of baseline spend. */
  readonly reduction: SavingBand;
  /**
   * What adding the individual figures together would have given. Reported
   * **because it is wrong** — it is the number a naive tool would print,
   * and the gap between it and `combined` is the overlap it would have
   * double-counted.
   */
  readonly naiveSumCredits: number;
  readonly overlapCredits: number;
  /**
   * `1 - ∏(1 - tᵢ)` from PLAN.md §20.1, kept as a cross-check on the joint
   * replay rather than as the answer. The formula assumes levers overlap
   * independently; the replay does not have to assume anything, so where
   * they disagree the replay is right and the difference is a measure of
   * how far this corpus departs from independence.
   */
  readonly multiplicativeEstimateCredits: number;
  readonly ceiling: ContractCeiling;
  /** Cash-versus-unused-allowance split at each end of the realisation band. */
  readonly cash: { readonly low: CeilingSplit; readonly high: CeilingSplit };
  /** Policy lines that were understood but could not be costed, with reasons. */
  readonly notSimulated: readonly NotSimulated[];
  readonly privacy: PrivacyContext;
}

export interface SimulationOptions {
  readonly privacy?: PrivacyContext;
  /** Carried through from the policy parser so the report can state what it skipped. */
  readonly notSimulated?: readonly NotSimulated[];
  readonly plan?: CopilotPlan;
  readonly seats?: number;
  /** Injectable so the determinism test is not a function of the calendar. */
  readonly now?: Date;
}

/**
 * Replays the recorded corpus under `policy` and reports what it would have
 * cost (DEVELOPMENT-PLAN.md D4.1).
 *
 * ## The three numbers, and which one is the answer
 *
 * Each lever is replayed **alone** to get its standalone saving, then all of
 * them are replayed **together**. Those are different questions and the
 * difference is the whole point: a request that is both on an over-powered
 * model and inside a runaway loop is claimed by two levers, and adding
 * their savings would bill the same credits twice. Phase D3's waste report
 * had to flag that overlap and refuse to total its findings; this is the
 * phase that resolves it.
 *
 * The joint replay is the answer. The naive sum is printed next to it so a
 * reader can see the size of what was *not* claimed.
 */
export function buildSimulation(
  db: Database.Database,
  policy: Policy,
  options: SimulationOptions = {},
): SimulationReport {
  const privacy = options.privacy ?? DEFAULT_PRIVACY;
  const ctx = buildDetectContext(db);

  const planned = LEVERS.map((lever) => ({ lever, plan: lever.plan(policy, ctx) })).filter(
    (entry): entry is { lever: Lever; plan: LeverPlan } => entry.plan !== undefined,
  );

  const baselineCredits = new Counterfactual(ctx, 'theoretical').baselineCredits;

  const levers: LeverResult[] = planned.map(({ lever, plan }) => {
    const credits = replayBand(ctx, [{ lever, plan }]);
    return {
      id: lever.id,
      name: lever.name,
      tier: lever.tier,
      action: lever.action,
      requestsAffected: new Set(plan.changes.map((change) => change.requestId)).size,
      credits,
      shareOfBaseline: baselineCredits > 0 ? credits.theoretical / baselineCredits : 0,
      assumptions: plan.assumptions,
      risks: plan.risks,
      evidence: plan.evidence,
    };
  });

  // Ranked by what they save, so the report reads as a decision list.
  // Ties broken by id to keep the ordering reproducible.
  levers.sort((a, b) => b.credits.theoretical - a.credits.theoretical || a.id.localeCompare(b.id));

  const combined = replayBand(ctx, planned);
  const naiveSumCredits = levers.reduce((sum, lever) => sum + lever.credits.theoretical, 0);

  const multiplicativeShare =
    1 - levers.reduce((product, lever) => product * (1 - lever.shareOfBaseline), 1);

  const reduction: SavingBand = {
    theoretical: share(combined.theoretical, baselineCredits),
    low: share(combined.low, baselineCredits),
    high: share(combined.high, baselineCredits),
  };

  const ceiling = assessCeiling(
    forecastBudget(buildLedger(db), options.plan ?? 'enterprise', options.now)
      .projectedMonthEndCredits,
    { plan: options.plan ?? 'enterprise', seats: options.seats ?? 1 },
  );

  const report: SimulationReport = {
    baselineCredits,
    requestCount: ctx.requests.length,
    requestsAffected: new Set(
      planned.flatMap(({ plan }) => plan.changes.map((change) => change.requestId)),
    ).size,
    levers,
    combined,
    reduction,
    naiveSumCredits,
    overlapCredits: naiveSumCredits - combined.theoretical,
    multiplicativeEstimateCredits: multiplicativeShare * baselineCredits,
    ceiling,
    cash: {
      low: splitAtCeiling(ceiling, reduction.low),
      high: splitAtCeiling(ceiling, reduction.high),
    },
    notSimulated: options.notSimulated ?? [],
    privacy,
  };

  // The same gate the ledger, waste and export paths pass through. This
  // report should never trip it; running it anyway is the point of a gate
  // that cannot be forgotten.
  assertReportSafe(report, privacy);
  return report;
}

/** The control case: an empty policy must produce a report saving exactly zero. */
export function buildNullSimulation(
  db: Database.Database,
  options: SimulationOptions = {},
): SimulationReport {
  return buildSimulation(db, NULL_POLICY, options);
}

function replayBand(
  ctx: DetectContext,
  planned: readonly { lever: Lever; plan: LeverPlan }[],
): SavingBand {
  return {
    theoretical: replayAt(ctx, planned, 'theoretical'),
    low: replayAt(ctx, planned, 'low'),
    high: replayAt(ctx, planned, 'high'),
  };
}

function replayAt(
  ctx: DetectContext,
  planned: readonly { lever: Lever; plan: LeverPlan }[],
  band: RealisationBand,
): number {
  const counterfactual = new Counterfactual(ctx, band);
  for (const { lever, plan } of planned) {
    for (const change of plan.changes) {
      // A lever's token effect and rate effect are combined *before* the
      // realisation rate is applied. Damping them separately lets a lever's
      // internal cost outrun its own benefit — see `Counterfactual.scale`.
      const net = (change.tokenScale ?? 1) * (change.rateScale ?? 1);
      counterfactual.scale(change.requestId, net, lever.tier);
    }
  }
  return counterfactual.savedCredits;
}

function share(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}
