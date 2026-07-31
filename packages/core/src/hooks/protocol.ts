/**
 * The hook wire protocol.
 *
 * A hook is invoked by the Copilot agent as a subprocess: JSON arrives on
 * stdin, a decision leaves on stdout, and the agent acts on it. That makes
 * this module two things at once — a type definition and a **security
 * boundary**.
 *
 * ## stdin is agent-controlled and therefore untrusted
 *
 * The payload contains text the model produced, which in turn may contain
 * text a web page or a repository produced. It is the least trustworthy
 * input in the entire product (risk A5). So:
 *
 * - Every field is validated before use; nothing is read off an unchecked
 *   object.
 * - Unknown fields are **ignored, not rejected**. Hooks are Preview and the
 *   schema will change; a strict rejection would turn every VS Code update
 *   into an outage.
 * - Missing *required* fields produce a fail-open decision, never a throw.
 * - No value from here is ever interpolated into a shell command, and any
 *   path is resolved through `assertContained` before it is touched.
 *
 * ## The output contract
 *
 * Silence is not neutral: a hook that writes nothing, or writes malformed
 * JSON, can stall or break the agent. So every path — including a crash —
 * ends in exactly one well-formed decision on stdout and exit code 0.
 */

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * The validated view of stdin. Deliberately narrow: every field the guards
 * actually use, and nothing else. Fields the agent sends that are not here
 * are dropped at the boundary rather than carried around untyped.
 */
export interface HookInput {
  readonly event: HookEvent;
  /** Opaque conversation id. Hashed before it reaches any store. */
  readonly sessionId: string;
  readonly toolName?: string;
  /** Raw tool arguments. Never trusted; read only through the accessors below. */
  readonly toolInput?: Readonly<Record<string, unknown>>;
  /** Present on PostToolUse. */
  readonly toolResponse?: Readonly<Record<string, unknown>>;
  /** True when the tool reported failure, where the agent tells us. */
  readonly toolError?: boolean;
  readonly prompt?: string;
  readonly turn?: number;
  readonly cwd?: string;
  readonly agentId?: string;
}

export type PermissionDecision = 'allow' | 'deny' | 'ask';

/**
 * The decision written to stdout.
 *
 * `continue: false` halts the whole session and is reserved for the runaway
 * halt; `permissionDecision: 'deny'` blocks one tool call. Conflating them
 * would mean a single suppressed re-read ended someone's conversation.
 */
export interface HookDecision {
  readonly continue: boolean;
  readonly stopReason?: string;
  /** Shown to the developer in chat. The Tier C nudge channel. */
  readonly systemMessage?: string;
  readonly hookSpecificOutput?: {
    readonly hookEventName: HookEvent;
    readonly permissionDecision?: PermissionDecision;
    readonly permissionDecisionReason?: string;
    /** A narrowed replacement for the tool's arguments. */
    readonly updatedInput?: Readonly<Record<string, unknown>>;
  };
}

/** The only safe default, and the one every failure path returns. */
export const ALLOW: HookDecision = { continue: true };

export function allow(): HookDecision {
  return ALLOW;
}

export function deny(event: HookEvent, reason: string): HookDecision {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** Narrows a call rather than refusing it — the better outcome where it applies. */
export function rewrite(
  event: HookEvent,
  updatedInput: Readonly<Record<string, unknown>>,
  reason: string,
): HookDecision {
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
      updatedInput,
    },
  };
}

export function halt(stopReason: string): HookDecision {
  return { continue: false, stopReason };
}

export function notify(message: string): HookDecision {
  return { continue: true, systemMessage: message };
}

/**
 * Parses and validates stdin.
 *
 * Returns `undefined` rather than throwing on anything malformed. The caller
 * turns that into an allow, because a hook that cannot understand its input
 * has no business having an opinion about the tool call.
 */
export function parseHookInput(raw: string, fallbackEvent?: string): HookInput | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const payload = parsed as Record<string, unknown>;

  // The event may arrive in the payload or on the command line; the flag
  // wins, because that is the one the hook configuration controls and the
  // payload is the untrusted side.
  const eventValue = fallbackEvent ?? payload.hookEventName ?? payload.event;
  if (!isHookEvent(eventValue)) return undefined;

  const sessionId = readString(payload, 'sessionId') ?? readString(payload, 'session_id');
  if (sessionId === undefined) return undefined;

  return {
    event: eventValue,
    sessionId,
    ...optional('toolName', readString(payload, 'toolName') ?? readString(payload, 'tool_name')),
    ...optional('toolInput', readObject(payload, 'toolInput') ?? readObject(payload, 'tool_input')),
    ...optional(
      'toolResponse',
      readObject(payload, 'toolResponse') ?? readObject(payload, 'tool_response'),
    ),
    ...optional('toolError', readBoolean(payload, 'toolError') ?? readBoolean(payload, 'is_error')),
    ...optional('prompt', readString(payload, 'prompt')),
    ...optional(
      'turn',
      readFiniteNumber(payload, 'turn') ?? readFiniteNumber(payload, 'turnIndex'),
    ),
    ...optional('cwd', readString(payload, 'cwd')),
    ...optional('agentId', readString(payload, 'agentId') ?? readString(payload, 'agent_id')),
  };
}

/**
 * Path-bearing argument keys, matching `ingest/tool-target.ts` so the hook
 * and the ledger agree about which argument names a file lives in.
 */
const PATH_KEYS = ['filePath', 'file_path', 'path', 'absolutePath', 'uri'] as const;
const START_KEYS = ['startLine', 'start_line', 'offset'] as const;
const END_KEYS = ['endLine', 'end_line', 'limit'] as const;

export interface ToolTargetRequest {
  readonly rawPath: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

/**
 * Extracts the file a tool call is about to touch.
 *
 * Returns the **raw** path deliberately: the caller must resolve it through
 * `assertContained` against a root it chooses, and pushing that decision
 * outward keeps the containment check at the point where the root is known
 * rather than guessed here.
 */
export function readToolTarget(input: HookInput): ToolTargetRequest | undefined {
  const args = input.toolInput;
  if (!args) return undefined;

  let rawPath: string | undefined;
  for (const key of PATH_KEYS) {
    const candidate = args[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      rawPath = candidate;
      break;
    }
  }
  if (rawPath === undefined) return undefined;

  return {
    rawPath,
    ...optional('startLine', firstNumber(args, START_KEYS)),
    ...optional('endLine', firstNumber(args, END_KEYS)),
  };
}

function firstNumber(
  args: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readFiniteNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readObject(
  payload: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = payload[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
