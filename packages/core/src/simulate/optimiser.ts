import { groupBy, quantile } from '../waste/scoring.js';
import { estimateTokensFromChars } from '../ingest/tool-results.js';
import type { DetectContext } from '../waste/types.js';
import type { Policy } from './policy.js';

/**
 * **Tool-surface optimiser** (DEVELOPMENT-PLAN.md D4.5) and the derived
 * portfolio policy behind `tokenlens simulate --all`.
 *
 * ## Why the set-cover framing collapses, and what replaces it
 *
 * The stated task is to solve for the minimum tool set that preserves
 * observed capability. Written out, that problem is degenerate: each
 * recorded invocation is covered by exactly one tool — the one that was
 * called — so the minimum covering set is *every tool that was ever
 * invoked*. There is nothing to optimise, and an optimiser that returned
 * that answer would be dressing up a `SELECT DISTINCT` as an algorithm.
 *
 * The useful question is the neighbouring one: **which tools can be removed
 * while still covering almost all observed invocations?** Invocations are
 * enormously skewed — a handful of tools do nearly all the work — so a
 * coverage target of 99% typically removes a long tail of tools that were
 * used once or twice, each of which was billed on every single request.
 * That is a real trade, stated in the units the decision is actually made
 * in: capability given up against tokens recovered.
 *
 * What it cannot see remains what it cannot see. A tool installed and never
 * invoked leaves no trace in the journal, so it is absent from both the
 * keep list and the remove list — and it is the most wasteful case there
 * is.
 */
export interface ToolSurfaceSolution {
  readonly keep: readonly string[];
  readonly remove: readonly string[];
  readonly observedTools: number;
  readonly coveredInvocations: number;
  readonly totalInvocations: number;
  /** Invocations that would have failed under the trimmed surface. */
  readonly lostInvocations: number;
}

/**
 * Removes the least-used tools while retaining at least `coverage` of all
 * recorded invocations.
 *
 * Greedy from the tail is optimal here rather than merely convenient: every
 * tool costs the same (one description, apportioned equally, as W1 does),
 * so maximising the number removed for a fixed invocation budget means
 * always removing the cheapest-to-lose tool next.
 */
export function solveToolSurface(ctx: DetectContext, coverage = 0.99): ToolSurfaceSolution {
  const byTool = groupBy(ctx.toolCalls, (call) => call.name);
  const total = ctx.toolCalls.length;

  const ranked = [...byTool.entries()]
    .map(([name, calls]) => ({ name, calls: calls.length }))
    // Ties broken by name so the solution is reproducible, not
    // insertion-order dependent.
    .sort((a, b) => a.calls - b.calls || a.name.localeCompare(b.name));

  const budget = Math.floor(total * (1 - coverage));
  const remove: string[] = [];
  let spent = 0;

  for (const tool of ranked) {
    if (spent + tool.calls > budget) break;
    remove.push(tool.name);
    spent += tool.calls;
  }

  const removed = new Set(remove);
  return {
    keep: ranked
      .filter((tool) => !removed.has(tool.name))
      .map((tool) => tool.name)
      .sort(),
    remove: [...remove].sort(),
    observedTools: ranked.length,
    totalInvocations: total,
    coveredInvocations: total - spent,
    lostInvocations: spent,
  };
}

/**
 * Chooses an agent-loop cap that predominantly catches loops which produced
 * **nothing**, or refuses to choose one at all.
 *
 * ## Why the obvious threshold is wrong
 *
 * The first version took the 90th percentile of round counts, which is what
 * W6 uses to define "unusually deep". On this machine's real corpus that cap
 * caught 70 requests — and **68 of them had completed a file edit**. Those
 * loops were converging. A cap there does not save money; it destroys work
 * and then bills you to redo it, and the saving figure would have looked
 * excellent throughout.
 *
 * Depth alone is not the signal. Depth *without output* is, which is exactly
 * the distinction W6 draws when attributing the waste — and the policy
 * derived from it has to draw the same one or the two disagree about the
 * same requests.
 *
 * So candidate caps are scanned and scored by how many *unproductive* deep
 * loops they catch, subject to the majority of what they catch being
 * unproductive. If no cap satisfies that, none is recommended: on this
 * corpus, capping loops is not a lever, and saying so is more useful than
 * a number.
 */
