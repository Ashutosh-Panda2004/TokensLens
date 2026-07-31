/**
 * **D8.1 · AUTO-24 — randomised, stratified cohort assignment.**
 *
 * Everything before this phase answers *"what would happen if"*. This one
 * answers *"did it"*, and the difference between those two questions is a
 * control group. Without one, the honest ceiling on any claim TokenLens
 * makes is a before/after chart, and a before/after chart cannot tell a
 * policy change apart from a quiet quarter.
 *
 * ## Why stratification is mandatory here, not merely advisable
 *
 * Copilot spend is savagely concentrated (finding F11): a small number of
 * developers account for most of the credits. Simple randomisation over a
 * fleet of, say, forty people can put the single largest spender in a 15%
 * holdout, and the control arm then represents a *different population*
 * from the treated arm before anything has been deployed. The experiment is
 * dead on arrival and — worse — it looks fine, because "we randomised" is
 * usually the end of the conversation.
 *
 * So units are stratified by **team** and by **pre-period spend decile**,
 * and randomised only *within* a stratum.
 *
 * ## Why per-stratum rounding is done by largest remainder
 *
 * The obvious implementation — hold out `round(n × 0.15)` per stratum —
 * silently produces a holdout of **zero** for every stratum smaller than
 * four people. On a fleet split into teams that is most of them, and the
 * resulting "15% holdout" is nothing of the sort. Largest-remainder
 * apportionment gives the exact global count and lets small strata
 * contribute their fair share of it.
 */
import { hashIdentifier } from '../privacy/identifiers.js';

export interface HoldoutUnit {
  /** Already-hashed identifier. Nothing in this module ever sees a name. */
  readonly unit: string;
  /** Stratification key — a team, squad or cost centre. */
  readonly team: string;
  /** Credits spent by this unit during the pre-period. */
  readonly preSpend: number;
}

export type Arm = 'treated' | 'holdout';

export interface Assignment {
  readonly unit: string;
  readonly team: string;
  readonly preSpend: number;
  readonly stratum: string;
  readonly arm: Arm;
}

export interface AssignOptions {
  /** Share of units withheld from the policy. Decision 6 in the plan: 15%. */
  readonly holdoutFraction?: number;
  /** Number of pre-spend strata. Deciles unless the fleet is too small to fill them. */
  readonly deciles?: number;
  /**
   * Fixed, and recorded in the pre-registration. A randomisation nobody can
   * reproduce is indistinguishable from one that was re-rolled until it
   * looked good.
   */
  readonly seed: number;
}

export const DEFAULT_HOLDOUT_FRACTION = 0.15;

/**
 * Standardised mean difference above which the arms are treated as
 * imbalanced. 0.1 is the conventional threshold in the trial literature —
 * chosen here because *some* fixed threshold has to be picked before the
 * numbers are seen, and picking one afterwards is how imbalance gets
 * explained away.
 */
export const BALANCE_THRESHOLD_SMD = 0.1;

export interface StratumBalance {
  readonly stratum: string;
  readonly treated: number;
  readonly holdout: number;
}

export interface BalanceReport {
  readonly treatedUnits: number;
  readonly holdoutUnits: number;
  readonly treatedMeanSpend: number;
  readonly holdoutMeanSpend: number;
  /** Standardised mean difference of pre-spend. `undefined` when there is no variance to standardise by. */
  readonly standardisedMeanDifference: number | undefined;
  readonly balanced: boolean;
  /** Share of total pre-period spend sitting in the holdout arm. */
  readonly holdoutSpendShare: number;
  /** Share of *headcount* in the holdout arm. Compare the two — see `concentrationWarning`. */
  readonly holdoutHeadcountShare: number;
  /** Share of all pre-period spend attributable to the single largest unit. */
  readonly topUnitSpendShare: number;
  readonly strata: readonly StratumBalance[];
  readonly detail: string;
  /**
   * Set when spend is concentrated enough that the arms cannot be balanced
   * by randomisation at this fleet size, whatever the assignment happened
   * to produce.
   */
  readonly concentrationWarning: string | undefined;
}

export type StratumDimensions = 'team+spend' | 'spend' | 'team' | 'none';

export interface HoldoutDesign {
  readonly assignments: readonly Assignment[];
  readonly holdoutFraction: number;
  readonly seed: number;
  readonly deciles: number;
  /** Which dimensions were actually used, which is not always what was asked for. */
  readonly dimensions: StratumDimensions;
  readonly dimensionsDetail: string;
  readonly balance: BalanceReport;
}

