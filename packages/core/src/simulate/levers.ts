import { CHARS_PER_TOKEN_ESTIMATE, estimateTokensFromChars } from '../ingest/tool-results.js';
import { groupBy } from '../waste/scoring.js';
import { bandOf, deriveComplexityBands, scoreComplexity } from '../waste/complexity.js';
import { scanDuplicateReads } from '../waste/duplicate-reads.js';
import { findRate } from '../ledger/rate-card.js';
import { serverOf } from '../waste/report.js';
import { formatCount, formatPercent } from '../waste/format.js';
import { measureRegret } from './regret.js';
import type { DetectContext, Evidence, RemediationTier } from '../waste/types.js';
import type { Policy, RouteRule } from './policy.js';

export type LeverId =
  'model-routing' | 'tool-trim' | 'payload-cap' | 'loop-cap' | 'session-hygiene' | 'dedupe-reads';

/**
 * Something the policy would cost you that the credit figure does not
 * capture. Every lever is obliged to look for these, because a saving with
 * no stated downside is a sales pitch rather than an analysis — and the
 * downsides here are measurable, not hypothetical.
 */
export interface RiskNote {
  readonly severity: 'note' | 'warning';
  readonly text: string;
}

/** A per-request multiplier a lever wants applied. See `replay.ts` for why multipliers. */
export interface RequestChange {
  readonly requestId: string;
  readonly tokenScale?: number;
  readonly rateScale?: number;
}

/**
 * What a lever would do, computed once from the recorded data.
 *
 * Planning is deliberately separate from applying: the plan is derived a
 * single time and then replayed at each realisation rate, which guarantees
 * the low, expected and high bands all describe *the same set of changes*
 * at different adoption levels rather than three independently computed
 * scenarios that might not be comparable.
 */
export interface LeverPlan {
  readonly changes: readonly RequestChange[];
  readonly assumptions: readonly string[];
  readonly risks: readonly RiskNote[];
  readonly evidence: readonly Evidence[];
}

export interface Lever {
  readonly id: LeverId;
  readonly name: string;
  readonly tier: RemediationTier;
  /** The concrete setting or guard this corresponds to, for D5 to emit. */
  readonly action: string;
  /** Returns `undefined` when the policy does not configure this lever at all. */
  plan(policy: Policy, ctx: DetectContext): LeverPlan | undefined;
}

// ---------------------------------------------------------------------------
// L1 · Model routing
// ---------------------------------------------------------------------------