export interface LoopCapSolution {
  readonly cap: number | undefined;
  readonly caught: number;
  readonly unproductiveCaught: number;
  readonly reason: string;
}

export function solveLoopCap(ctx: DetectContext): LoopCapSolution {
  const roundsByRequest = groupBy(ctx.rounds, (round) => round.requestId);
  const editsByRequest = groupBy(ctx.edits, (edit) => edit.requestId);

  const observed = ctx.requests.map((request) => ({
    rounds: roundsByRequest.get(request.requestId)?.length ?? 0,
    productive: (editsByRequest.get(request.requestId) ?? []).some(
      (edit) => edit.done === 1 && edit.editCount > 0,
    ),
  }));

  if (observed.length < MIN_SAMPLE) {
    return {
      cap: undefined,
      caught: 0,
      unproductiveCaught: 0,
      reason: `Only ${String(observed.length)} request(s) recorded — too few to place a loop cap against.`,
    };
  }

  // A cap of `r - 1` is what catches every request that reached depth `r`,
  // so the candidates are the observed depths shifted down by one rather
  // than the depths themselves. Using the depths directly would make a cap
  // between two clusters — exactly where the useful one sits — unreachable.
  const candidates = [...new Set(observed.map((entry) => entry.rounds - 1))]
    .filter((cap) => cap >= MIN_LOOP_CAP)
    .sort((a, b) => a - b);

  let best: LoopCapSolution | undefined;

  for (const cap of candidates) {
    const caught = observed.filter((entry) => entry.rounds > cap);
    if (caught.length === 0) continue;

    const unproductive = caught.filter((entry) => !entry.productive).length;
    if (unproductive / caught.length < MIN_UNPRODUCTIVE_SHARE) continue;

    // Ties keep the earlier, lower cap: it catches the same unproductive
    // loops sooner and therefore saves more.
    if (!best || unproductive > best.unproductiveCaught) {
      best = {
        cap,
        caught: caught.length,
        unproductiveCaught: unproductive,
        reason:
          `capping at ${String(cap)} rounds stops ${String(caught.length)} request(s), ` +
          `${String(unproductive)} of which completed no edit`,
      };
    }
  }

  return (
    best ?? {
      cap: undefined,
      caught: 0,
      unproductiveCaught: 0,
      reason:
        'No round threshold in this corpus catches a majority of loops that produced nothing. ' +
        'Deep loops here are converging, so capping them would destroy work rather than save credits.',
    }
  );
}

/**
 * Derives the portfolio policy `--all` simulates, from the corpus itself.
 *
 * Every threshold here is a percentile of this machine's own distribution
 * rather than a number chosen in advance, with one deliberate exception:
 * the session nudge. Prompt growth is continuous, so there is no point in
 * the data that announces itself as the right moment to start a new chat —
 * that threshold comes from PLAN.md F5's measured penalty onset, and is
 * labelled as the imported constant it is rather than dressed up as
 * derived.
 */
export function recommendPolicy(ctx: DetectContext): Policy {
  const surface = solveToolSurface(ctx);

  const resultSizes = ctx.toolCalls
    .map((call) => call.resultChars)
    .filter((chars): chars is number => chars !== null)
    .sort((a, b) => a - b);
  const payloadCapTokens =
    resultSizes.length >= MIN_SAMPLE
      ? Math.max(
          MIN_PAYLOAD_CAP_TOKENS,
          estimateTokensFromChars(quantile(resultSizes, PAYLOAD_PERCENTILE)),
        )
      : undefined;

  const loopCap = solveLoopCap(ctx).cap;

  const cheapest = [...ctx.ledger.rateCard]
    .filter((rate) => rate.provenance.kind === 'measured' && rate.creditsPerKPromptToken > 0)
    .sort((a, b) => a.creditsPerKPromptToken - b.creditsPerKPromptToken)[0];

  return {
    version: 1,
    ...(cheapest
      ? { model: { route: [{ when: { complexity: 'low' as const }, to: cheapest.model }] } }
      : {}),
    tools: {
      // Always present, even when empty. An omitted lever reads as "not
      // considered"; an empty one reads as "considered, and nothing here
      // qualified" — which is the true statement and the more useful one.
      deny: surface.remove,
      ...optional('virtualToolsThreshold', solveVirtualToolThreshold(ctx)),
    },
    payload: {
      ...optional('maxResultTokens', payloadCapTokens),
      ...optional('compressTerminalOutput', recommendOutputCompression(ctx)),
    },
    session: {
      nudgeAfterTurns: NUDGE_AFTER_TURNS,
      ...optional('maxRounds', loopCap),
    },
    retrieval: { dedupeReads: true },
  };
}

