/**
 * The complete set of deliberate TokenLens error codes. Extend this union
 * whenever a new `TokenLensError` subclass is added below.
 */
export type TokenLensErrorCode =
  | 'SCHEMA_DRIFT'
  | 'COVERAGE'
  | 'POLICY_CHANNEL'
  | 'POLICY_SYNTAX'
  | 'PROVENANCE'
  | 'PRIVACY'
  | 'UNSAFE_PATH'
  | 'UNSAFE_REF'
  | 'CONFIG'
  | 'NOT_IMPLEMENTED';

export interface TokenLensErrorOptions {
  readonly cause?: unknown;
}

/**
 * Base class for every error TokenLens raises on purpose.
 *
 * Design principle (PLAN.md P5 — "degrade loudly, never silently"): any
 * failure mode that could otherwise produce a silent zero, a swallowed
 * exception, or an ignored edge case must surface as one of these, carrying
 * machine-readable `context` so it can be diagnosed without a debugger.
 *
 * TypeScript's `abstract` keyword only prevents `new TokenLensError(...)`
 * at compile time — it is erased from the emitted JavaScript, so a
 * plain-JS consumer of the compiled package could still call it directly.
 * The `new.target` check below closes that gap at runtime too.
 */
export abstract class TokenLensError<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> extends Error {
  abstract readonly code: TokenLensErrorCode;
  readonly context: Readonly<TContext>;

  protected constructor(message: string, context: TContext, options: TokenLensErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);

    if (new.target === TokenLensError) {
      throw new TypeError('TokenLensError is abstract and must not be instantiated directly.');
    }

    this.name = new.target.name;
    this.context = context;
    // Not optional in Node/V8 (unlike some older non-V8 JS engines) —
    // engines.node >= 20 guarantees this is always present.
    Error.captureStackTrace(this, new.target);
  }
}

/**
 * The VS Code chatSessions journal no longer matches a pinned known-good
 * shape: a required field is missing, renamed, or of the wrong type.
 * Ingest must never fall back to a default value here — see PLAN.md §10.2.
 */
export class SchemaDriftError extends TokenLensError<{
  field: string;
  expected: string;
  actual: unknown;
  sourceFile: string;
}> {
  readonly code = 'SCHEMA_DRIFT' as const;

  // Not "useless": TokenLensError's constructor is `protected`, and a
  // subclass that declares no constructor of its own inherits that same
  // protected accessibility (TS2674) — it would silently stop being
  // publicly `new`-able. Redeclaring it, even as a pure pass-through,
  // re-exposes a public constructor. Repeated on every subclass below.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(
    message: string,
    context: { field: string; expected: string; actual: unknown; sourceFile: string },
    options?: TokenLensErrorOptions,
  ) {
    super(message, context, options);
  }
}

/**
 * The fraction of requests carrying a required field (e.g. `copilotCredits`)
 * has dropped below the CI-pinned extraction-rate threshold. Distinguishes
 * "legitimately sparse" (fine, label `Modelled`) from "the field vanished"
 * (not fine, stop the pipeline).
 */
export class CoverageError extends TokenLensError<{
  field: string;
  observedRate: number;
  minimumRate: number;
  sampleSize: number;
}> {
  readonly code = 'COVERAGE' as const;

  // See the comment on SchemaDriftError's constructor above.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(
    message: string,
    context: { field: string; observedRate: number; minimumRate: number; sampleSize: number },
    options?: TokenLensErrorOptions,
  ) {
    super(message, context, options);
  }
}

/**
 * A policy artefact would be emitted to a Managed Settings channel that is
 * not the one actually in effect. Precedence is winner-take-all (native
 * MDM > server-managed > file-based) — see PLAN.md §18.1 / risk A2.
 * Emitting to a losing channel is a silent no-op from the platform's
 * perspective, so TokenLens refuses outright rather than deploying it.
 */
export class PolicyChannelError extends TokenLensError<{
  targetChannel: string;
  activeChannel: string;
}> {
  readonly code = 'POLICY_CHANNEL' as const;

  // See the comment on SchemaDriftError's constructor above.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(
    message: string,
    context: { targetChannel: string; activeChannel: string },
    options?: TokenLensErrorOptions,
  ) {
    super(message, context, options);
  }
}

/**
 * Code attempted to render a `Modelled<T>` value without its provenance
 * footnote (basis + assumptions) — see PLAN.md §13 metric policy: an
 * estimate must never be presented as if it were a measurement.
 */