const modelRouting: Lever = {
  id: 'model-routing',
  name: 'Model routing',
  tier: 'A',
  action: 'Pin the default model and route low-complexity work to a cheaper one.',

  plan(policy, ctx) {
    const rules = policy.model?.route ?? [];
    const fallback = policy.model?.default;
    if (rules.length === 0 && fallback === undefined) return undefined;

    const rateCard = ctx.ledger.rateCard;
    const complexity = scoreComplexity(ctx);
    const bands = deriveComplexityBands(complexity.values());
    const roundCounts = countRounds(ctx);

    const routed: { requestId: string; target: string; rateScale: number; band: string }[] = [];
    const unpriceable = new Map<string, number>();

    for (const request of ctx.requests) {
      const score = complexity.get(request.requestId) ?? 0;
      const band = bandOf(score, bands);
      const rounds = roundCounts.get(request.requestId) ?? 0;
      const target = matchTarget(rules, fallback, band, rounds);
      if (target === undefined || target === request.model) continue;

      const from = findRate(rateCard, request.model);
      const to = findRate(rateCard, target);

      // Pricing a counterfactual against an estimated rate would compound
      // two guesses into one confident-looking number. If the target model
      // was never actually billed in this corpus, its cost here is unknown
      // and the request is left alone — visibly, not silently.
      if (!from || from.creditsPerKPromptToken <= 0 || to?.provenance.kind !== 'measured') {
        unpriceable.set(target, (unpriceable.get(target) ?? 0) + 1);
        continue;
      }

      routed.push({
        requestId: request.requestId,
        target,
        band,
        rateScale: to.creditsPerKPromptToken / from.creditsPerKPromptToken,
      });
    }

    const assumptions = [
      'assumes a routed request would have produced an acceptable result on the target model — this is a counterfactual and is not observable in the data',
      'prices the counterfactual only against models whose rate was actually measured in this corpus, never against another estimate',
      'complexity is scored from round count, tool calls, edits and thinking tokens — it measures effort expended, not difficulty intended',
    ];
    const risks: RiskNote[] = [];

    // Regret is measured per target model over the band its rule selects,
    // then charged back as extra effort on exactly the requests routed
    // there. A routing saving reported gross of regret is the single
    // easiest number in this engine to overstate.
    const regretByTarget = new Map<string, number>();
    const targets = [...new Set(routed.map((entry) => entry.target))].sort();

    for (const target of targets) {
      const regret = measureRegret(ctx, target, dominantBand(rules, target), bands, complexity);
      if (regret.extraRoundsRatio === undefined) {
        risks.push({
          severity: 'warning',
          text:
            `Regret for ${target} could not be measured. ${regret.reason} ` +
            'The saving below is therefore an upper bound: if the cheaper model needs more attempts, part of it is not real.',
        });
      } else {
        regretByTarget.set(target, regret.extraRoundsRatio);
        assumptions.push(`measured regret for ${target} — ${regret.reason}`);
      }

      const fromHighBand = routed.filter(
        (entry) => entry.target === target && entry.band === 'high',
      ).length;
      if (fromHighBand > 0) {
        risks.push({
          severity: 'warning',
          text:
            `${formatCount(fromHighBand)} request(s) routed to ${target} scored in the *highest* complexity band. ` +
            'Routing hard work to a cheap model is where a routing policy does damage rather than saving money — narrow the rule.',
        });
      }
    }

    const changes: RequestChange[] = routed.map((entry) => {
      const regret = regretByTarget.get(entry.target) ?? 0;
      return {
        requestId: entry.requestId,
        rateScale: entry.rateScale,
        ...(regret > 0 ? { tokenScale: 1 + regret } : {}),
      };
    });

    for (const [target, count] of [...unpriceable.entries()].sort()) {
      risks.push({
        severity: 'note',
        text:
          `${formatCount(count)} request(s) would have routed to ${target}, which has no measured rate in this corpus. ` +
          'They were left at their observed cost rather than priced against an estimate, so this understates the rule.',
      });
    }

    const evidence: Evidence[] = targets.map((target): Evidence => {
      const count = routed.filter((entry) => entry.target === target).length;
      const regret = regretByTarget.get(target);
      return {
        kind: 'model',
        ref: target,
        detail:
          `${formatCount(count)} request(s) re-priced at ${target}'s measured rate` +
          (regret !== undefined && regret > 0
            ? `, less ${formatPercent(regret)} measured regret`
            : ''),
      };
    });

    return { changes, assumptions, risks, evidence };
  },
};

/** First matching rule wins, then `model.default`, then no change. */
function matchTarget(
  rules: readonly RouteRule[],
  fallback: string | undefined,
  band: string,
  rounds: number,
): string | undefined {
  for (const rule of rules) {
    if (rule.when.complexity !== undefined && rule.when.complexity !== band) continue;
    if (rule.when.maxRounds !== undefined && rounds > rule.when.maxRounds) continue;
    return rule.to;
  }
  return fallback;
}

/** The complexity band a target model's rules select, for the regret comparison. */
function dominantBand(rules: readonly RouteRule[], target: string): 'low' | 'medium' | 'high' {
  return rules.find((rule) => rule.to === target)?.when.complexity ?? 'low';
}

// ---------------------------------------------------------------------------
// L2 · Tool-surface trim
// ---------------------------------------------------------------------------