/**
 * The tool count above which VS Code groups tools and expands them on
 * demand (AUTO-5). Lowering it cuts the tool-definition tax directly.
 *
 * The threshold is set at the **95th percentile of distinct tools actually
 * used in a single request**. Above that point, grouping cannot break
 * observed behaviour, because no recorded request needed more tools than
 * that at once. Below it, some request that did work would have paid an
 * expansion round-trip — which is a real cost this does not measure, and is
 * the reason for choosing a percentile rather than the median.
 *
 * Returns nothing when tool definitions are not a material share of the
 * prompt: a setting that attacks waste this corpus does not have is churn.
 */
export function solveVirtualToolThreshold(ctx: DetectContext): number | undefined {
  if (toolDefinitionShare(ctx) < MATERIAL_SHARE) return undefined;

  const perRequest = [...groupBy(ctx.toolCalls, (call) => call.requestId).values()]
    .map((calls) => new Set(calls.map((call) => call.name)).size)
    .sort((a, b) => a - b);
  if (perRequest.length < MIN_SAMPLE) return undefined;

  return Math.max(MIN_VIRTUAL_TOOL_THRESHOLD, Math.round(quantile(perRequest, 0.95)));
}

/**
 * `chat.tools.compressOutput.enabled` ships disabled and costs nothing to
 * turn on (PLAN.md §18.5). It is recommended only when this corpus actually
 * contains the waste it attacks — an oversized tool result — because
 * recommending a setting on the strength of documentation rather than
 * measurement is how a report full of unfalsifiable advice starts.
 *
 * Its saving is deliberately not estimated. The compression ratio is a
 * property of the compressor, which does not run here.
 */
export function recommendOutputCompression(ctx: DetectContext): boolean | undefined {
  const oversized = ctx.toolCalls.some(
    (call) => call.resultChars !== null && call.resultChars > OVERSIZED_RESULT_CHARS,
  );
  return oversized ? true : undefined;
}

function toolDefinitionShare(ctx: DetectContext): number {
  const total = ctx.costCentres.reduce((sum, centre) => sum + centre.tokens, 0);
  if (total <= 0) return 0;
  const toolDefs = ctx.costCentres
    .filter((centre) => centre.label === 'Tool Definitions')
    .reduce((sum, centre) => sum + centre.tokens, 0);
  return toolDefs / total;
}

/**
 * Spreads a key only when its value is defined, so an unrecommended setting
 * stays genuinely absent from the policy rather than present and undefined —
 * which the YAML serialiser would render as an empty line.
 */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Cap the top 5% of results, leaving the other 95% untouched. */
const PAYLOAD_PERCENTILE = 0.95;
const MIN_PAYLOAD_CAP_TOKENS = 1000;
/** A cap must catch mostly loops that produced nothing, or it is destroying work. */
const MIN_UNPRODUCTIVE_SHARE = 0.5;
const MIN_LOOP_CAP = 10;
/** Below this share of decomposed prompt tokens, the tool-definition tax is not worth a setting. */
const MATERIAL_SHARE = 0.05;
const MIN_VIRTUAL_TOOL_THRESHOLD = 8;
/** Matches W3's absolute floor — below this, a result is never worth calling oversized. */
const OVERSIZED_RESULT_CHARS = 16_000;
/** PLAN.md F5 — the measured onset of the accumulated-history penalty. Not derived from this corpus. */
const NUDGE_AFTER_TURNS = 8;
const MIN_SAMPLE = 20;
