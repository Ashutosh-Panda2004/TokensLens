import type { Policy } from '../simulate/policy.js';
import type { OrgBundle } from './bundle.js';

/**
 * **D9.7 · E4 — the closed loop.**
 *
 * ## The risk this exists for (A8)
 *
 * A policy is fitted to an environment: these models, these MCP servers,
 * this tool surface. All three move. A new model appears and the routing
 * rule that named `gpt-4.1` now covers a shrinking share of requests. A
 * team installs an MCP server with sixty tools and the tool-surface tax
 * that D3 measured last quarter is wrong by a wide margin. Nothing breaks;
 * the policy simply stops being the right policy, silently, at a rate of a
 * few percent a month.
 *
 * The failure mode is not that the policy becomes harmful. It is that it
 * becomes *decorative*, while the dashboard keeps reporting it as applied
 * and the savings ledger keeps crediting it with a saving it is no longer
 * producing.
 *
 * ## Why this reports rather than re-fits
 *
 * It would be straightforward to regenerate the policy automatically. It
 * would also mean a machine silently changing a managed setting on every
 * developer's laptop because a new model appeared — which is the thing an
 * IT organisation will least tolerate, and rightly. So drift is *detected*
 * automatically and *applied* by a person, through the same reviewed
 * emission path as the original.
 */
export interface PolicyFitSnapshot {
  readonly fittedAt: string;
  readonly models: readonly string[];
  readonly servers: readonly string[];
  readonly toolCount: number;
  readonly totalCredits: number;
}

export type DriftKind = 'new-model' | 'retired-model' | 'new-server' | 'tool-surface' | 'volume';

export interface DriftFinding {
  readonly kind: DriftKind;
  readonly subject: string;
  readonly magnitude: number;
  readonly detail: string;
  readonly action: string;
}

export interface DriftReport {
  readonly findings: readonly DriftFinding[];
  readonly fittedAt: string;
  readonly daysSinceFit: number;
  readonly refitRecommended: boolean;
  /**
   * Share of credits on models that are both unrouted **and** absent from
   * the fit snapshot — that is, models the policy has never had the chance
   * to consider. See `detectDrift` for why the simpler definition was wrong.
   */
  readonly unseenCreditShare: number;
  readonly detail: string;
}

/** A quarter. The plan's own cadence for regenerating the tool-surface tax. */
export const REFIT_INTERVAL_DAYS = 90;
/** Share of credits on models the policy has never seen, beyond which the routing is stale. */
export const UNSEEN_SHARE_THRESHOLD = 0.2;
/** Relative growth in the tool surface that invalidates the measured tax. */
export const TOOL_SURFACE_DRIFT_THRESHOLD = 0.25;

