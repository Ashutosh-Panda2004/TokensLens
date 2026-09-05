import { sampleConfidence, withEffectSize } from '../scoring.js';
import { formatCount, formatCredits, formatPercent } from '../format.js';
import { modelled } from '../../model/provenance.js';
import { MIN_GROUP_SIZE } from '../../privacy/scope.js';
import type { DetectContext, Evidence, WasteDetector, WasteFinding } from '../types.js';

/**
 * **W8 · The same question, asked many times** (R12) — the one class a single
 * machine genuinely cannot see.
 *
 * Five developers on the same team hit the same undocumented behaviour in the
 * same internal SDK in the same fortnight. Each asks. Each is answered from
 * scratch. Four of those answers were already paid for.
 *
 * ## Why this detector is thin, and why that is correct
 *
 * Every other detector reads the journal on this laptop. This one cannot: the
 * evidence is *other people's* questions, and there is no honest way to
 * approximate them from here. So the detector consumes `ctx.org` — the
 * duplication report D9 already produces from synced, aggregated, hashed
 * bundles — and returns nothing when it is absent. Absent is the normal case,
 * and the report says so with the reason attached rather than implying the
 * waste is zero.
 *
 * The alternative, inferring cross-developer duplication from one developer's
 * repeated questions, would be measuring W2 and calling it W8. A person
 * iterating on their own question is not duplication that a shared answer would
 * have prevented.
 *
 * ## What it counts, and the direction it is wrong in
 *
 * Only **verbatim** question hashes, and only across **distinct** developers.
 * Paraphrases are missed, so the figure is a floor. That is the right direction:
 * an overstated duplication number would justify building a cache that never
 * pays for itself, and the measurement would have caused the waste it claimed
 * to find. Semantic matching stays unbuilt because it needs an embedding model,
 * which AI-3 forbids in core — and that is precisely why D11 treats W8 as the
 * one class where an external tool is the right shape of answer.
 *
 * Clusters with fewer than `MIN_GROUP_SIZE` distinct askers are suppressed
 * upstream in `org/duplication.ts`. *"These three keep asking about the payments
 * SDK"* is a performance observation dressed as an efficiency finding, and this
 * detector must not be the thing that leaks it.
 */
export class CrossDeveloperDuplicationDetector implements WasteDetector {
  readonly class = 'W8' as const;
  readonly name = 'The same question, asked many times';

  detect(ctx: DetectContext): WasteFinding[] {
    const org = ctx.org;
    if (org === undefined) return [];
    if (org.developersSeen < MIN_GROUP_SIZE) return [];
    if (org.clusters.length === 0) return [];

    const redundantCredits = org.clusters.reduce(
      (sum, cluster) => sum + cluster.redundantCredits,
      0,
    );
    if (redundantCredits <= 0) return [];

    const occurrences = org.clusters.reduce((sum, cluster) => sum + cluster.occurrences, 0);
    const worst = [...org.clusters]
      .sort((a, b) => b.redundantCredits - a.redundantCredits)
      .slice(0, MAX_LISTED);

    const evidence: Evidence[] = [
      {
        kind: 'session',
        ref: 'ALL',
        detail:
          `${formatCount(org.clusters.length)} question(s) were asked verbatim by ` +
          `${String(MIN_GROUP_SIZE)} or more distinct developers across ` +
          `${formatCount(org.developersSeen)} seen, over ${formatCount(occurrences)} occurrences`,
        credits: redundantCredits,
      },
      {
        kind: 'session',
        ref: 'SUPPRESSED',
        detail:
          `${formatCount(org.suppressedClusters)} further cluster(s) are withheld for having fewer ` +
          `than ${String(MIN_GROUP_SIZE)} distinct askers \u2014 a small named group is a person, not a pattern`,
      },
      ...worst.map((cluster): Evidence => ({
        kind: 'session',
        ref: cluster.questionHash,
        detail:
          `asked by ${formatCount(cluster.askedBy)} developers, ` +
          `${formatCount(cluster.occurrences)} times in total`,
        credits: cluster.redundantCredits,
      })),
    ];

    return [
      {
        class: this.class,
        title: `${formatPercent(org.redundantShare)} of fleet spend answered a question already answered`,
        credits: modelled(
          redundantCredits,
          'credits of every occurrence after the first, for question hashes seen from more than one developer in the organisation rollup',
          [
            'matches questions structurally, never semantically \u2014 paraphrases are not counted, so this is a floor on duplication rather than a measurement of it',
            'assumes the second asker would have accepted the first answer, which is a counterfactual: two people may both genuinely need the same thing explained',
            'prices each occurrence at the mean cost of asking that question, because the rollup carries aggregates rather than per-request credits',
            `clusters with fewer than ${String(MIN_GROUP_SIZE)} distinct askers are excluded entirely, so the figure is additionally suppressed by the privacy floor`,
          ],
        ),
        confidence: withEffectSize(
          sampleConfidence(org.questionsSeen, 500),
          org.redundantShare / 0.1,
        ),
        evidence,
        remediation: {
          summary: `${formatCredits(redundantCredits)} credits re-answering questions the fleet had already answered`,
          tier: 'A',
          action:
            'Write down the thing five people asked about, and put a shared answer cache in front ' +
            'of the questions that recur. The documentation is free and permanent; the cache is ' +
            'the part worth measuring before building.',
        },
      },
    ];
  }
}

const MAX_LISTED = 10;
