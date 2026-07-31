import { MIN_GROUP_SIZE } from '../privacy/scope.js';
import type { OrgBundle } from './bundle.js';

/**
 * **D9.3 + D9.9 — the fleet view, and the end of extrapolation.**
 *
 * ## D9.9 is the important half
 *
 * Every headline figure in `PLAN.md` Part I is a single developer's
 * measured spend multiplied by a seat count. That extrapolation was
 * declared a risk when it was written (risk 4), and it is wrong in a
 * specific, knowable direction: spend is concentrated, so scaling the
 * *mean* overstates the fleet, while scaling the *median* understates it,
 * and neither error is small.
 *
 * The moment more than one install syncs, the extrapolation is obsolete —
 * and this module's job is to make it obsolete rather than to add a second
 * source of truth beside it. `measuredDistribution` returns percentiles, a
 * Gini coefficient and the top-decile share, all of which the extrapolation
 * assumed away.
 *
 * ## k-anonymity is applied to rows, not to the total
 *
 * A team of two is suppressed as a *row*, but its credits still count
 * toward the fleet total. Dropping small teams from the total would make
 * the fleet figure quietly wrong, and the reason it was wrong would be a
 * privacy control — which is how privacy controls acquire a reputation for
 * making numbers useless.
 */
export interface TeamRollup {
  readonly team: string;
  readonly developers: number;
  readonly installs: number;
  readonly credits: number;
  readonly requests: number;
  readonly creditsPerDeveloper: number;
  readonly suppressed: boolean;
}

export interface ModelRollup {
  readonly model: string;
  readonly credits: number;
  readonly requests: number;
  readonly share: number;
}

export interface WasteRollup {
  readonly class: string;
  readonly credits: number;
  readonly share: number;
  readonly installsAffected: number;
}

export interface ToolSurfaceRollup {
  readonly server: string;
  readonly installs: number;
  readonly toolCount: number;
  readonly invocations: number;
  readonly invocationsPerInstall: number;
}

export interface SpendDistribution {
  readonly installs: number;
  readonly mean: number;
  readonly median: number;
  readonly p10: number;
  readonly p90: number;
  readonly p99: number;
  /**
   * 0 = perfectly even, 1 = one install spends everything. `undefined`
   * below {@link MIN_INSTALLS_FOR_DISTRIBUTION} — see `measuredDistribution`.
   */
  readonly gini: number | undefined;
  readonly topDecileShare: number | undefined;
  readonly estimable: boolean;
  readonly detail: string;
}

export interface OrgRollup {
  readonly installs: number;
  readonly developers: number;
  readonly totalCredits: number;
  readonly measuredShare: number;
  readonly requestCount: number;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly byTeam: readonly TeamRollup[];
  readonly byModel: readonly ModelRollup[];
  readonly byWasteClass: readonly WasteRollup[];
  readonly toolSurface: readonly ToolSurfaceRollup[];
  readonly distribution: SpendDistribution;
  readonly suppressedTeams: number;
  readonly extrapolationRetired: boolean;
  readonly detail: string;
}

export function rollUp(bundles: readonly OrgBundle[]): OrgRollup {
  const developers = bundles.reduce((sum, b) => sum + b.developers, 0);
  const totalCredits = bundles.reduce((sum, b) => sum + b.totalCredits, 0);
  const measured = bundles.reduce((sum, b) => sum + b.measuredCredits, 0);
  const requests = bundles.reduce((sum, b) => sum + b.requestCount, 0);

  const froms = bundles.map((b) => b.periodFrom).filter((v) => v !== '');
  const tos = bundles.map((b) => b.periodTo).filter((v) => v !== '');

  return {
    installs: bundles.length,
    developers,
    totalCredits,
    measuredShare: totalCredits > 0 ? measured / totalCredits : 0,
    requestCount: requests,
    periodFrom: froms.length > 0 ? froms.reduce((a, b) => (a < b ? a : b)) : '',
    periodTo: tos.length > 0 ? tos.reduce((a, b) => (a > b ? a : b)) : '',
    byTeam: rollTeams(bundles),
    byModel: rollModels(bundles, totalCredits),
    byWasteClass: rollWaste(bundles, totalCredits),
    toolSurface: rollToolSurface(bundles),
    distribution: measuredDistribution(bundles),
    suppressedTeams: rollTeams(bundles).filter((t) => t.suppressed).length,
    extrapolationRetired: bundles.length >= MIN_GROUP_SIZE,
    detail:
      bundles.length >= MIN_GROUP_SIZE
        ? `Fleet figures come from ${String(bundles.length)} measured install(s). The single-developer ` +
          'extrapolation in PLAN.md Part I is superseded and should not be quoted alongside these.'
        : `Only ${String(bundles.length)} install(s) have synced — fewer than the ${String(MIN_GROUP_SIZE)} ` +
          'needed to report a fleet distribution safely. The extrapolation stands until then, with all the ' +
          'error it carries.',
  };
}