/**
 * Smallest stratum worth having.
 *
 * A stratum of one cannot be randomised: whichever arm its quota names, that
 * is where its member goes. Four is the smallest size at which a 15%
 * holdout has a meaningful draw within the cell.
 *
 * This constant exists because the first live run produced **35 strata for
 * 47 people** — 1.3 members per cell. The design was nominally stratified
 * and actually per-person, the balance check failed, and the report said
 * "35 strata (team × spend decile)" in a tone of complete confidence. A
 * stratifier that silently degenerates is worse than none, because the
 * label survives the mechanism.
 */
export const MIN_STRATUM_SIZE = 4;

interface StratumPlan {
  readonly dimensions: StratumDimensions;
  readonly buckets: number;
  readonly detail: string;
}

/**
 * Decides how finely the fleet can afford to be stratified.
 *
 * When the cell budget will not cover both dimensions, **spend wins**.
 * Concentration is the threat stratification exists to control here
 * (finding F11); team is a convenience for reporting. Crossing them on a
 * small fleet buys neither.
 */
function planStrata(units: number, teams: number, requestedDeciles: number): StratumPlan {
  const budget = Math.floor(units / MIN_STRATUM_SIZE);

  if (budget < 2) {
    return {
      dimensions: 'none',
      buckets: 1,
      detail:
        `${String(units)} unit(s) cannot support even two strata of ${String(MIN_STRATUM_SIZE)}. ` +
        'Randomisation is unstratified, and the balance check below is the only protection there is.',
    };
  }

  if (teams * requestedDeciles <= budget) {
    return {
      dimensions: 'team+spend',
      buckets: requestedDeciles,
      detail: `${String(teams)} team(s) × ${String(requestedDeciles)} spend bucket(s).`,
    };
  }

  const affordableBuckets = Math.min(requestedDeciles, budget);
  if (affordableBuckets >= 2) {
    return {
      dimensions: 'spend',
      buckets: affordableBuckets,
      detail:
        `${String(units)} unit(s) across ${String(teams)} team(s) cannot fill ${String(teams * requestedDeciles)} ` +
        `cells with ${String(MIN_STRATUM_SIZE)} members each, so the team dimension is dropped and ` +
        `${String(affordableBuckets)} spend bucket(s) are used. Spend is kept because concentration is the ` +
        'imbalance that actually threatens the estimate; team was only ever for reporting.',
    };
  }

  return {
    dimensions: 'team',
    buckets: 1,
    detail: `Too few units for spend buckets; stratified by team alone (${String(teams)} stratum/strata).`,
  };
}

/**
 * Deterministic PRNG. Not cryptographic and deliberately not
 * `crypto.randomInt`: a randomisation that cannot be re-derived from the
 * pre-registered seed cannot be audited, and "trust us, we shuffled" is the
 * claim this entire phase exists to avoid making.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = copy[i];
    const b = copy[j];
    if (a === undefined || b === undefined) continue;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

/**
 * Spend deciles, computed from the observed distribution rather than from
 * fixed credit boundaries — the point is to put units of *comparable* spend
 * in the same stratum, and what counts as comparable is a property of this
 * fleet.
 */
function spendStratum(rank: number, total: number, buckets: number): number {
  if (total <= 1) return 0;
  return Math.min(buckets - 1, Math.floor((rank * buckets) / total));
}

/**
 * Assigns units to arms.
 *
 * Deterministic in `(units, options)`: the same fleet and the same seed
 * always produce the same assignment, which is what makes the
 * pre-registration hash mean anything.
 */
