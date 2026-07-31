import { PrivacyError } from '../shared/errors.js';
import { isPathRedacted } from './identifiers.js';
import { assertSharedReportAllowed, mayListIndividuals, type PrivacyContext } from './scope.js';

/**
 * The automatic check that stands between a report and the outside world.
 *
 * It runs on the finished artefact, walking whatever is about to be
 * published and refusing to let it out if it could expose a person. This
 * is the same enforcement bargain the provenance rule makes: the tool
 * would rather refuse and explain than emit something that looks fine and
 * quietly identifies someone.
 *
 * It is deliberately a **second** line of defence. The first is that
 * identifiers are hashed at ingest and per-entity lists are suppressed at
 * build time. This guard exists because the first line depends on every
 * future contributor remembering, and this one does not: a new field that
 * leaks a path will fail here even if nobody thought about privacy while
 * adding it.
 */

/** Keys whose values must never appear in a shared report, whatever they contain. */
const FORBIDDEN_KEYS = new Set(['sessionId', 'rawPath', 'absolutePath', 'userName', 'homeDir']);

/** Keys that hold a path and must therefore be redacted before publication. */
const PATH_KEYS = new Set(['sourceFile', 'file', 'filePath', 'path']);

export interface PrivacyViolation {
  /** JSON path to the offending field, e.g. `$.bySession[0].sessionId`. */
  readonly at: string;
  readonly problem: string;
}

/**
 * Walks a report payload and collects everything that would expose an
 * individual if published in the given scope. Returns the violations rather
 * than throwing, so tests can assert on the list and
 * {@link assertReportSafe} can turn it into one clear error.
 */
export function findPrivacyViolations(
  payload: unknown,
  ctx: PrivacyContext,
  path = '$',
): PrivacyViolation[] {
  if (ctx.scope === 'self') return [];

  if (Array.isArray(payload)) {
    return payload.flatMap((item, i) => findPrivacyViolations(item, ctx, `${path}[${String(i)}]`));
  }
  if (typeof payload !== 'object' || payload === null) return [];

  const violations: PrivacyViolation[] = [];

  for (const [key, value] of Object.entries(payload)) {
    const at = `${path}.${key}`;

    if (FORBIDDEN_KEYS.has(key) && value !== undefined && value !== null) {
      violations.push({
        at,
        problem: `"${key}" identifies a single subject and must not appear in a shared report`,
      });
      continue;
    }

    if (PATH_KEYS.has(key) && typeof value === 'string' && !isPathRedacted(value)) {
      violations.push({
        at,
        problem: `"${key}" still contains an absolute or home-directory path, which identifies a machine and its user`,
      });
      continue;
    }

    violations.push(...findPrivacyViolations(value, ctx, at));
  }

  return violations;
}

/**
 * Blocks publication of a report that would expose an individual.
 *
 * Checks two independent things, because they fail for different reasons:
 *
 * 1. **Group size.** Too few contributing developers means any figure can
 *    be narrowed to a person by elimination, however well identifiers are
 *    scrubbed. No amount of field-level redaction fixes this.
 * 2. **Field content.** Even with a large enough group, a leaked path or
 *    session id identifies someone directly.
 */
export function assertReportSafe(payload: unknown, ctx: PrivacyContext): void {
  assertSharedReportAllowed(ctx);

  const violations = findPrivacyViolations(payload, ctx);
  if (violations.length === 0) return;

  const detail = violations
    .slice(0, 10)
    .map((v) => `  ${v.at} — ${v.problem}`)
    .join('\n');
  const more = violations.length > 10 ? `\n  …and ${String(violations.length - 10)} more` : '';

  throw new PrivacyError(
    `This report cannot be shared: ${String(violations.length)} field(s) would expose an individual.\n${detail}${more}`,
  );
}

/**
 * Whether a per-entity list (a leaderboard, a per-session breakdown, a list
 * of individual requests) may be included.
 *
 * A ranked list is the sharpest re-identification tool in a report, and
 * removing the names does not blunt it: "the most expensive session last
 * month" is one person, and on a small team everybody can guess which.
 */
export function mayIncludeEntityList(ctx: PrivacyContext): boolean {
  return mayListIndividuals(ctx);
}

/**
 * The line a shared report prints in place of a suppressed list, so the
 * omission is visible rather than looking like an absence of data — the
 * same reasoning as reporting undetectable waste classes instead of
 * dropping them.
 */
export function suppressionNotice(): string {
  return (
    'Per-session detail is withheld so this report can be shared: a ranked list of individual ' +
    'sessions can identify a person by elimination even with every identifier removed. ' +
    'Aggregate figures above are unaffected.'
  );
}
