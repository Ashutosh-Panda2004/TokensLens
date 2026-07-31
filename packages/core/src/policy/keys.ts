import type { LeverId } from '../simulate/levers.js';
import type { Policy } from '../simulate/policy.js';

/**
 * Where a policy line is actually enforced.
 *
 * These are not interchangeable, and the difference is the whole of D5:
 *
 * - **`managed`** — Copilot Managed Settings, delivered fleet-wide by
 *   MDM/server/file. Nobody installs anything and no developer acts. This
 *   is where the Tier A money is.
 * - **`workspace`** — `.vscode/settings.json`, committed to a repo. Applies
 *   to anyone who opens it, and is a pull request rather than a policy push.
 * - **`agent`** — `.agent.md` frontmatter. A per-task cost contract; the
 *   only surface on which *routing* (as opposed to a single fleet default)
 *   can actually be expressed.
 */
export type SettingSurface = 'managed' | 'workspace' | 'agent';

/**
 * A policy line that is real but is **not a Tier A setting** — it needs a
 * runtime guard or a human, both of which arrive in later phases.
 *
 * Recorded rather than dropped for the same reason the waste report keeps
 * its undetectable classes: silently omitting a line the user wrote makes
 * it look like it did nothing, when in fact it was never attempted here.
 */
export interface DeferredKey {
  readonly at: string;
  readonly reason: string;
  /** The phase and mechanism that does enforce it. */
  readonly enforcedBy: string;
}

export interface PolicyKey {
  /** Stable identifier, used for diffing and rollback. */
  readonly id: string;
  readonly surface: SettingSurface;
  /** Managed Settings policy name — the registry value / plist key / JSON key. */
  readonly managedName?: string;
  /** VS Code setting id. */
  readonly settingId?: string;
  /** Which D4 lever's saving this line delivers. Absent means D4 could not price it. */
  readonly lever?: LeverId;
  /** Waste class(es) this attacks, for the report. */
  readonly attacks: string;
  /** PLAN.md §19 automation id. */
  readonly auto: string;
}

export interface ResolvedSetting {
  readonly key: PolicyKey;
  readonly value: string | number | boolean | Record<string, boolean>;
  /** The policy line this came from, e.g. `model.default`. */
  readonly from: string;
}

/**
 * The mapping from TokenLens's policy DSL to the knobs GitHub and VS Code
 * actually expose (PLAN.md §18.1, §18.5, §19).
 *
 * ## Why this table is the load-bearing part of the phase
 *
 * A simulation says "routing low-complexity work to a cheaper model would
 * have saved 13%". A *policy* has to answer a different question: which
 * exact string, in which exact file, on which exact channel. Most of the
 * honesty in D5 lives in admitting where that mapping is imperfect —
 * `chat.defaultModel` sets a **default**, not a restriction, and a developer
 * can still switch model mid-conversation. The residual is measurable
 * (AUTO-25) and is stated on the emitted artefact rather than assumed away.
 */
export const POLICY_KEYS = {
  defaultModel: {
    id: 'default-model',
    surface: 'managed',
    managedName: 'ChatDefaultModel',
    settingId: 'chat.defaultModel',
    lever: 'model-routing',
    attacks: 'W5',
    auto: 'AUTO-1',
  },
  mcpAccess: {
    id: 'mcp-access',
    surface: 'managed',
    managedName: 'ChatMCP',
    settingId: 'chat.mcp.access',
    lever: 'tool-trim',
    attacks: 'W1',
    auto: 'AUTO-4',
  },
  extensionTools: {
    id: 'extension-tools',
    surface: 'managed',
    managedName: 'ChatAgentExtensionTools',
    settingId: 'chat.extensionTools.enabled',
    attacks: 'W1',
    auto: 'AUTO-11',
  },
  utilityModel: {
    id: 'utility-model',
    surface: 'workspace',
    settingId: 'chat.utilityModel',
    attacks: 'W12',
    auto: 'AUTO-3',
  },
  virtualToolsThreshold: {
    id: 'virtual-tools-threshold',
    surface: 'workspace',
    settingId: 'github.copilot.chat.virtualTools.threshold',
    attacks: 'W1',
    auto: 'AUTO-5',
  },
  compressOutput: {
    id: 'compress-output',
    surface: 'workspace',
    settingId: 'chat.tools.compressOutput.enabled',
    attacks: 'W3',
    auto: 'AUTO-8',
  },
  maxRequests: {
    id: 'max-requests',
    surface: 'workspace',
    settingId: 'chat.agent.maxRequests',
    lever: 'loop-cap',
    attacks: 'W6',
    auto: 'AUTO-10',
  },
  searchExclude: {
    id: 'search-exclude',
    surface: 'workspace',
    settingId: 'search.exclude',
    attacks: 'W11',
    auto: 'AUTO-9',
  },
} as const satisfies Record<string, PolicyKey>;

/**
 * Policy lines that are deliberately **not** emitted as settings, with the
 * mechanism that does enforce them.
 *
 * `payload.max_result_tokens` is the clearest case: there is no VS Code
 * setting that caps a tool result at N tokens. `chat.tools.compressOutput`
 * is adjacent but is a different mechanism with a different (unmeasured)
 * effect, and emitting it *as if* it were the cap would silently substitute
 * one lever for another and attribute the wrong saving to it.
 */