export function assignHoldout(
  units: readonly HoldoutUnit[],
  options: AssignOptions,
): HoldoutDesign {
  const fraction = options.holdoutFraction ?? DEFAULT_HOLDOUT_FRACTION;
  const teams = new Set(units.map((unit) => unit.team)).size;
  const plan = planStrata(units.length, teams, Math.max(1, options.deciles ?? 10));

  // Sorted by spend, then by unit, so ties break identically on every run.
  const ordered = [...units].sort(
    (a, b) => a.preSpend - b.preSpend || a.unit.localeCompare(b.unit),
  );
  const strata = new Map<string, HoldoutUnit[]>();

  ordered.forEach((unit, index) => {
    const teamPart =
      plan.dimensions === 'team+spend' || plan.dimensions === 'team' ? unit.team : 'all';
    const spendPart =
      plan.dimensions === 'team+spend' || plan.dimensions === 'spend'
        ? String(spendStratum(index, ordered.length, plan.buckets))
        : '0';
    const key = `${teamPart}#${spendPart}`;
    const bucket = strata.get(key);
    if (bucket) bucket.push(unit);
    else strata.set(key, [unit]);
  });

  const target = Math.round(units.length * fraction);
  const random = mulberry32(options.seed);
  const quotas = apportion([...strata.entries()], fraction, target, random);

  const assignments: Assignment[] = [];

  // Strata are walked in a fixed key order so the RNG is consumed in the
  // same sequence every run, regardless of Map insertion order.
  for (const key of [...strata.keys()].sort()) {
    const members = strata.get(key) ?? [];
    const quota = quotas.get(key) ?? 0;
    const order = shuffled(members, random);
    order.forEach((unit, index) => {
      assignments.push({
        unit: unit.unit,
        team: unit.team,
        preSpend: unit.preSpend,
        stratum: key,
        arm: index < quota ? 'holdout' : 'treated',
      });
    });
  }

  assignments.sort((a, b) => a.unit.localeCompare(b.unit));

  return {
    assignments,
    holdoutFraction: fraction,
    seed: options.seed,
    deciles: plan.buckets,
    dimensions: plan.dimensions,
    dimensionsDetail: plan.detail,
    balance: assessBalance(assignments),
  };
}

/**
 * Largest-remainder apportionment of the holdout across strata.
 *
 * Each stratum gets `floor(n × f)` places, and the remaining places go to
 * the strata with the largest fractional entitlement. This is the Hare
 * quota, borrowed from seat allocation for exactly the reason it exists
 * there: independent rounding does not sum to the total, and the error
 * always lands on the smallest groups.
 *
 * ## Ties are broken randomly, and that is not a detail
 *
 * Equal-sized strata all have the same remainder, so the tie-break decides
 * which stratum misses out. The first version broke ties by stratum key,
 * which sorts spend buckets in ascending order — so the **highest-spending
 * decile was the one that never received a holdout place**, on every seed,
 * deterministically. The arms then differed systematically in exactly the
 * dimension the stratification existed to balance, and the effect was
 * invisible: each individual draw looked randomised.
 *
 * Caught by the test comparing stratified against unstratified balance,
 * which is the only check that would ever have noticed.
 */
function apportion(
  entries: readonly (readonly [string, readonly HoldoutUnit[]])[],
  fraction: number,
  target: number,
  random: () => number,
): Map<string, number> {
  const quotas = new Map<string, number>();
  const remainders: { key: string; remainder: number; capacity: number; jitter: number }[] = [];
  let allocated = 0;

  for (const [key, members] of entries) {
    const exact = members.length * fraction;
    const floor = Math.floor(exact);
    quotas.set(key, floor);
    allocated += floor;
    remainders.push({
      key,
      remainder: exact - floor,
      capacity: members.length - floor,
      jitter: random(),
    });
  }

  remainders.sort((a, b) => b.remainder - a.remainder || a.jitter - b.jitter);

  for (const entry of remainders) {
    if (allocated >= target) break;
    if (entry.capacity <= 0) continue;
    quotas.set(entry.key, (quotas.get(entry.key) ?? 0) + 1);
    allocated += 1;
  }

  return quotas;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function variance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
}

/**
 * D8 test `cohort.balance.test.ts` — does stratification actually balance
 * the spend deciles?
 *
 * Reports the standardised mean difference rather than a t-test p-value on
 * purpose. Balance is a question about the *size* of the difference between
 * arms; a significance test on it answers a different question, and answers
 * it more optimistically the smaller the fleet is — which is precisely
 * backwards.
 */