const toolTrim: Lever = {
  id: 'tool-trim',
  name: 'Tool-surface trim',
  tier: 'A',
  action: 'Uninstall the MCP servers and tools the policy does not allow.',

  plan(policy, ctx) {
    const allowMcp = policy.tools?.allowMcp;
    const deny = policy.tools?.deny;
    if (allowMcp === undefined && deny === undefined) return undefined;

    const callsByTool = groupBy(ctx.toolCalls, (call) => call.name);
    const observed = [...callsByTool.keys()].sort();
    if (observed.length === 0) {
      return {
        changes: [],
        assumptions: [],
        risks: [
          {
            severity: 'note',
            text: 'No tool call was recorded in this corpus, so there is no tool surface to trim.',
          },
        ],
        evidence: [],
      };
    }

    const allowed = new Set(allowMcp ?? []);
    const removed = observed.filter((name) => {
      const server = serverNameOf(name);
      if (allowMcp !== undefined && server !== undefined && !allowed.has(server)) return true;
      return (deny ?? []).some((pattern) => matchesPattern(name, pattern));
    });

    const toolDefTokens = costCentreTokensByRequest(ctx, 'Tool Definitions');
    const changes: RequestChange[] = [];

    // Apportioned per distinct tool, matching W1. Apportioning by
    // invocation share instead would give a never-invoked tool zero cost,
    // which inverts the finding this lever exists to act on.
    const removedShare = removed.length / observed.length;
    for (const request of ctx.requests) {
      if (request.promptTokens <= 0) continue;
      const freed = (toolDefTokens.get(request.requestId) ?? 0) * removedShare;
      if (freed <= 0) continue;
      changes.push({
        requestId: request.requestId,
        tokenScale: Math.max(0, (request.promptTokens - freed) / request.promptTokens),
      });
    }

    const lostInvocations = removed.reduce(
      (sum, name) => sum + (callsByTool.get(name)?.length ?? 0),
      0,
    );
    const risks: RiskNote[] = [];

    if (removed.length === 0) {
      risks.push({
        severity: 'note',
        text: 'The policy removes none of the tools observed in this corpus, so it frees nothing here. Tools installed but never invoked leave no trace in the journal and cannot be counted either way.',
      });
    }

    if (lostInvocations > 0) {
      risks.push({
        severity: 'warning',
        text:
          `${formatCount(lostInvocations)} recorded invocation(s) used a tool this policy removes ` +
          `(${formatPercent(lostInvocations / Math.max(1, ctx.toolCalls.length))} of all tool calls). ` +
          'That is capability the policy takes away, and the credit saving does not price it.',
      });
    }

    return {
      changes,
      assumptions: [
        'apportions the measured tool-definition cost equally across distinct observed tools, as the journal records no per-tool description size',
        'counts only tools invoked at least once — a server installed and never called leaves no trace, so this understates what removing it would save',
      ],
      risks,
      evidence: [
        {
          kind: 'tool',
          ref: 'ALL',
          detail:
            `${String(removed.length)} of ${String(observed.length)} observed tool(s) removed, freeing ` +
            `${formatPercent(removedShare)} of every request's tool-definition tokens`,
        },
        ...removed.slice(0, MAX_LISTED).map((name): Evidence => ({
          kind: 'tool',
          ref: name,
          detail: `removed — invoked ${formatCount(callsByTool.get(name)?.length ?? 0)} time(s) in the measured window`,
        })),
      ],
    };
  },
};

/** The server a tool belongs to, or `undefined` for the editor's built-ins, which a policy never removes. */
function serverNameOf(toolName: string): string | undefined {
  const server = serverOf(toolName);
  if (server === 'built-in') return undefined;
  return server.startsWith('mcp:') ? server.slice(4) : server;
}