function rollTeams(bundles: readonly OrgBundle[]): TeamRollup[] {
  const byTeam = new Map<
    string,
    { developers: number; installs: number; credits: number; requests: number }
  >();

  for (const bundle of bundles) {
    const row = byTeam.get(bundle.team) ?? { developers: 0, installs: 0, credits: 0, requests: 0 };
    row.developers += bundle.developers;
    row.installs += 1;
    row.credits += bundle.totalCredits;
    row.requests += bundle.requestCount;
    byTeam.set(bundle.team, row);
  }

  return [...byTeam.entries()]
    .map(([team, row]) => {
      const suppressed = row.developers < MIN_GROUP_SIZE;
      return {
        // A team of fewer than five is a description of individuals however
        // it is labelled, so the label goes too.
        team: suppressed ? `withheld (<${String(MIN_GROUP_SIZE)} developers)` : team,
        developers: row.developers,
        installs: row.installs,
        credits: row.credits,
        requests: row.requests,
        creditsPerDeveloper: row.developers > 0 ? row.credits / row.developers : 0,
        suppressed,
      };
    })
    .sort((a, b) => b.credits - a.credits);
}

function rollModels(bundles: readonly OrgBundle[], total: number): ModelRollup[] {
  const byModel = new Map<string, { credits: number; requests: number }>();
  for (const bundle of bundles) {
    for (const model of bundle.byModel) {
      const row = byModel.get(model.model) ?? { credits: 0, requests: 0 };
      row.credits += model.credits;
      row.requests += model.requests;
      byModel.set(model.model, row);
    }
  }
  return [...byModel.entries()]
    .map(([model, row]) => ({
      model,
      credits: row.credits,
      requests: row.requests,
      share: total > 0 ? row.credits / total : 0,
    }))
    .sort((a, b) => b.credits - a.credits);
}

function rollWaste(bundles: readonly OrgBundle[], total: number): WasteRollup[] {
  const byClass = new Map<string, { credits: number; installs: number }>();
  for (const bundle of bundles) {
    for (const finding of bundle.byWasteClass) {
      const row = byClass.get(finding.class) ?? { credits: 0, installs: 0 };
      row.credits += finding.credits;
      row.installs += 1;
      byClass.set(finding.class, row);
    }
  }
  return [...byClass.entries()]
    .map(([cls, row]) => ({
      class: cls,
      credits: row.credits,
      share: total > 0 ? row.credits / total : 0,
      installsAffected: row.installs,
    }))
    .sort((a, b) => b.credits - a.credits);
}

function rollToolSurface(bundles: readonly OrgBundle[]): ToolSurfaceRollup[] {
  const byServer = new Map<string, { installs: number; tools: number; invocations: number }>();
  for (const bundle of bundles) {
    for (const surface of bundle.toolSurface) {
      const row = byServer.get(surface.server) ?? { installs: 0, tools: 0, invocations: 0 };
      row.installs += 1;
      // The widest surface any install saw, not the sum: the same server
      // installed twice does not have twice the tools.
      row.tools = Math.max(row.tools, surface.toolCount);
      row.invocations += surface.invocations;
      byServer.set(surface.server, row);
    }
  }
  return [...byServer.entries()]
    .map(([server, row]) => ({
      server,
      installs: row.installs,
      toolCount: row.tools,
      invocations: row.invocations,
      invocationsPerInstall: row.installs > 0 ? row.invocations / row.installs : 0,
    }))
    .sort((a, b) => b.invocations - a.invocations);
}

