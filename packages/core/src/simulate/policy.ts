import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PolicySyntaxError } from '../shared/errors.js';
import type { ComplexityBand } from '../waste/complexity.js';

/**
 * The policy DSL — `.tokenlens/policy.yml` (DEVELOPMENT-PLAN.md D4.2).
 *
 * A policy is a **proposal**, not a deployment. Phase D4 only ever replays
 * recorded history against it to answer "what would this have cost?"; D5
 * is what turns an accepted policy into a managed-settings artefact.
 *
 * ## Two rules govern this parser, and they pull in opposite directions
 *
 * **An unrecognised key is a hard error.** A mistyped `max_results_tokens`
 * that parses and is then quietly ignored yields a simulation reporting
 * zero saving for that lever, and the reader concludes the lever does not
 * work. That is a wrong answer delivered with full confidence — much worse
 * than a refusal. So typos stop the run.
 *
 * **A recognised key TokenLens cannot yet simulate is neither an error nor
 * silently dropped.** `retrieval.exclude` is a real, sensible policy line,
 * but retrieval paths are salted-hashed at ingest for P7, so no glob can
 * ever be evaluated against them. Rejecting the file would stop people
 * writing complete policies; ignoring the line would let the report imply
 * it had been costed. Instead the key is accepted, recorded in
 * {@link ParsedPolicy.notSimulated}, and printed on the report as an
 * explicit omission.
 *
 * The distinction is the same one the waste report already draws between
 * "we looked and found nothing" and "we cannot look".
 */
export interface Policy {
  readonly version: 1;
  readonly model?: ModelPolicy;
  readonly tools?: ToolPolicy;
  readonly payload?: PayloadPolicy;
  readonly session?: SessionPolicy;
  readonly retrieval?: RetrievalPolicy;
}

export interface ModelPolicy {
  /**
   * Model for every request no rule matched. Deliberately powerful and
   * therefore risky: the simulator reports how much *high*-complexity work
   * this would have moved, because that is where a routing policy does
   * damage rather than saving money.
   */
  readonly default?: string;
  readonly route?: readonly RouteRule[];
  /** Model for background flows — titles, summaries, commit messages, intent detection. */
  readonly utility?: string;
}

/** Observable difficulty band, derived from the corpus's own distribution. */
export type { ComplexityBand };

export interface RouteCondition {
  readonly complexity?: ComplexityBand;
  /** Matches requests that completed in at most this many tool-call rounds. */
  readonly maxRounds?: number;
}

export interface RouteRule {
  readonly when: RouteCondition;
  readonly to: string;
}

export interface ToolPolicy {
  /**
   * MCP servers that stay installed. Everything else — every other server,
   * but never the editor's built-in tools — is treated as removed.
   */
  readonly allowMcp?: readonly string[];
  /** Individual tool names to remove. `prefix*` matches by prefix. */
  readonly deny?: readonly string[];
  /** Tool count above which VS Code groups tools and activates them on demand. */
  readonly virtualToolsThreshold?: number;
  /** Whether extension-contributed tool schemas are sent at all. */
  readonly extensionTools?: boolean;
}

export interface PayloadPolicy {
  /** Tool results are truncated to this many tokens. */
  readonly maxResultTokens?: number;
  /** Collapse unchanged diff hunks, drop lockfile diffs, strip install progress. */
  readonly compressTerminalOutput?: boolean;
}

export interface SessionPolicy {
  /** Agent loops stop after this many tool-call rounds within one request. */
  readonly maxRounds?: number;
  /** A session is restarted after this many turns. */
  readonly nudgeAfterTurns?: number;
}

export interface RetrievalPolicy {
  /** Re-reads of content already in context are served from it, not re-fetched. */
  readonly dedupeReads?: boolean;
  /** Globs excluded from search, so snippet tokens are never billed for them. */
  readonly exclude?: readonly string[];
}

/** The empty policy: changes nothing, and must therefore save exactly zero. */
export const NULL_POLICY: Policy = { version: 1 };

/**
 * A key that is part of the DSL, was present in the file, and **could not be
 * priced** — with the reason, and what would have to change.
 *
 * Not priced is not the same as not deployable. Every key listed here is
 * still carried into {@link Policy} and still emitted by `tokenlens policy`;
 * what is missing is a credit figure, and the report says so rather than
 * printing a zero that would read as "this does not help".
 */
