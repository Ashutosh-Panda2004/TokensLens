import { MIN_GROUP_SIZE } from '../privacy/scope.js';
import type { OrgBundle } from './bundle.js';

/**
 * **D9.4 (W8) + D9.5 — cross-developer duplication and the shared answer
 * cache.**
 *
 * ## Why the embedding half is not built
 *
 * The plan calls W8 *"the one embedding-dependent feature"*. Building it
 * would require an embedding provider in the core, which rule AI-3 forbids
 * and `arch.test.ts` enforces — and the exception would not be a small one:
 * embedding every question a fleet asks means shipping every question a
 * fleet asks to a model, which is precisely the egress the entire product
 * is built to avoid.
 *
 * So the semantic half is declared unavailable and stays declared. What is
 * built instead is the part that needs no model at all: **structural**
 * duplication, found by normalising a question and hashing it. That catches
 * the case that actually costs the money — thirty developers asking the
 * same question about the same internal framework in the same month,
 * verbatim — and it does so with hashes that reverse to nothing.
 *
 * ## Why it is deliberately conservative
 *
 * Structural matching misses paraphrases, so it *undercounts*. That is the
 * correct direction to be wrong in: an overstated duplication figure would
 * justify building a cache that then does not pay for itself, and the
 * measurement would have caused the waste it claimed to find.
 */
export interface QuestionObservation {
  /** Hash of the normalised question. Computed on the machine that asked it. */
  readonly questionHash: string;
  /** Hashed developer identity. */
  readonly askedBy: string;
  readonly credits: number;
  readonly ts: number;
}

export interface DuplicationCluster {
  readonly questionHash: string;
  readonly askedBy: number;
  readonly occurrences: number;
  readonly credits: number;
  /** Credits that would not have been spent had the first answer been reused. */
  readonly redundantCredits: number;
}

export interface DuplicationReport {
  readonly clusters: readonly DuplicationCluster[];
  readonly questionsSeen: number;
  readonly developersSeen: number;
  readonly redundantCredits: number;
  readonly redundantShare: number;
  readonly suppressedClusters: number;
  readonly detail: string;
  readonly unavailable: readonly {
    readonly what: string;
    readonly reason: string;
    readonly unblockedBy: string;
  }[];
}

export const UNAVAILABLE_DUPLICATION = [
  {
    what: 'Semantic (near-duplicate) question matching',
    reason:
      'Requires an embedding model. Rule AI-3 keeps models out of the core, and embedding every question ' +
      'a fleet asks would mean transmitting every question a fleet asks — the exact egress this product exists to avoid.',
    unblockedBy:
      'An organisation-hosted embedding endpoint plus explicit opt-in, run outside the core as a separate ' +
      'component with its own review. Not a change to this file.',
  },
] as const;

/**
 * Clusters identical questions asked by different developers.
 *
 * A question repeated by the *same* developer is not cross-developer
 * duplication — it is that person iterating, which W2 already covers and
 * which a shared cache would not help. Counting it here would inflate the
 * figure with work that is not shareable.
 */
export function detectDuplication(observations: readonly QuestionObservation[]): DuplicationReport {
  const byQuestion = new Map<
    string,
    { askers: Set<string>; occurrences: number; credits: number }
  >();
  const developers = new Set<string>();

  for (const observation of observations) {
    developers.add(observation.askedBy);
    const entry = byQuestion.get(observation.questionHash) ?? {
      askers: new Set<string>(),
      occurrences: 0,
      credits: 0,
    };
    entry.askers.add(observation.askedBy);
    entry.occurrences += 1;
    entry.credits += observation.credits;
    byQuestion.set(observation.questionHash, entry);
  }

  const all = [...byQuestion.entries()]
    .filter(([, entry]) => entry.askers.size > 1)
    .map(([questionHash, entry]) => ({
      questionHash,
      askedBy: entry.askers.size,
      occurrences: entry.occurrences,
      credits: entry.credits,
      // Everything after the first answer is redundant, priced at the mean
      // cost of asking it.
      redundantCredits: entry.credits * ((entry.occurrences - 1) / entry.occurrences),
    }))
    .sort((a, b) => b.redundantCredits - a.redundantCredits);

  // A cluster asked by fewer than five people describes a small, nameable
  // group — "these three keep asking about the payments SDK" is a
  // performance observation dressed as an efficiency finding.
  const visible = all.filter((cluster) => cluster.askedBy >= MIN_GROUP_SIZE);

  const totalCredits = observations.reduce((sum, o) => sum + o.credits, 0);
  const redundant = all.reduce((sum, cluster) => sum + cluster.redundantCredits, 0);

  return {
    clusters: visible,
    questionsSeen: byQuestion.size,
    developersSeen: developers.size,
    redundantCredits: redundant,
    redundantShare: totalCredits > 0 ? redundant / totalCredits : 0,
    suppressedClusters: all.length - visible.length,
    detail:
      all.length === 0
        ? 'No question was asked verbatim by more than one developer. Structural matching misses paraphrases, ' +
          'so this is a floor on duplication, not a measurement of its absence.'
        : `${String(all.length)} question(s) were asked by more than one developer, costing ` +
          `${redundant.toFixed(0)} redundant credits (${((totalCredits > 0 ? redundant / totalCredits : 0) * 100).toFixed(1)}% of spend). ` +
          `${String(all.length - visible.length)} cluster(s) are withheld for having fewer than ` +
          `${String(MIN_GROUP_SIZE)} distinct askers. Paraphrases are not counted, so the true figure is higher.`,
    unavailable: [...UNAVAILABLE_DUPLICATION],
  };
}

