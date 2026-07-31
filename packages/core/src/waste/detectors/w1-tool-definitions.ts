import { creditsForTokens, groupBy, sampleConfidence, withEffectSize } from '../scoring.js';
import { formatCount, formatPercent } from '../format.js';
import type { DetectContext, Evidence, WasteDetector, WasteFinding } from '../types.js';

/**
 * **W1 · The Tool-Definition Tax** — the headline finding (F3).
 *
 * Every installed tool must be described to the model *in full, on every
 * request*, so the model knows it exists. That description is billed whether
 * or not the tool is ever called. The cost therefore scales with **installed
 * surface area**, not with usage — which is why it is both large and almost
 * entirely reducible.
 *
 * ## How the cost is apportioned, and why not by invocation
 *
 * The journal records the *total* tool-definition cost per request, not a
 * per-tool breakdown. Something must apportion it.
 *
 * Apportioning by **invocation share** is the obvious choice and it is
 * exactly wrong: a tool invoked zero times would receive zero attributed
 * cost, when a never-invoked tool is the single most wasteful thing in the
 * category. It is billed on every request and returns nothing.
 *
 * So the cost is apportioned **per distinct tool**, on the reasoning that
 * each tool contributes roughly one description of broadly comparable size.
 * That is an assumption — descriptions genuinely differ in length — and it
 * is stated on the value. But it fails *safely*: it cannot make an unused
 * tool look free.
 *
 * ## The blind spot, stated plainly
 *
 * Only tools **invoked at least once** appear in the journal. A tool
 * installed and never called leaves no trace, so it cannot be counted here
 * at all — and it is the worst offender. The detector reports that
 * limitation rather than implying the tools it can see are the whole set.
 */
export class ToolDefinitionTaxDetector implements WasteDetector {
  readonly class = 'W1' as const;
  readonly name = 'Tool-definition tax';

  detect(ctx: DetectContext): WasteFinding[] {
    const toolDefTokens = ctx.costCentres
      .filter((centre) => centre.label === 'Tool Definitions')
      .reduce((sum, centre) => sum + centre.tokens, 0);
    if (toolDefTokens <= 0) return [];

    // Share is taken against the tokens of requests that actually carry a
    // cost-centre breakdown. Dividing by *all* prompt tokens would silently
    // dilute the figure with requests that were never decomposed, and would
    // disagree with the ledger's own cost-centre view of the same data.
    const decomposedTokens = ctx.costCentres.reduce((sum, centre) => sum + centre.tokens, 0);
    const share = decomposedTokens > 0 ? toolDefTokens / decomposedTokens : 0;

    const byTool = groupBy(ctx.toolCalls, (call) => call.name);
    const distinctTools = byTool.size;
    if (distinctTools === 0) return [];

    const requestCount = Math.max(1, ctx.requests.length);
    const tokensPerTool = toolDefTokens / distinctTools;

    const tools = [...byTool.entries()]
      .map(([name, calls]) => ({
        name,
        calls: calls.length,
        callsPerRequest: calls.length / requestCount,
      }))
      .sort((a, b) => a.calls - b.calls);

    // A tool whose description rides on every request but which is called on
    // almost none of them is not earning its place.
    const underused = tools.filter((tool) => tool.callsPerRequest < RARE_INVOCATION_RATIO);
    const reducibleTokens = underused.length * tokensPerTool;

    const evidence: Evidence[] = [
      {
        kind: 'tool',
        ref: 'ALL',
        detail:
          `${formatCount(toolDefTokens)} tokens across ${formatCount(ctx.requests.length)} request(s) — ` +
          `${formatPercent(share)} of all decomposed prompt tokens went to describing tools`,
      },
      {
        kind: 'tool',
        ref: 'APPORTIONMENT',
        detail:
          `${String(distinctTools)} distinct tool(s) were invoked, so each carries ` +
          `~${formatCount(tokensPerTool)} tokens of description cost`,
      },
      ...underused.slice(0, MAX_LISTED_TOOLS).map((tool): Evidence => ({
        kind: 'tool',
        ref: tool.name,
        detail:
          `invoked ${formatCount(tool.calls)} time(s) — ${tool.callsPerRequest.toFixed(3)} calls per request, ` +
          'while its description was billed on every one',
      })),
    ];

    return [
      {
        class: this.class,
        title: `Tool descriptions are ${formatPercent(share)} of every prompt`,
        credits: creditsForTokens(
          reducibleTokens,
          ctx,
          `tool-definition tokens apportioned to the ${String(underused.length)} least-used tool(s)`,
          [
            'apportions the measured tool-definition cost equally across distinct observed tools, as the journal records no per-tool description size',
            "descriptions genuinely differ in length, so a given tool's true share may be higher or lower",
            `treats a tool as underused below ${String(RARE_INVOCATION_RATIO)} invocations per request`,
            'excludes tools installed but never invoked — they leave no trace in the journal, and they are the most wasteful case',
          ],
        ),
        confidence: withEffectSize(
          sampleConfidence(ctx.requests.length, 30),
          // A larger measured share is a stronger signal; 25% saturates.
          share / 0.25,
        ),
        evidence,
        remediation: {
          summary:
            underused.length > 0
              ? `${String(underused.length)} of ${String(distinctTools)} observed tools are invoked on fewer than 1 request in 20`
              : 'Every observed tool is invoked regularly — the remaining risk is tools never invoked at all',
          tier: 'A',
          action:
            'Remove or disable unused MCP servers and extensions, then re-measure. ' +
            'Tools never invoked at all cannot be seen in this data — supply the installed-tool ' +
            'manifest to price those too.',
        },
      },
    ];
  }
}

/** Below this many invocations per request, a tool's description likely costs more than it returns. */
const RARE_INVOCATION_RATIO = 0.05;
const MAX_LISTED_TOOLS = 12;