export interface NotSimulated {
  readonly at: string;
  readonly reason: string;
  readonly unblockedBy: string;
}

export interface ParsedPolicy {
  readonly policy: Policy;
  readonly notSimulated: readonly NotSimulated[];
}

/**
 * Keys that belong to the DSL but that this phase cannot replay. Each entry
 * says why in terms of the data, not in terms of the roadmap — "not built
 * yet" and "not derivable from what is recorded" are very different claims
 * and only the second is a real limitation.
 */
const RECOGNISED_BUT_UNSIMULABLE: Readonly<Record<string, Omit<NotSimulated, 'at'>>> = {
  'model.utility': {
    reason:
      'A utility request (a title, a commit message, an intent classification) is not distinguishable ' +
      'from a normal one in the journal — no field records what a request was for.',
    unblockedBy:
      'VS Code labelling internal requests, or a heuristic validated against a labelled sample rather than asserted.',
  },
  'tools.virtualToolsThreshold': {
    reason:
      'Virtual tool grouping changes how VS Code renders the tool schema, and the journal records only the resulting total. ' +
      'The saving cannot be separated from the tool set that produced it.',
    unblockedBy: 'A before/after measurement of tool-definition tokens with the threshold moved.',
  },
  'tools.extensionTools': {
    reason:
      'Extension-contributed tools cannot be told apart from built-in ones by name alone, and guessing ' +
      'would silently mis-price whichever way the guess fell.',
    unblockedBy: "The editor's installed-tool manifest, supplied as a second input.",
  },
  'payload.compressTerminalOutput': {
    reason:
      'The compression ratio is a property of the compressor, which is not run here. Assuming one would make ' +
      'the saving a function of the assumption rather than of the data.',
    unblockedBy: 'Measured before/after sizes from the compressor itself.',
  },
  'retrieval.exclude': {
    reason:
      'Retrieval targets are salted-hashed at ingest so that no file path is stored (P7). A glob cannot be ' +
      'evaluated against a hash — this is the privacy rule working as intended, not a gap.',
    unblockedBy:
      'Nothing, by design. Excluding paths is still worth deploying; its saving has to be measured after the fact rather than replayed.',
  },
};

type Json = Record<string, unknown>;

export interface ParsePolicyOptions {
  /** Included in errors so the message points at the file the user edited. */
  readonly filePath?: string;
}

/**
 * Parses and validates a policy document. Accepts YAML, and therefore JSON
 * too — YAML is a superset, so one code path serves both file extensions.
 */