export class ProvenanceError extends TokenLensError<{ kind: 'measured' | 'modelled' }> {
  readonly code = 'PROVENANCE' as const;

  // See the comment on SchemaDriftError's constructor above.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(
    message: string,
    context: { kind: 'measured' | 'modelled' },
    options?: TokenLensErrorOptions,
  ) {
    super(message, context, options);
  }
}

/**
 * Code attempted to produce a shared report that could expose an
 * individual — either because too few developers contributed to hide any
 * one of them, or because a per-entity listing survived into a shared
 * artefact.
 *
 * This is the privacy counterpart of {@link ProvenanceError}, and it is
 * deliberately raised *before* the report is generated rather than
 * filtering afterwards: a post-hoc filter can be forgotten at one call
 * site and leak silently, whereas a throw cannot be forgotten because no
 * report comes out at all.
 */
export class PrivacyError extends TokenLensError<{ reason: string }> {
  readonly code = 'PRIVACY' as const;

  // Not a useless constructor: it narrows the public signature to a single
  // message and derives `context` from it, so callers cannot forget to
  // record why a report was refused.
  constructor(message: string, options?: TokenLensErrorOptions) {
    super(message, { reason: message }, options);
  }
}

/**
 * A user-authored `.tokenlens/policy.yml` could not be understood: it is
 * not valid YAML, or it contains a key or value TokenLens does not
 * recognise.
 *
 * Unknown keys are an **error rather than a warning** on purpose. A
 * mistyped `max_results_tokens` that is silently ignored produces a
 * simulation reporting zero saving, and the user concludes the lever does
 * not work — a wrong answer delivered confidently. Refusing to run is the
 * only outcome that cannot be misread.
 */
export class PolicySyntaxError extends TokenLensError<{
  /** Dotted path to the offending key, e.g. `payload.max_result_tokens`. */
  at: string;
  problem: string;
  filePath?: string;
}> {
  readonly code = 'POLICY_SYNTAX' as const;

  // See the comment on SchemaDriftError's constructor above.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(
    message: string,
    context: { at: string; problem: string; filePath?: string },
    options?: TokenLensErrorOptions,
  ) {
    super(message, context, options);
  }
}

/**
 * A candidate filesystem path resolved outside of its required root — the
 * guard against path traversal (audit defect D-15).
 */
export class UnsafePathError extends TokenLensError<{ candidate: string; root: string }> {
  readonly code = 'UNSAFE_PATH' as const;

  // See the comment on SchemaDriftError's constructor above.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(
    message: string,
    context: { candidate: string; root: string },
    options?: TokenLensErrorOptions,
  ) {
    super(message, context, options);
  }
}

/**
 * A git ref / branch name failed the strict charset allowlist — the guard
 * against branch-name injection (audit defect D-16).
 */
export class UnsafeRefError extends TokenLensError<{ candidate: string }> {
  readonly code = 'UNSAFE_REF' as const;

  // See the comment on SchemaDriftError's constructor above.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(message: string, context: { candidate: string }, options?: TokenLensErrorOptions) {
    super(message, context, options);
  }
}

/**
 * A problem with the user-authored `.tokenlens/config.json`: either the
 * file exists but is not valid JSON, or it references an `env:VAR_NAME`
 * environment variable that is not set. Both must fail loudly — see
 * PLAN.md P5.
 */
export class ConfigError extends TokenLensError<{
  reason: 'missing-env-var' | 'malformed-json';
  variableName?: string;
  filePath?: string;
}> {
  readonly code = 'CONFIG' as const;

  // See the comment on SchemaDriftError's constructor above.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(
    message: string,
    context: {
      reason: 'missing-env-var' | 'malformed-json';
      variableName?: string;
      filePath?: string;
    },
    options?: TokenLensErrorOptions,
  ) {
    super(message, context, options);
  }
}

/**
 * A CLI command exists in the roadmap (`tokenlens --help` lists it) but its
 * action has not been implemented yet. Carries the phase that ships it so
 * the error message itself points at DEVELOPMENT-PLAN.md.
 */
export class NotImplementedError extends TokenLensError<{ command: string; phase: string }> {
  readonly code = 'NOT_IMPLEMENTED' as const;

  constructor(command: string, phase: string) {
    super(`"${command}" is not implemented yet — it ships in Phase ${phase}.`, {
      command,
      phase,
    });
  }
}