/**
 * D9.9 — the measured distribution that retires the extrapolation.
 *
 * The Gini coefficient is included because it is the single number that
 * says whether a mean is safe to multiply by a seat count. Above roughly
 * 0.5 it is not, and every per-seat figure in the plan needs re-reading as
 * a statement about the median developer rather than the average one.
 *
 * ## Why it refuses to answer on a small fleet
 *
 * The first live run of `org rollup` had one install and reported
 * *"Gini 0.00: spend is spread evenly enough that the mean is a reasonable
 * per-seat figure"*. Both halves were nonsense: a Gini computed from a
 * single observation is zero by construction, and the sentence then used
 * that artefact to reassure the reader about the exact extrapolation this
 * phase exists to retire. A confident statement derived from no evidence
 * is worse than silence, so below five installs the figure is withheld and
 * the extrapolation is explicitly said to still stand.
 */
export const MIN_INSTALLS_FOR_DISTRIBUTION = MIN_GROUP_SIZE;

export function measuredDistribution(bundles: readonly OrgBundle[]): SpendDistribution {
  const perInstall = bundles
    .map((b) => (b.developers > 0 ? b.totalCredits / b.developers : b.totalCredits))
    .sort((a, b) => a - b);

  if (perInstall.length === 0) {
    return {
      installs: 0,
      mean: 0,
      median: 0,
      p10: 0,
      p90: 0,
      p99: 0,
      gini: undefined,
      topDecileShare: undefined,
      estimable: false,
      detail:
        'No installs have synced, so there is no distribution and the extrapolation still stands.',
    };
  }

  const total = perInstall.reduce((sum, v) => sum + v, 0);
  const mean = total / perInstall.length;
  const summary = {
    installs: perInstall.length,
    mean,
    median: percentile(perInstall, 0.5),
    p10: percentile(perInstall, 0.1),
    p90: percentile(perInstall, 0.9),
    p99: percentile(perInstall, 0.99),
  };

  if (perInstall.length < MIN_INSTALLS_FOR_DISTRIBUTION) {
    return {
      ...summary,
      gini: undefined,
      topDecileShare: undefined,
      estimable: false,
      detail:
        `${String(perInstall.length)} install(s) is not a distribution. Concentration is withheld rather ` +
        `than reported as zero — a Gini computed from ${String(perInstall.length)} observation(s) is an ` +
        'artefact of the sample size, and quoting it would reassure a reader about precisely the ' +
        'extrapolation this phase exists to retire.',
    };
  }

  const gini = giniOf(perInstall);
  const topCount = Math.max(1, Math.ceil(perInstall.length * 0.1));
  const topShare =
    total > 0 ? perInstall.slice(-topCount).reduce((sum, v) => sum + v, 0) / total : 0;

  return {
    ...summary,
    gini,
    topDecileShare: topShare,
    estimable: true,
    detail:
      gini > 0.5
        ? `Gini ${gini.toFixed(2)}: spend is concentrated enough that the mean is not a description of ` +
          `anybody. The top decile accounts for ${(topShare * 100).toFixed(0)}% of it. Per-seat figures ` +
          'derived by multiplying a mean are overstatements, and the median should be quoted instead.'
        : `Gini ${gini.toFixed(2)} over ${String(perInstall.length)} install(s): spend is spread evenly ` +
          'enough that the mean is a reasonable per-seat figure.',
  };
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  const a = sorted[low] ?? 0;
  const b = sorted[high] ?? a;
  return a + (b - a) * (index - low);
}

function giniOf(sorted: readonly number[]): number {
  const n = sorted.length;
  const total = sorted.reduce((sum, v) => sum + v, 0);
  if (n === 0 || total === 0) return 0;

  let weighted = 0;
  sorted.forEach((value, i) => {
    weighted += (i + 1) * value;
  });
  return (2 * weighted) / (n * total) - (n + 1) / n;
}