export function parsePolicy(source: string, options: ParsePolicyOptions = {}): ParsedPolicy {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (error) {
    throw fail('', 'The file is not valid YAML.', options, {
      cause: error,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (raw === null || raw === undefined) {
    // An empty file is a valid null policy — and a useful thing to run,
    // since it is the control case that must save exactly zero.
    return { policy: NULL_POLICY, notSimulated: [] };
  }

  const root = expectObject(raw, '', options);
  const notSimulated: NotSimulated[] = [];

  requireKnownKeys(
    root,
    '',
    ['version', 'model', 'tools', 'payload', 'session', 'retrieval'],
    options,
  );

  const version = root.version;
  if (version !== 1) {
    throw fail(
      'version',
      `Expected \`version: 1\`, found ${version === undefined ? 'nothing' : JSON.stringify(version)}. ` +
        'The version is required so that a policy written today can be recognised when the DSL changes.',
      options,
    );
  }

  const policy: Policy = {
    version: 1,
    ...optional('model', parseModel(root.model, options, notSimulated)),
    ...optional('tools', parseTools(root.tools, options, notSimulated)),
    ...optional('payload', parsePayload(root.payload, options, notSimulated)),
    ...optional('session', parseSession(root.session, options)),
    ...optional('retrieval', parseRetrieval(root.retrieval, options, notSimulated)),
  };

  return { policy, notSimulated };
}

function parseModel(
  value: unknown,
  options: ParsePolicyOptions,
  notSimulated: NotSimulated[],
): ModelPolicy | undefined {
  if (value === undefined) return undefined;
  const node = expectObject(value, 'model', options);
  requireKnownKeys(node, 'model', ['default', 'route', 'utility'], options);
  noteUnsimulable(node, 'model', 'utility', 'model.utility', notSimulated);

  const route = node.route;
  const rules =
    route === undefined
      ? undefined
      : expectArray(route, 'model.route', options).map((entry, index) =>
          parseRouteRule(entry, `model.route[${String(index)}]`, options),
        );

  const result: ModelPolicy = {
    ...optional(
      'default',
      node.default === undefined ? undefined : expectString(node.default, 'model.default', options),
    ),
    ...optional('route', rules),
    ...optional(
      'utility',
      node.utility === undefined ? undefined : expectString(node.utility, 'model.utility', options),
    ),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseRouteRule(value: unknown, at: string, options: ParsePolicyOptions): RouteRule {
  const node = expectObject(value, at, options);
  requireKnownKeys(node, at, ['when', 'to'], options);

  const to = expectString(node.to, `${at}.to`, options);
  const when = expectObject(node.when, `${at}.when`, options);
  requireKnownKeys(when, `${at}.when`, ['complexity', 'max_rounds'], options);

  const complexityRaw = when.complexity;
  let complexity: ComplexityBand | undefined;
  if (complexityRaw !== undefined) {
    const text = expectString(complexityRaw, `${at}.when.complexity`, options);
    if (text !== 'low' && text !== 'medium' && text !== 'high') {
      throw fail(
        `${at}.when.complexity`,
        `Expected one of low, medium, high — found ${JSON.stringify(text)}.`,
        options,
      );
    }
    complexity = text;
  }

  const maxRoundsRaw = when.max_rounds;
  const maxRounds =
    maxRoundsRaw === undefined
      ? undefined
      : expectPositiveInteger(maxRoundsRaw, `${at}.when.max_rounds`, options);

  if (complexity === undefined && maxRounds === undefined) {
    throw fail(
      `${at}.when`,
      'A routing rule with no condition would move every request, which is what `model.default` is for. ' +
        'Give it a `complexity` band or a `max_rounds` bound, or use `model.default`.',
      options,
    );
  }

  return {
    to,
    when: { ...optional('complexity', complexity), ...optional('maxRounds', maxRounds) },
  };
}

function parseTools(
  value: unknown,
  options: ParsePolicyOptions,
  notSimulated: NotSimulated[],
): ToolPolicy | undefined {
  if (value === undefined) return undefined;
  const node = expectObject(value, 'tools', options);
  requireKnownKeys(
    node,
    'tools',
    ['allow_mcp', 'deny', 'virtual_tools_threshold', 'extension_tools'],
    options,
  );
  noteUnsimulable(
    node,
    'tools',
    'virtual_tools_threshold',
    'tools.virtualToolsThreshold',
    notSimulated,
  );
  noteUnsimulable(node, 'tools', 'extension_tools', 'tools.extensionTools', notSimulated);

  const result: ToolPolicy = {
    ...optional(
      'allowMcp',
      node.allow_mcp === undefined
        ? undefined
        : expectStringArray(node.allow_mcp, 'tools.allow_mcp', options),
    ),
    ...optional(
      'deny',
      node.deny === undefined ? undefined : expectStringArray(node.deny, 'tools.deny', options),
    ),
    ...optional(
      'virtualToolsThreshold',
      node.virtual_tools_threshold === undefined
        ? undefined
        : expectPositiveInteger(
            node.virtual_tools_threshold,
            'tools.virtual_tools_threshold',
            options,
          ),
    ),
    ...optional(
      'extensionTools',
      node.extension_tools === undefined
        ? undefined
        : expectBoolean(node.extension_tools, 'tools.extension_tools', options),
    ),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function parsePayload(
  value: unknown,
  options: ParsePolicyOptions,
  notSimulated: NotSimulated[],
): PayloadPolicy | undefined {
  if (value === undefined) return undefined;
  const node = expectObject(value, 'payload', options);
  requireKnownKeys(node, 'payload', ['max_result_tokens', 'compress_terminal_output'], options);
  noteUnsimulable(
    node,
    'payload',
    'compress_terminal_output',
    'payload.compressTerminalOutput',
    notSimulated,
  );

  const result: PayloadPolicy = {
    ...optional(
      'maxResultTokens',
      node.max_result_tokens === undefined
        ? undefined
        : expectPositiveInteger(node.max_result_tokens, 'payload.max_result_tokens', options),
    ),
    ...optional(
      'compressTerminalOutput',
      node.compress_terminal_output === undefined
        ? undefined
        : expectBoolean(node.compress_terminal_output, 'payload.compress_terminal_output', options),
    ),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseSession(value: unknown, options: ParsePolicyOptions): SessionPolicy | undefined {
  if (value === undefined) return undefined;
  const node = expectObject(value, 'session', options);
  requireKnownKeys(node, 'session', ['max_rounds', 'nudge_after_turns'], options);

  const result: SessionPolicy = {
    ...optional(
      'maxRounds',
      node.max_rounds === undefined
        ? undefined
        : expectPositiveInteger(node.max_rounds, 'session.max_rounds', options),
    ),
    ...optional(
      'nudgeAfterTurns',
      node.nudge_after_turns === undefined
        ? undefined
        : expectPositiveInteger(node.nudge_after_turns, 'session.nudge_after_turns', options),
    ),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseRetrieval(
  value: unknown,
  options: ParsePolicyOptions,
  notSimulated: NotSimulated[],
): RetrievalPolicy | undefined {
  if (value === undefined) return undefined;
  const node = expectObject(value, 'retrieval', options);
  requireKnownKeys(node, 'retrieval', ['exclude', 'dedupe_reads'], options);
  noteUnsimulable(node, 'retrieval', 'exclude', 'retrieval.exclude', notSimulated);

  const result: RetrievalPolicy = {
    ...optional(
      'dedupeReads',
      node.dedupe_reads === undefined
        ? undefined
        : expectBoolean(node.dedupe_reads, 'retrieval.dedupe_reads', options),
    ),
    ...optional(
      'exclude',
      node.exclude === undefined
        ? undefined
        : expectStringArray(node.exclude, 'retrieval.exclude', options),
    ),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parses a policy file from its raw bytes, decoding by byte-order mark.
 *
 * This exists because of a specific, reproducible Windows trap: piping
 * `tokenlens simulate --emit-policy` to a file in Windows PowerShell 5.1
 * produces **UTF-16LE**, since that is `>` and `Tee-Object`'s default
 * encoding. Reading it back as UTF-8 yields a string of interleaved NULs,
 * and the user is told their freshly generated policy file is malformed.
 *
 * Being strict about *content* is the point of this parser. Being strict
 * about *encoding* only punishes people for their shell's defaults.
 */
export function parsePolicyBuffer(buffer: Buffer, options: ParsePolicyOptions = {}): ParsedPolicy {
  return parsePolicy(decodeByBom(buffer), options);
}

function decodeByBom(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // UTF-16BE: Node has no decoder for it, so swap to LE in place.
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  return buffer.toString('utf8');
}

// ---------------------------------------------------------------------------
// Validation primitives. Every one of these throws rather than coercing: a
// policy is a financial instruction, and "1000" silently becoming 1000 is the
// kind of leniency that makes a later mis-parse impossible to notice.
// ---------------------------------------------------------------------------

/**
 * Renders a policy back to the on-disk YAML shape, so that a policy derived
 * from measured data (`simulate --all`) can be written out, reviewed, edited
 * and re-simulated. Round-tripping is what makes the derived portfolio a
 * starting point a team can argue with rather than a black box.
 */
export function stringifyPolicy(policy: Policy): string {
  const document: Record<string, unknown> = { version: policy.version };

  if (policy.model) {
    document.model = {
      ...optional('default', policy.model.default),
      ...optional(
        'route',
        policy.model.route?.map((rule) => ({
          when: {
            ...optional('complexity', rule.when.complexity),
            ...optional('max_rounds', rule.when.maxRounds),
          },
          to: rule.to,
        })),
      ),
      ...optional('utility', policy.model.utility),
    };
  }
  if (policy.tools) {
    document.tools = {
      ...optional('allow_mcp', policy.tools.allowMcp),
      ...optional('deny', policy.tools.deny),
      ...optional('virtual_tools_threshold', policy.tools.virtualToolsThreshold),
      ...optional('extension_tools', policy.tools.extensionTools),
    };
  }
  if (policy.payload) {
    document.payload = {
      ...optional('max_result_tokens', policy.payload.maxResultTokens),
      ...optional('compress_terminal_output', policy.payload.compressTerminalOutput),
    };
  }
  if (policy.session) {
    document.session = {
      ...optional('max_rounds', policy.session.maxRounds),
      ...optional('nudge_after_turns', policy.session.nudgeAfterTurns),
    };
  }
  if (policy.retrieval) {
    document.retrieval = {
      ...optional('dedupe_reads', policy.retrieval.dedupeReads),
      ...optional('exclude', policy.retrieval.exclude),
    };
  }

  return stringifyYaml(document, { lineWidth: 0 });
}
function requireKnownKeys(
  node: Json,
  at: string,
  known: readonly string[],
  options: ParsePolicyOptions,
): void {
  for (const key of Object.keys(node)) {
    if (known.includes(key)) continue;
    const where = at === '' ? 'the top level' : `\`${at}\``;
    throw fail(
      at === '' ? key : `${at}.${key}`,
      `Unknown key \`${key}\` at ${where}. Known keys here: ${known.join(', ')}. ` +
        'Unknown keys are refused rather than ignored — a typo that is silently dropped would ' +
        'report a zero saving for a lever you thought you had configured.',
      options,
      { suggestion: nearest(key, known) },
    );
  }
}

/** Records a recognised-but-uncostable key so the report can state the omission. */
function noteUnsimulable(
  node: Json,
  parent: string,
  key: string,
  registryKey: string,
  notSimulated: NotSimulated[],
): void {
  if (node[key] === undefined) return;
  const entry = RECOGNISED_BUT_UNSIMULABLE[registryKey];
  if (!entry) return;
  notSimulated.push({ at: `${parent}.${key}`, ...entry });
}

function expectObject(value: unknown, at: string, options: ParsePolicyOptions): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fail(at, `Expected a mapping, found ${describe(value)}.`, options);
  }
  return value as Json;
}

function expectArray(value: unknown, at: string, options: ParsePolicyOptions): unknown[] {
  if (!Array.isArray(value)) {
    throw fail(at, `Expected a list, found ${describe(value)}.`, options);
  }
  return value;
}

function expectString(value: unknown, at: string, options: ParsePolicyOptions): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw fail(at, `Expected a non-empty string, found ${describe(value)}.`, options);
  }
  return value;
}

function expectStringArray(
  value: unknown,
  at: string,
  options: ParsePolicyOptions,
): readonly string[] {
  return expectArray(value, at, options).map((entry, index) =>
    expectString(entry, `${at}[${String(index)}]`, options),
  );
}

function expectBoolean(value: unknown, at: string, options: ParsePolicyOptions): boolean {
  if (typeof value !== 'boolean') {
    throw fail(at, `Expected true or false, found ${describe(value)}.`, options);
  }
  return value;
}

function expectPositiveInteger(value: unknown, at: string, options: ParsePolicyOptions): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw fail(at, `Expected a positive whole number, found ${describe(value)}.`, options);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'string') {
    // Truncated: a type mismatch at the top level means `value` is the whole
    // file, and an error message that reprints the file is unreadable.
    return `string ${JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value)}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${typeof value} ${String(value)}`;
  }
  return typeof value;
}

interface FailExtras {
  readonly cause?: unknown;
  readonly detail?: string;
  readonly suggestion?: string | undefined;
}

function fail(
  at: string,
  problem: string,
  options: ParsePolicyOptions,
  extras: FailExtras = {},
): PolicySyntaxError {
  const location = at === '' ? '' : ` at \`${at}\``;
  const file = options.filePath === undefined ? '' : ` (${options.filePath})`;
  const suggestion =
    extras.suggestion === undefined ? '' : ` Did you mean \`${extras.suggestion}\`?`;
  const detail = extras.detail === undefined ? '' : ` ${extras.detail}`;

  return new PolicySyntaxError(
    `Policy${location}${file}: ${problem}${suggestion}${detail}`,
    { at, problem, ...optional('filePath', options.filePath) },
    extras.cause !== undefined ? { cause: extras.cause } : undefined,
  );
}

/**
 * Closest known key by edit distance, so an error can say "did you mean" for
 * the overwhelmingly common failure (a typo) instead of only listing the
 * alternatives. Returns nothing when nothing is close enough to be a
 * plausible correction rather than a guess.
 */
function nearest(candidate: string, known: readonly string[]): string | undefined {
  let best: { key: string; distance: number } | undefined;
  for (const key of known) {
    const distance = editDistance(candidate, key);
    if (!best || distance < best.distance) best = { key, distance };
  }
  if (!best) return undefined;
  return best.distance <= Math.max(2, Math.floor(candidate.length / 3)) ? best.key : undefined;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Spreads a key only when its value is defined, so optional fields stay
 * genuinely absent under `exactOptionalPropertyTypes` rather than present
 * and set to `undefined`.
 */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : { [key]: value };
}
