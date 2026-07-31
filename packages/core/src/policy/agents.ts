import { stringify as stringifyYaml } from 'yaml';
import { groupBy } from '../waste/scoring.js';
import { formatPercent } from '../waste/format.js';
import type { DetectContext } from '../waste/types.js';
import type { Policy } from '../simulate/policy.js';
import type { Artefact } from './artefacts.js';

/**
 * A generated custom agent — a per-task cost contract (PLAN.md §18.3).
 *
 * `.agent.md` frontmatter is the only surface on which *routing* is
 * expressible: `chat.defaultModel` sets one default for the whole fleet,
 * whereas an agent pins a model for one kind of work. It is also where the
 * tool-definition bill is set, because `tools:` is exhaustive — eight tools
 * instead of eighty removes their schemas from every request the agent
 * handles.
 */
export interface AgentProfile {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
  readonly model?: string;
  /** How this profile was derived, printed in the file itself. */
  readonly basis: string;
  readonly requestsCovered: number;
}

export interface DeriveAgentsResult {
  readonly agents: readonly AgentProfile[];
  /** Share of tool-using requests the task agents cover. */
  readonly coverage: number;
  /** Stated limitations, reported rather than left for the reader to discover. */
  readonly caveats: readonly string[];
}

/** A tool must appear in at least this share of a cluster's requests to earn its schema. */
const CO_OCCURRENCE_THRESHOLD = 0.2;
/** Below this many requests, a cluster is a coincidence rather than a workflow. */
const MIN_CLUSTER_REQUESTS = 10;
const MAX_AGENTS = 5;

/** Tools whose results are file content — the retrieval surface (AUTO-7). */
const READ_TOOLS = ['read_file', 'grep_search', 'file_search', 'semantic_search', 'get_errors'];

/**
 * Derives agent profiles from **observed** tool-invocation clusters.
 *
 * ## How the clusters are found, and why not by exact tool-set
 *
 * The obvious approach groups requests by their exact set of tools. On real
 * data that fragments immediately — nearly every request has a slightly
 * different set, so the most common one covers a percent or two and the
 * result is noise.
 *
 * Requests do have a shape, though: one tool usually dominates and the
 * others attend it. So requests are grouped by their **dominant tool**, and
 * a cluster's tool list is the tools that co-occur with it often enough to
 * be part of that workflow rather than a visitor. Both thresholds are
 * stated on the generated file, because a reader has to be able to disagree
 * with them.
 *
 * These profiles describe what *did* happen. They are a starting point for
 * a human to narrow, not a prescription — and the emitted file says so in
 * its own body rather than only here.
 */