function matchesPattern(name: string, pattern: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

// ---------------------------------------------------------------------------
// L3 · Payload cap
// ---------------------------------------------------------------------------

const payloadCap: Lever = {
  id: 'payload-cap',
  name: 'Tool-result payload cap',
  tier: 'B',
  action: 'Truncate and paginate tool results above the cap.',

  plan(policy, ctx) {
    const maxTokens = policy.payload?.maxResultTokens;
    if (maxTokens === undefined) return undefined;

    const capChars = maxTokens * CHARS_PER_TOKEN_ESTIMATE;
    const excessByRequest = new Map<string, number>();
    let cappedCalls = 0;

    for (const call of ctx.toolCalls) {
      if (call.resultChars === null || call.resultChars <= capChars) continue;
      cappedCalls += 1;
      excessByRequest.set(
        call.requestId,
        (excessByRequest.get(call.requestId) ?? 0) + (call.resultChars - capChars),
      );
    }

    const { changes, unclampable } = applyTokenReduction(ctx, excessByRequest);

    const risks: RiskNote[] = [];
    if (cappedCalls === 0) {
      risks.push({
        severity: 'note',
        text: `No recorded tool result exceeded ${formatCount(maxTokens)} tokens, so this cap changes nothing in the measured window.`,
      });
    } else {
      risks.push({
        severity: 'note',
        text:
          `${formatCount(cappedCalls)} tool result(s) would have been truncated. Truncation loses information: ` +
          'if the agent then re-runs the tool to get the rest, part of this saving is spent again.',
      });
    }
    if (unclampable > 0) {
      risks.push({
        severity: 'note',
        text:
          `${formatCount(unclampable)} request(s) with oversized results carry no cost-centre breakdown, so there was no ` +
          'measured tool-result figure to cap against. They were skipped rather than estimated, which understates the saving.',
      });
    }

    return {
      changes,
      assumptions: [
        'token counts are estimated from measured character lengths at ~4 characters per token',
        "the removable amount is capped at each request's own measured `Tool Results` cost centre — a policy cannot remove more tool-result tokens than the request actually contained",
        'charges the payload once. In an agent loop an oversized result is re-transmitted on every later step, so the real saving is larger than this',
      ],
      risks,
      evidence: [
        {
          kind: 'tool',
          ref: 'ALL',
          detail:
            `${formatCount(cappedCalls)} tool result(s) above ${formatCount(maxTokens)} tokens, ` +
            `${formatCount(estimateTokensFromChars([...excessByRequest.values()].reduce((a, b) => a + b, 0)))} estimated tokens above the cap in total`,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// L4 · Loop cap
// ---------------------------------------------------------------------------

const loopCap: Lever = {
  id: 'loop-cap',
  name: 'Agent loop cap',
  tier: 'B',
  action: 'Stop an agent loop at the round cap and surface a checkpoint.',

  plan(policy, ctx) {
    const cap = policy.session?.maxRounds;
    if (cap === undefined) return undefined;

    const roundCounts = countRounds(ctx);
    const editsByRequest = groupBy(ctx.edits, (edit) => edit.requestId);

    const changes: RequestChange[] = [];
    let capped = 0;
    let cappedWithEdit = 0;
    let deepest = 0;

    for (const request of ctx.requests) {
      const rounds = roundCounts.get(request.requestId) ?? 0;
      if (rounds <= cap) continue;

      capped += 1;
      deepest = Math.max(deepest, rounds);
      const produced = (editsByRequest.get(request.requestId) ?? []).some(
        (edit) => edit.done === 1 && edit.editCount > 0,
      );
      if (produced) cappedWithEdit += 1;

      changes.push({ requestId: request.requestId, tokenScale: cap / rounds });
    }

    const risks: RiskNote[] = [];
    if (capped === 0) {
      risks.push({
        severity: 'note',
        text: `No request ran past ${String(cap)} rounds, so this cap changes nothing in the measured window.`,
      });
    }
    if (cappedWithEdit > 0) {
      risks.push({
        severity: 'warning',
        text:
          `${formatCount(cappedWithEdit)} of ${formatCount(capped)} capped request(s) had completed a file edit. ` +
          'Those loops were converging, and the cap would have cut them off — this is work destroyed, not money saved.',
      });
    }

    return {
      changes,
      assumptions: [
        "assumes a request's prompt cost scales linearly with its round count. It grows faster than that in practice, because every round re-transmits the accumulated context — so this **understates** the saving",
        'a deep loop is not automatically waste: investigation, review and answering a question are legitimate outcomes that produce no edit',
      ],
      risks,
      evidence: [
        {
          kind: 'tool',
          ref: 'ALL',
          detail:
            capped > 0
              ? `${formatCount(capped)} request(s) exceeded ${String(cap)} rounds — deepest was ${String(deepest)}`
              : `no request exceeded ${String(cap)} rounds`,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// L5 · Session hygiene
// ---------------------------------------------------------------------------

const sessionHygiene: Lever = {
  id: 'session-hygiene',
  name: 'Session hygiene',
  tier: 'C',
  action: 'Prompt for a fresh chat after the turn threshold.',

  plan(policy, ctx) {
    const nudgeAfter = policy.session?.nudgeAfterTurns;
    if (nudgeAfter === undefined) return undefined;

    const bySession = groupBy(ctx.requests, (request) => request.sessionId);
    const changes: RequestChange[] = [];
    let staleTurns = 0;
    let sessionsAffected = 0;
    let longest = 0;

    for (const requests of bySession.values()) {
      longest = Math.max(longest, requests.length);
      if (requests.length <= nudgeAfter) continue;

      const ordered = [...requests].sort((a, b) => a.turnIndex - b.turnIndex);
      const baselineTurns = ordered.slice(0, BASELINE_TURNS);
      const baseline =
        baselineTurns.reduce((sum, r) => sum + r.promptTokens, 0) / baselineTurns.length;
      if (baseline <= 0) continue;

      let touched = false;
      for (const request of ordered.slice(nudgeAfter)) {
        if (request.promptTokens <= baseline) continue;
        staleTurns += 1;
        touched = true;
        changes.push({ requestId: request.requestId, tokenScale: baseline / request.promptTokens });
      }
      if (touched) sessionsAffected += 1;
    }

    return {
      changes,
      assumptions: [
        'assumes a restarted session returns to its own early-turn prompt size — the baseline is per session, so a chat that legitimately starts large is not penalised for staying large',
        'charges nothing for re-establishing context after a restart. That cost is real and is not modelled here, so this **overstates** the saving',
      ],
      risks: [
        {
          severity: 'warning',
          text:
            'This is the only lever here that depends entirely on a person changing a habit; nothing enforces it. ' +
            'Its realisation band is correspondingly wide, and the low end is the number to plan against.',
        },
        ...(sessionsAffected === 0
          ? [
              {
                severity: 'note' as const,
                text: `No session ran past ${String(nudgeAfter)} turns (the longest was ${String(longest)}), so this nudge changes nothing in the measured window.`,
              },
            ]
          : []),
      ],
      evidence: [
        {
          kind: 'tool',
          ref: 'ALL',
          detail:
            `${formatCount(sessionsAffected)} session(s) ran past ${String(nudgeAfter)} turns, ` +
            `covering ${formatCount(staleTurns)} turn(s) above their own early-turn baseline`,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// L6 · Duplicate-read elimination
// ---------------------------------------------------------------------------

const dedupeReads: Lever = {
  id: 'dedupe-reads',
  name: 'Duplicate-read elimination',
  tier: 'B',
  action:
    'Refuse a read whose range was already returned in the same session, invalidating on edit.',

  plan(policy, ctx) {
    if (policy.retrieval?.dedupeReads !== true) return undefined;

    const scan = scanDuplicateReads(ctx);
    const redundantChars = new Map<string, number>();
    for (const entry of scan.duplicates) {
      redundantChars.set(entry.requestId, (redundantChars.get(entry.requestId) ?? 0) + entry.chars);
    }

    const { changes, unclampable } = applyTokenReduction(ctx, redundantChars);

    const risks: RiskNote[] = [];
    if (scan.duplicates.length === 0) {
      risks.push({
        severity: 'note',
        text: 'No read in this corpus re-fetched a range already retrieved in the same session with no intervening edit.',
      });
    }
    if (scan.refreshedAfterEdit > 0) {
      risks.push({
        severity: 'note',
        text:
          `${formatCount(scan.refreshedAfterEdit)} re-read(s) followed an edit to the same file and were ` +
          'excluded from this saving — the content had genuinely changed. A guard that did not invalidate ' +
          'on edit would block those too, and would be denying the agent sight of its own work.',
      });
    }
    if (unclampable > 0) {
      risks.push({
        severity: 'note',
        text: `${formatCount(unclampable)} request(s) with duplicate reads carry no cost-centre breakdown and were skipped rather than estimated.`,
      });
    }

    return {
      changes,
      assumptions: [
        'assumes the re-fetched content added no information, which the edit exemption is what makes true',
        'counts only the redundant copy, never the first read',
        "removal is capped at each request's own measured `Tool Results` cost centre",
      ],
      risks,
      evidence: [
        {
          kind: 'file',
          ref: 'ALL',
          detail:
            `${formatCount(scan.duplicates.length)} of ${formatCount(scan.readCalls)} read(s) re-fetched a range ` +
            `already in context; a further ${formatCount(scan.refreshedAfterEdit)} were legitimate refreshes after an edit`,
        },
      ],
    };
  },
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Converts per-request removable **characters** into token-scale changes,
 * clamped to what the request measurably contained.
 *
 * The clamp is the important part. Excess characters are counted from tool
 * results, but the thing being scaled is the *prompt*, and the two are
 * related only through the `Tool Results` cost centre — which VS Code
 * measures and records. Without the clamp, a request whose oversized result
 * was mostly truncated before it reached the prompt would have more tokens
 * removed than it ever had, and the saving would exceed what was spent.
 *
 * A request with no cost-centre breakdown has no measured ceiling, so it is
 * skipped and counted rather than estimated. That understates the saving,
 * which is the direction to be wrong in.
 */
function applyTokenReduction(
  ctx: DetectContext,
  removableCharsByRequest: ReadonlyMap<string, number>,
): { changes: RequestChange[]; unclampable: number } {
  const toolResultTokens = costCentreTokensByRequest(ctx, 'Tool Results');
  const changes: RequestChange[] = [];
  let unclampable = 0;

  for (const request of ctx.requests) {
    const chars = removableCharsByRequest.get(request.requestId);
    if (chars === undefined || chars <= 0 || request.promptTokens <= 0) continue;

    const ceiling = toolResultTokens.get(request.requestId);
    if (ceiling === undefined) {
      unclampable += 1;
      continue;
    }

    const removable = Math.min(estimateTokensFromChars(chars), ceiling);
    if (removable <= 0) continue;

    changes.push({
      requestId: request.requestId,
      tokenScale: Math.max(0, (request.promptTokens - removable) / request.promptTokens),
    });
  }

  return { changes, unclampable };
}

function costCentreTokensByRequest(ctx: DetectContext, label: string): Map<string, number> {
  const byRequest = new Map<string, number>();
  for (const centre of ctx.costCentres) {
    if (centre.label !== label) continue;
    byRequest.set(centre.requestId, (byRequest.get(centre.requestId) ?? 0) + centre.tokens);
  }
  return byRequest;
}

function countRounds(ctx: DetectContext): Map<string, number> {
  const counts = new Map<string, number>();
  for (const round of ctx.rounds) {
    counts.set(round.requestId, (counts.get(round.requestId) ?? 0) + 1);
  }
  return counts;
}

const BASELINE_TURNS = 3;
const MAX_LISTED = 12;

/**
 * Every lever, in a fixed order. Ordering is part of the contract: levers
 * compose by multiplying into shared state, and although multiplication
 * commutes, the *floors* inside them (`Math.max(0, …)`) do not. A stable
 * order is what makes the replay reproducible byte for byte.
 */
export const LEVERS: readonly Lever[] = [
  modelRouting,
  toolTrim,
  payloadCap,
  loopCap,
  sessionHygiene,
  dedupeReads,
];
