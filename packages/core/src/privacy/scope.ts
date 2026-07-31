import { PrivacyError } from '../shared/errors.js';

/**
 * Who a report is for, and therefore what it may contain.
 *
 * This distinction exists because two genuinely different things get called
 * "a report":
 *
 * - **`self`** — a developer inspecting their own data, on their own
 *   machine, interactively. Showing them their own session or their own
 *   file path is not a privacy breach; it is the entire point of the tool,
 *   and refusing would be privacy theatre that made the product useless
 *   without protecting anybody.
 *
 * - **`shared`** — anything that leaves the machine or describes more than
 *   one person: exports, team dashboards, org rollups, anything forwarded
 *   to a manager. Here a single person's number must never be isolable,
 *   and a "top 3 sessions" list is exactly the shape that outs someone on
 *   a small team.
 *
 * **`shared` is the default everywhere it is not explicitly a self-inspection
 * command.** Fail closed: a new export path that forgets to declare its
 * scope gets the safe one, not the permissive one.
 */
export type ReportScope = 'self' | 'shared';

/**
 * Minimum number of distinct subjects (developers/installs) that must be
 * represented before a shared report may be produced at all.
 *
 * Five is not a magic number, it is a floor: below it, "the highest spender
 * in the group" narrows to a person by elimination even with every name
 * removed. Anyone who knows the team roster can finish the job.
 */
export const MIN_GROUP_SIZE = 5;

/**
 * A value that is safe to display in the given scope, or the reason it is
 * not. Mirrors `Value<T>` from `model/provenance.ts`: the type carries the
 * safety claim alongside the data, so the claim cannot be silently dropped.
 */
export interface Redacted<T> {
  readonly value: T;
  /** What was done to make this safe to show. */
  readonly treatment: 'hashed' | 'aggregated' | 'suppressed';
}

export interface PrivacyContext {
  readonly scope: ReportScope;
  /**
   * How many distinct subjects contributed to this report. On a single
   * developer's machine this is 1, which is exactly why a local ledger may
   * never be published as a shared report without aggregation.
   */
  readonly subjectCount: number;
}

/** A shared report may only list per-entity detail when this holds. */
export function mayListIndividuals(ctx: PrivacyContext): boolean {
  if (ctx.scope === 'self') return true;
  return ctx.subjectCount >= MIN_GROUP_SIZE;
}

/**
 * The enforcement gate — the privacy counterpart of `provenance.render()`.
 *
 * Throws rather than returning a flag, and throws *before* a report is
 * produced rather than filtering it afterwards. A filter that runs after
 * generation can be forgotten at one call site and silently leak; a throw
 * cannot be forgotten, because the report simply does not come out.
 *
 * ## Why one subject is allowed but three are not
 *
 * The risk this guards against is **re-identification by elimination**:
 * learning which row belongs to which person. That risk has a peculiar
 * shape.
 *
 * - **One subject.** The report describes a single developer, produced by
 *   that developer, about their own work. There is nobody to single out —
 *   the subject is already known to anyone reading it, and no inference is
 *   required. Blocking this would stop a developer sharing their own
 *   figures with their own manager, which protects nobody.
 * - **Two to four subjects.** The genuinely dangerous zone. Aggregate
 *   figures look anonymous but are trivially decomposed: with three people
 *   and one known value, the other two follow. Every identifier can be
 *   stripped and the report still names people to anyone holding the team
 *   roster. **Refused.**
 * - **Five or more.** Aggregates stop being invertible, so the report is
 *   allowed — though per-entity *lists* stay suppressed by
 *   {@link mayListIndividuals}, because a ranking re-introduces exactly the
 *   inference the group size was protecting against.
 */
export function assertSharedReportAllowed(ctx: PrivacyContext): void {
  if (ctx.scope === 'self') return;

  // A report about exactly one person cannot single that person out from
  // anybody; there is no group to eliminate within.
  if (ctx.subjectCount <= 1) return;

  if (ctx.subjectCount < MIN_GROUP_SIZE) {
    throw new PrivacyError(
      `A shared report covering ${String(ctx.subjectCount)} developers is refused: ` +
        `below ${String(MIN_GROUP_SIZE)}, aggregate figures can be decomposed back to an ` +
        'individual by elimination, even with every identifier removed. ' +
        `Aggregate at least ${String(MIN_GROUP_SIZE)} developers, or report each one separately ` +
        'to themselves in self scope.',
    );
  }
}