export function assessBalance(assignments: readonly Assignment[]): BalanceReport {
  const treated = assignments.filter((a) => a.arm === 'treated');
  const holdout = assignments.filter((a) => a.arm === 'holdout');
  const treatedSpend = treated.map((a) => a.preSpend);
  const holdoutSpend = holdout.map((a) => a.preSpend);

  const treatedMean = mean(treatedSpend);
  const holdoutMean = mean(holdoutSpend);
  const pooled = Math.sqrt((variance(treatedSpend) + variance(holdoutSpend)) / 2);
  const smd = pooled > 0 ? (treatedMean - holdoutMean) / pooled : undefined;

  const totalSpend = assignments.reduce((sum, a) => sum + a.preSpend, 0);
  const holdoutSpendTotal = holdoutSpend.reduce((sum, v) => sum + v, 0);
  const topSpend = assignments.reduce((max, a) => Math.max(max, a.preSpend), 0);

  const strataMap = new Map<string, { treated: number; holdout: number }>();
  for (const a of assignments) {
    const row = strataMap.get(a.stratum) ?? { treated: 0, holdout: 0 };
    if (a.arm === 'treated') row.treated += 1;
    else row.holdout += 1;
    strataMap.set(a.stratum, row);
  }

  const holdoutSpendShare = totalSpend > 0 ? holdoutSpendTotal / totalSpend : 0;
  const holdoutHeadcountShare = assignments.length > 0 ? holdout.length / assignments.length : 0;
  const topUnitSpendShare = totalSpend > 0 ? topSpend / totalSpend : 0;

  const balanced = smd === undefined || Math.abs(smd) <= BALANCE_THRESHOLD_SMD;

  return {
    treatedUnits: treated.length,
    holdoutUnits: holdout.length,
    treatedMeanSpend: treatedMean,
    holdoutMeanSpend: holdoutMean,
    standardisedMeanDifference: smd,
    balanced,
    holdoutSpendShare,
    holdoutHeadcountShare,
    topUnitSpendShare,
    strata: [...strataMap.entries()]
      .map(([stratum, row]) => ({ stratum, ...row }))
      .sort((a, b) => a.stratum.localeCompare(b.stratum)),
    detail:
      smd === undefined
        ? 'Pre-spend is identical across every unit, so there is nothing to balance and nothing to check.'
        : balanced
          ? `Standardised mean difference in pre-spend is ${smd.toFixed(3)}, within the ${String(BALANCE_THRESHOLD_SMD)} threshold.`
          : `Standardised mean difference in pre-spend is ${smd.toFixed(3)}, beyond the ${String(BALANCE_THRESHOLD_SMD)} threshold. ` +
            'The arms are not comparable at baseline; re-drawing with a different seed after seeing this is ' +
            'p-hacking, so widen the fleet or accept that the estimate carries this bias and say so.',
    concentrationWarning: concentrationWarning(topUnitSpendShare, assignments.length),
  };
}

/**
 * The failure that stratification cannot fix.
 *
 * If one developer is a large fraction of all spend, then whichever arm
 * they land in is dominated by them, and no amount of balancing on the
 * remaining units changes that. This is worth saying out loud *before* the
 * experiment starts, because afterwards it reads as an excuse.
 */
function concentrationWarning(topShare: number, unitCount: number): string | undefined {
  if (unitCount === 0) return undefined;
  const fairShare = 1 / unitCount;
  if (topShare < Math.max(0.25, fairShare * 5)) return undefined;
  return (
    `The largest single unit accounts for ${(topShare * 100).toFixed(0)}% of pre-period spend. ` +
    'At this concentration the arm containing that unit is effectively a sample of one, and ' +
    'randomisation cannot repair it. Either aggregate to team level so the unit of randomisation is ' +
    'larger than the concentration, or report the result as suggestive rather than causal.'
  );
}

/**
 * Reads a fleet roster: `identifier,team,pre-period-credits`.
 *
 * The identifier is hashed on read with the install salt, the same
 * construction git authors and journal sessions go through. A roster naming
 * real people therefore produces a design that names nobody, and the join
 * to spend data still works.
 */
export function parseRoster(csv: string, salt: string): HoldoutUnit[] {
  const units: HoldoutUnit[] = [];
  const seen = new Set<string>();

  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const [rawId, rawTeam, rawSpend] = trimmed.split(',').map((part) => part.trim());
    if (rawId === undefined || rawId === '') continue;
    if (rawId.toLowerCase() === 'identifier' || rawId.toLowerCase() === 'email') continue;

    const unit = hashIdentifier(rawId.toLowerCase(), salt);
    if (seen.has(unit)) continue;
    seen.add(unit);

    const spend = Number.parseFloat(rawSpend ?? '');
    units.push({
      unit,
      team: rawTeam === undefined || rawTeam === '' ? 'unassigned' : rawTeam,
      preSpend: Number.isFinite(spend) ? spend : 0,
    });
  }

  return units;
}