export function deriveAgents(ctx: DetectContext, policy: Policy): DeriveAgentsResult {
  const callsByRequest = groupBy(ctx.toolCalls, (call) => call.requestId);
  const caveats: string[] = [];

  const dominant = new Map<string, string[]>();
  for (const [requestId, calls] of callsByRequest) {
    const counts = new Map<string, number>();
    for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);

    // Ties broken by name so the clustering is reproducible.
    const leader = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (!leader) continue;

    const bucket = dominant.get(leader[0]) ?? [];
    bucket.push(requestId);
    dominant.set(leader[0], bucket);
  }

  const toolUsingRequests = callsByRequest.size;
  const clusters = [...dominant.entries()]
    .filter(([, requests]) => requests.length >= MIN_CLUSTER_REQUESTS)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, MAX_AGENTS);

  const pinnedModel = policy.model?.route?.[0]?.to ?? policy.model?.default;

  const agents: AgentProfile[] = clusters.map(([leadTool, requestIds]) => {
    const inCluster = new Set(requestIds);
    const appearances = new Map<string, number>();
    for (const requestId of requestIds) {
      for (const name of new Set((callsByRequest.get(requestId) ?? []).map((c) => c.name))) {
        appearances.set(name, (appearances.get(name) ?? 0) + 1);
      }
    }

    const tools = [...appearances.entries()]
      .filter(([, count]) => count / inCluster.size >= CO_OCCURRENCE_THRESHOLD)
      .map(([name]) => name)
      .sort();

    return {
      name: `${kebab(leadTool)}-tasks`,
      description: `Work led by ${leadTool}, using the ${String(tools.length)} tool(s) that actually attend it.`,
      tools,
      ...(pinnedModel !== undefined ? { model: pinnedModel } : {}),
      basis:
        `${String(requestIds.length)} request(s) in this corpus were led by ${leadTool}. ` +
        `Tools listed are those appearing in at least ${formatPercent(CO_OCCURRENCE_THRESHOLD, 0)} of them; ` +
        `${String(appearances.size - tools.length)} rarer tool(s) were dropped.`,
      requestsCovered: requestIds.length,
    };
  });

  const observedReadTools = READ_TOOLS.filter(
    (name) => callsByRequest.size > 0 && hasTool(ctx, name),
  );
  const cheapest = cheapestMeasuredModel(ctx);

  if (observedReadTools.length > 0 && cheapest !== undefined) {
    // AUTO-7. The point is not the rate difference alone: a payload fetched
    // inside a subagent never enters the parent conversation, so it is
    // billed once instead of on every subsequent round (PLAN.md §18.4).
    agents.push({
      name: 'retrieval',
      description: 'Fetches and summarises. Raw payloads never enter the calling conversation.',
      tools: observedReadTools,
      model: cheapest,
      basis:
        `Retrieval isolation (AUTO-7). Invoked as a subagent this runs on ${cheapest} \u2014 the cheapest model ` +
        'with a measured rate in this corpus \u2014 and returns only its summary, so the raw result is billed once ' +
        'rather than re-transmitted on every later round of the parent turn.',
      requestsCovered: 0,
    });
  } else if (cheapest === undefined) {
    caveats.push(
      'No retrieval-isolation agent was generated: no model in this corpus has a measured rate, so there is ' +
        'nothing to pin it to that would not be a guess.',
    );
  }

  if (clusters.length === 0) {
    caveats.push(
      `No tool-invocation cluster reached ${String(MIN_CLUSTER_REQUESTS)} requests, so no task agent was generated. ` +
        'Below that a cluster is a coincidence rather than a workflow.',
    );
  }

  caveats.push(
    'No `handoffs:` are generated. A handoff is a workflow decision — which task follows which — and the ' +
      'journal records tool calls, not intent transitions. Inferring one would be invention.',
  );

  const covered = clusters.reduce((sum, [, requests]) => sum + requests.length, 0);

  return {
    agents,
    coverage: toolUsingRequests > 0 ? covered / toolUsingRequests : 0,
    caveats,
  };
}

function hasTool(ctx: DetectContext, name: string): boolean {
  return ctx.toolCalls.some((call) => call.name === name);
}

function cheapestMeasuredModel(ctx: DetectContext): string | undefined {
  return [...ctx.ledger.rateCard]
    .filter((rate) => rate.provenance.kind === 'measured' && rate.creditsPerKPromptToken > 0)
    .sort((a, b) => a.creditsPerKPromptToken - b.creditsPerKPromptToken)[0]?.model;
}

function kebab(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'agent'
  );
}

/**
 * Renders one profile as a `.agent.md` file. The body is not decoration:
 * whoever reviews this pull request needs to know it was generated from
 * measurement, what the thresholds were, and that narrowing it further is
 * the intended next step.
 */
export function renderAgentFile(profile: AgentProfile): string {
  const frontmatter = stringifyYaml(
    {
      description: profile.description,
      tools: [...profile.tools],
      ...(profile.model !== undefined ? { model: profile.model } : {}),
    },
    { lineWidth: 0 },
  );

  return `---
${frontmatter}---

# ${profile.name}

${profile.basis}

**This describes what happened, not what should happen.** It was derived from observed tool
invocations, so it is a floor for the tool surface rather than a considered minimum. Removing a
tool you know this task does not need is the intended next step, and re-running
\`tokenlens waste --explain W1\` afterwards will show what it saved.
`;
}

export function emitAgents(result: DeriveAgentsResult): Artefact[] {
  return result.agents.map((profile) => ({
    path: `agents/${profile.name}.agent.md`,
    contents: renderAgentFile(profile),
    description:
      `Custom agent — ${String(profile.tools.length)} tool(s)` +
      (profile.model === undefined ? '' : `, pinned to ${profile.model}`),
    role: 'apply' as const,
  }));
}