export function detectDrift(
  snapshot: PolicyFitSnapshot,
  bundles: readonly OrgBundle[],
  policy: Policy,
  now: Date = new Date(),
): DriftReport {
  const findings: DriftFinding[] = [];

  const creditsByModel = new Map<string, number>();
  const servers = new Map<string, number>();
  let toolCount = 0;
  let totalCredits = 0;

  for (const bundle of bundles) {
    totalCredits += bundle.totalCredits;
    for (const model of bundle.byModel) {
      creditsByModel.set(model.model, (creditsByModel.get(model.model) ?? 0) + model.credits);
    }
    for (const surface of bundle.toolSurface) {
      servers.set(surface.server, Math.max(servers.get(surface.server) ?? 0, surface.toolCount));
    }
  }
  for (const count of servers.values()) toolCount += count;

  const known = new Set(snapshot.models);
  const routed = new Set<string>(
    [
      policy.model?.default,
      policy.model?.utility,
      ...(policy.model?.route ?? []).map((r) => r.to),
    ].filter((value): value is string => value !== undefined),
  );

  let unseen = 0;
  for (const [model, credits] of creditsByModel) {
    // Credits on a model the policy chose not to route to are a *decision*,
    // not drift. The first live run counted them, and reported "97% of
    // credits are on models the policy does not mention" for a policy
    // emitted from that very data, zero days old, with zero drift signals —
    // it was measuring what the fleet is rather than what has changed about
    // it. Only a model absent from the fit snapshot is something the policy
    // never had the chance to consider.
    if (known.has(model)) continue;
    if (!routed.has(model)) unseen += credits;

    findings.push({
      kind: 'new-model',
      subject: model,
      magnitude: totalCredits > 0 ? credits / totalCredits : 0,
      detail:
        `${model} did not exist in the fleet when the policy was fitted and now carries ` +
        `${((totalCredits > 0 ? credits / totalCredits : 0) * 100).toFixed(1)}% of credits.`,
      action:
        'Re-run `tokenlens simulate --all` so the rate card and the routing rules both see this model, ' +
        'then re-emit. Until then it is priced by the fallback rate and routed by nothing.',
    });
  }

  for (const model of snapshot.models) {
    if (creditsByModel.has(model)) continue;
    findings.push({
      kind: 'retired-model',
      subject: model,
      magnitude: 0,
      detail: `${model} was in the fleet at fit time and now has no traffic at all.`,
      action:
        'Any routing rule naming it is now dead weight. Remove it, so the policy stays readable and its ' +
        'diff stays reviewable.',
    });
  }

  const knownServers = new Set(snapshot.servers);
  for (const [server, tools] of servers) {
    if (knownServers.has(server)) continue;
    findings.push({
      kind: 'new-server',
      subject: server,
      magnitude: tools,
      detail: `MCP server "${server}" appeared since the fit, adding ${String(tools)} tool definition(s).`,
      action:
        'Tool definitions are re-sent on every request in the session, so this is a standing cost per ' +
        'request whether the tools are called or not. Re-measure W1 and reconsider the allow-list.',
    });
  }

  const surfaceGrowth =
    snapshot.toolCount > 0 ? (toolCount - snapshot.toolCount) / snapshot.toolCount : 0;
  if (Math.abs(surfaceGrowth) >= TOOL_SURFACE_DRIFT_THRESHOLD) {
    findings.push({
      kind: 'tool-surface',
      subject: 'tool surface',
      magnitude: surfaceGrowth,
      detail:
        `The tool surface moved from ${String(snapshot.toolCount)} to ${String(toolCount)} definition(s), ` +
        `a change of ${(surfaceGrowth * 100).toFixed(0)}%.`,
      action:
        'The tool-surface tax measured at fit time no longer describes this fleet. Regenerate it before ' +
        'quoting the saving from the tool-trim lever.',
    });
  }

  const volumeGrowth =
    snapshot.totalCredits > 0 ? (totalCredits - snapshot.totalCredits) / snapshot.totalCredits : 0;
  if (Math.abs(volumeGrowth) >= 0.5) {
    findings.push({
      kind: 'volume',
      subject: 'credit volume',
      magnitude: volumeGrowth,
      detail: `Fleet spend changed by ${(volumeGrowth * 100).toFixed(0)}% since the policy was fitted.`,
      action:
        'The absolute saving quoted for this policy scales with volume. Re-state it before it is used in ' +
        'a budget, in either direction.',
    });
  }

  const daysSinceFit = Math.max(
    0,
    Math.round((now.getTime() - Date.parse(snapshot.fittedAt)) / 86_400_000),
  );
  const uncoveredShare = totalCredits > 0 ? unseen / totalCredits : 0;
  const refit =
    daysSinceFit >= REFIT_INTERVAL_DAYS ||
    uncoveredShare >= UNSEEN_SHARE_THRESHOLD ||
    findings.some((f) => f.kind === 'new-server' || f.kind === 'tool-surface');

  return {
    findings,
    fittedAt: snapshot.fittedAt,
    daysSinceFit,
    refitRecommended: refit,
    unseenCreditShare: uncoveredShare,
    detail: refit
      ? `Refit recommended. ${String(findings.length)} drift signal(s); ` +
        `${(uncoveredShare * 100).toFixed(1)}% of credits are on models the policy has never seen; ` +
        `${String(daysSinceFit)} day(s) since the fit. A policy that no longer covers what the fleet ` +
        'actually uses still reports as applied, and is still credited with a saving it is no longer producing.'
      : `No refit needed. ${String(daysSinceFit)} day(s) since the fit, and every model carrying credits ` +
        'was already present when the policy was fitted.',
  };
}

/**
 * Captures what the policy was fitted against, so drift has something to be
 * measured from. Written at emission time; without it, the first drift
 * check has no baseline and would have to assume today is the baseline —
 * which would report zero drift forever.
 */
export function snapshotFit(
  bundles: readonly OrgBundle[],
  now: Date = new Date(),
): PolicyFitSnapshot {
  const models = new Set<string>();
  const servers = new Map<string, number>();
  let totalCredits = 0;

  for (const bundle of bundles) {
    totalCredits += bundle.totalCredits;
    for (const model of bundle.byModel) models.add(model.model);
    for (const surface of bundle.toolSurface) {
      servers.set(surface.server, Math.max(servers.get(surface.server) ?? 0, surface.toolCount));
    }
  }

  return {
    fittedAt: now.toISOString(),
    models: [...models].sort(),
    servers: [...servers.keys()].sort(),
    toolCount: [...servers.values()].reduce((sum, v) => sum + v, 0),
    totalCredits,
  };
}