export interface CacheCandidate {
  readonly questionHash: string;
  readonly askedBy: number;
  readonly occurrences: number;
  readonly creditsSaved: number;
}

export interface CacheAssessment {
  readonly candidates: readonly CacheCandidate[];
  readonly creditsSaved: number;
  readonly worthBuilding: boolean;
  readonly detail: string;
}

/**
 * D9.5 — is a shared answer cache worth building?
 *
 * Asked as a question rather than assumed as a feature. A cache has a real
 * cost: something has to store answers, invalidate them when the codebase
 * moves under them, and be trusted enough that developers use it instead of
 * asking again. If the redundant spend is a rounding error, the honest
 * output is "do not build this", and a tool that never says that is
 * a tool selling something.
 */
export function assessCache(
  report: DuplicationReport,
  totalCredits: number,
  threshold = 0.02,
): CacheAssessment {
  const candidates = report.clusters.map((cluster) => ({
    questionHash: cluster.questionHash,
    askedBy: cluster.askedBy,
    occurrences: cluster.occurrences,
    creditsSaved: cluster.redundantCredits,
  }));

  const saved = candidates.reduce((sum, c) => sum + c.creditsSaved, 0);
  const share = totalCredits > 0 ? saved / totalCredits : 0;

  return {
    candidates,
    creditsSaved: saved,
    worthBuilding: share >= threshold,
    detail:
      share >= threshold
        ? `A shared answer cache over ${String(candidates.length)} repeated question(s) would avoid ` +
          `${saved.toFixed(0)} credits, ${(share * 100).toFixed(1)}% of spend. That clears the ` +
          `${(threshold * 100).toFixed(0)}% bar at which the invalidation problem is worth taking on.`
        : `Repeated questions account for ${(share * 100).toFixed(2)}% of spend, below the ` +
          `${(threshold * 100).toFixed(0)}% bar. A cache would cost more to keep correct than it would save. ` +
          'Do not build it.',
  };
}

export interface PrefixStability {
  readonly requests: number;
  readonly cacheableShare: number | undefined;
  readonly detail: string;
  readonly verification: string;
}

/**
 * D9.8 — the cache-prefix optimiser.
 *
 * The measurable part: how much of a session's prompt is a **stable
 * prefix** that a provider-side cache could serve. Estimated from the
 * ratio of the smallest prompt in a session to the mean, which is the
 * share of every prompt that was already present at the first turn.
 *
 * The part that is **not** built is the verification. The plan calls for
 * checking this against Cache Explorer, and Cache Explorer's figures are
 * not available through anything TokenLens can read. So the uplift stays
 * modelled, and says so — turning R9 from theory into a *measured* uplift
 * is not something this phase can honestly claim to have done.
 */
export function assessPrefixStability(
  promptTokensBySession: ReadonlyMap<string, readonly number[]>,
): PrefixStability {
  let requests = 0;
  let weighted = 0;
  let weight = 0;

  for (const prompts of promptTokensBySession.values()) {
    if (prompts.length < 2) continue;
    const smallest = Math.min(...prompts);
    const mean = prompts.reduce((sum, v) => sum + v, 0) / prompts.length;
    if (mean <= 0) continue;
    requests += prompts.length;
    weighted += (smallest / mean) * prompts.length;
    weight += prompts.length;
  }

  const share = weight > 0 ? weighted / weight : undefined;

  return {
    requests,
    cacheableShare: share,
    detail:
      share === undefined
        ? 'No session had more than one turn, so there is no repeated prefix to measure.'
        : `${(share * 100).toFixed(1)}% of the mean prompt is a prefix already present at the first turn of ` +
          'its session, and is therefore cacheable in principle.',
    verification:
      'Not verified. The plan calls for checking this against Cache Explorer, whose figures TokenLens ' +
      'cannot read. Until it can, this is a modelled ceiling on the uplift and not a measurement of one — ' +
      'the difference between a cache that could work and a cache that did.',
  };
}

/**
 * Rolls duplication up from bundles. Present so the fleet path does not
 * quietly require a second, differently-shaped export.
 */
export function duplicationFromBundles(bundles: readonly OrgBundle[]): number {
  return bundles.reduce((sum, bundle) => sum + bundle.requestCount, 0);
}