const DEFERRED: Readonly<Record<string, Omit<DeferredKey, 'at'>>> = {
  'payload.max_result_tokens': {
    reason:
      'No managed setting or workspace setting caps a tool result at a token count. ' +
      '`chat.tools.compressOutput.enabled` is adjacent but is a different mechanism with a different effect, ' +
      'and emitting it as though it were the cap would attribute this lever\u2019s saving to the wrong control.',
    enforcedBy:
      'Phase D6 \u00b7 the `PreToolUse` payload guard (AUTO-15), which denies or narrows the call.',
  },
  'session.nudge_after_turns': {
    reason:
      'Session hygiene is a habit, not a setting. Nothing in Managed Settings can end a conversation, ' +
      'and this lever\u2019s realisation band already says so.',
    enforcedBy: 'Phase D6 \u00b7 the `UserPromptSubmit` session-age nudge (AUTO-20).',
  },
  'retrieval.dedupe_reads': {
    reason:
      'Refusing a read whose range is already in context requires inspecting the call at the moment it is made. ' +
      'No static setting can express it.',
    enforcedBy: 'Phase D6 \u00b7 the `PreToolUse` re-read suppressor (AUTO-14).',
  },
  'tools.deny': {
    reason:
      'Managed Settings governs MCP access at the level of a *registry* (`ChatMCP`), not individual tool names. ' +
      'A per-tool list is expressible only in an agent file, which this command emits alongside.',
    enforcedBy:
      'The generated `.agent.md` files (AUTO-6), plus `McpGalleryServiceUrl` if the org runs a curated registry.',
  },
  'model.route': {
    reason:
      'There is no fleet setting for "route low-complexity work to a cheaper model". ' +
      '`chat.defaultModel` sets one default for everything.',
    enforcedBy:
      'The generated `.agent.md` files (AUTO-6), whose `model:` pins a model per task \u2014 the only surface on which routing is expressible.',
  },
};

export interface ResolvedPolicySettings {
  readonly settings: readonly ResolvedSetting[];
  readonly deferred: readonly DeferredKey[];
}

/**
 * Turns a policy into the concrete settings that carry it, plus the lines
 * that no setting can carry.
 *
 * Pure and total: every line of the input DSL ends up in exactly one of the
 * two lists, so nothing a user wrote can silently vanish between the
 * simulation and the artefact.
 */
export function resolveSettings(policy: Policy): ResolvedPolicySettings {
  const settings: ResolvedSetting[] = [];
  const deferred: DeferredKey[] = [];

  const defer = (at: string): void => {
    const entry = DEFERRED[at];
    if (entry) deferred.push({ at, ...entry });
  };

  if (policy.model?.default !== undefined) {
    settings.push({
      key: POLICY_KEYS.defaultModel,
      value: policy.model.default,
      from: 'model.default',
    });
  }
  if (policy.model?.utility !== undefined) {
    settings.push({
      key: POLICY_KEYS.utilityModel,
      value: policy.model.utility,
      from: 'model.utility',
    });
  }
  if (policy.model?.route !== undefined && policy.model.route.length > 0) defer('model.route');

  if (policy.tools?.allowMcp !== undefined) {
    // `registry` is the only value that means "an approved list applies".
    // The list itself lives in the org's MCP registry, not in this setting,
    // and the emitted artefact says so rather than implying otherwise.
    settings.push({ key: POLICY_KEYS.mcpAccess, value: 'registry', from: 'tools.allow_mcp' });
  }
  if (policy.tools?.extensionTools !== undefined) {
    settings.push({
      key: POLICY_KEYS.extensionTools,
      value: policy.tools.extensionTools,
      from: 'tools.extension_tools',
    });
  }
  if (policy.tools?.virtualToolsThreshold !== undefined) {
    settings.push({
      key: POLICY_KEYS.virtualToolsThreshold,
      value: policy.tools.virtualToolsThreshold,
      from: 'tools.virtual_tools_threshold',
    });
  }
  if (policy.tools?.deny !== undefined && policy.tools.deny.length > 0) defer('tools.deny');

  if (policy.payload?.compressTerminalOutput !== undefined) {
    settings.push({
      key: POLICY_KEYS.compressOutput,
      value: policy.payload.compressTerminalOutput,
      from: 'payload.compress_terminal_output',
    });
  }
  if (policy.payload?.maxResultTokens !== undefined) defer('payload.max_result_tokens');

  if (policy.session?.maxRounds !== undefined) {
    settings.push({
      key: POLICY_KEYS.maxRequests,
      value: policy.session.maxRounds,
      from: 'session.max_rounds',
    });
  }
  if (policy.session?.nudgeAfterTurns !== undefined) defer('session.nudge_after_turns');

  if (policy.retrieval?.exclude !== undefined && policy.retrieval.exclude.length > 0) {
    settings.push({
      key: POLICY_KEYS.searchExclude,
      // `search.exclude` is a glob→boolean map, not a list.
      value: Object.fromEntries(policy.retrieval.exclude.map((glob) => [glob, true])),
      from: 'retrieval.exclude',
    });
  }
  if (policy.retrieval?.dedupeReads === true) defer('retrieval.dedupe_reads');

  // Sorted by id so an emitted artefact is byte-stable regardless of the
  // order the DSL happened to be written in.
  settings.sort((a, b) => a.key.id.localeCompare(b.key.id));
  deferred.sort((a, b) => a.at.localeCompare(b.at));

  return { settings, deferred };
}

/** The honest limit on `chat.defaultModel`, printed wherever it is emitted. */
export const DEFAULT_MODEL_CAVEAT =
  'chat.defaultModel sets the default for new conversations. It does not restrict the model menu, ' +
  'and an explicit mid-conversation switch is never overridden. Hard restriction happens one level up, ' +
  'in GitHub org Copilot model enablement. The residual leak is measurable — see AUTO-25.';
