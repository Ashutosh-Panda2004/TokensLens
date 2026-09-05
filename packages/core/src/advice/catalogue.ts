import { createHash } from 'node:crypto';
import { MAX_CANDIDATES_PER_FINDING, toolFixableClasses } from './taxonomy.js';
import type { WasteClass } from '../waste/types.js';
import type { FixMechanism, IntegrationSurface } from './taxonomy.js';

/**
 * D11 — the schema for one curated, open-source catalogue entry.
 *
 * Design goals, in order: every field must be checkable by a human in under a
 * minute; every field must have a defined staleness behaviour; and the shape
 * must be enforced by `tsc` rather than by a runtime validator, because a
 * catalogue that can be malformed at runtime is a catalogue that will be.
 *
 * See D11-PRESCRIPTIVE-ADVICE.md §3.
 */

/**
 * SPDX identifiers, restricted to OSI-approved licences. The union is
 * deliberately closed: a licence this file has not seen before should fail the
 * build and get a human's attention, not be waved through as a string.
 */
export type SpdxLicence =
  'MIT' | 'Apache-2.0' | 'BSD-2-Clause' | 'BSD-3-Clause' | 'MPL-2.0' | 'ISC';

/**
 * How good the claim is that this entry helps.
 *
 * The same discipline as `Measured<T>` vs `Modelled<T>`: `measured-local` is the
 * only level that licenses a numeric savings claim. Everything else renders as a
 * mechanism, never as a percentage.
 */
export type EvidenceLevel =
  /** The project claims a reduction. We have not reproduced it. */
  | 'upstream-claim'
  /** The mechanism plainly reduces tokens; the magnitude is unknown. */
  | 'mechanism'
  /** We measured it against a TokenLens corpus. */
  | 'measured-local';

export type EntryStatus =
  /** Passes every rule in the inclusion bar. May be offered. */
  | 'recommended'
  /** Admissible but carries a named caveat. Offered only with the caveat attached. */
  | 'caution'
  /** Fails the bar. Retained so the engine can refuse it by name. Never offered. */
  | 'deprecated';

export interface InstallProfile {
  /** The canonical one-liner from upstream, quoted rather than paraphrased. */
  readonly command: string;
  readonly complexity: 'one-line' | 'config-edit' | 'multi-step';
  /** Can it be undone by deleting one thing? Rule 5 of the inclusion bar. */
  readonly reversible: boolean;
}

/**
 * How a fact about an entry came to be believed.
 *
 * The same three-level discipline as `Measured` vs `Modelled`, applied to
 * curation rather than to arithmetic. It exists because agent-collected
 * repository metadata produced three plausible-looking errors while this feature
 * was being designed — a wrong owner, an implausible star count, another wrong
 * owner — none of which any type or lint rule would have caught. Identity fields
 * are security-relevant: sending a developer to the wrong repository turns a
 * helpful suggestion into a supply-chain hazard.
 */
export type ProvenanceSource =
  /** A named human confirmed the facts. The only level admissible for `recommended`. */
  | 'maintainer-verified'
  /** Read directly from the canonical repository page on `checkedOn`. */
  | 'primary-fetch'
  /** Came from a secondary or automated summary. Never sufficient on its own. */
  | 'reported-unverified';

/**
 * A dated upstream event — the last commit, or the last release.
 *
 * Stored as a date rather than as prose (`'about a year ago'`) because rule 2 of
 * the inclusion bar is arithmetic, and arithmetic cannot be performed on an
 * adverb. The first draft of this schema held prose here, which meant the
 * staleness rule could only ever be checked by a human re-reading the sentence.
 * That is not a rule, it is a note.
 */
export interface UpstreamActivity {
  /** ISO `YYYY-MM-DD`. When {@link precision} is `'month'` the day is a placeholder. */
  readonly date: string;
  /**
   * How precisely the date is known.
   *
   * `'month'` is not laziness, it is the honest record of a fact that was read
   * as "roughly a year ago". Freshness derived from it is reported as
   * approximate, so nobody ends up quoting a day that was never observed.
   */
  readonly precision: 'day' | 'month';
  /** Release tag as published upstream. `undefined` for commits, and where none exists. */
  readonly tag: string | undefined;
}

/** Who checked the facts, when, and how directly. */
export interface Verification {
  /** ISO date, `YYYY-MM-DD`. */
  readonly checkedOn: string;
  /** A person, or an explicit statement that no person has signed off yet. */
  readonly checkedBy: string;
  /** As shown upstream at `checkedOn`. `undefined` when the project has cut none. */
  readonly upstreamLastRelease: UpstreamActivity | undefined;
  readonly upstreamLastCommit: UpstreamActivity | undefined;
  readonly source: ProvenanceSource;
}

export interface CatalogueEntry {
  /** Stable slug. Never reused, even after removal. */
  readonly id: string;
  readonly name: string;
  /** Canonical https URL. This, not the name, is the identity of the entry. */
  readonly repository: string;
  /** One sentence, plain language, no marketing. */
  readonly summary: string;
  readonly licence: SpdxLicence;
  readonly mechanisms: readonly FixMechanism[];
  readonly surfaces: readonly IntegrationSurface[];
  /**
   * Classes this entry may be offered against. Must be `residual-tool-fixable`,
   * and must be empty for a `deprecated` entry. Enforced by the catalogue test.
   */
  readonly addresses: readonly WasteClass[];
  /**
   * What a refused entry *would* have addressed had it passed the bar.
   *
   * This is what makes "refuse by name" possible. Without it a deprecated entry
   * is an orphan record with no consumer: the engine could not say *"the obvious
   * candidate here is RouteLLM, and here is why it is not being offered"*, which
   * is one of the more useful sentences a recommendation engine can produce.
   */
  readonly wouldAddress: readonly WasteClass[];
  readonly install: InstallProfile;
  /**
   * Whether using it means downloading and running an ML model locally.
   *
   * A schema field rather than a footnote, because it changes the ask
   * materially: a model download, inference cost, and a second thing reading
   * the developer's prompts. It must not be quietly omitted.
   */
  readonly requiresLocalModel: boolean;
  readonly status: EntryStatus;
  /** Required whenever `status !== 'recommended'`. Enforced by the catalogue test. */
  readonly statusReason: string | undefined;
  readonly evidence: EvidenceLevel;
  readonly verification: Verification;
}

/**
 * Fields deliberately absent from {@link CatalogueEntry}, recorded here so the
 * omissions read as decisions rather than oversights:
 *
 * - **No score or ranking weight.** Ordering is derived at match time from
 *   status, evidence, install complexity and residual fit. A stored score is a
 *   number nobody can re-derive six months later.
 * - **No star count.** It decays daily, it is not causal, and it is precisely
 *   the field automated collection got wrong.
 * - **No popularity or trending signal.** The engine recommends on fit, not
 *   fashion.
 */
export const OMITTED_BY_DESIGN: readonly string[] = [
  'score',
  'rankingWeight',
  'stars',
  'popularity',
  'trending',
];

/** Rule 2 of the inclusion bar, in months. See D11 §6.3. */
export const MAX_MONTHS_SINCE_COMMIT = 6;
export const MAX_MONTHS_SINCE_RELEASE = 12;

/**
 * How long a human's sign-off stays good for.
 *
 * The catalogue is compiled into the binary, and a binary outlives its build. A
 * user installing this release eighteen months from now would otherwise be
 * handed recommendations verified against a world that no longer exists, stated
 * with exactly the confidence they had on the day they were checked. Six months,
 * matching the commit rule, after which an entry stops being offerable until
 * somebody looks again — enforced at match time and not only in CI, because CI
 * does not run on the user's machine.
 */
export const MAX_MONTHS_SINCE_VERIFICATION = 6;

/**
 * The floor below which the feature ships as guidance-only rather than as a
 * catalogue.
 *
 * **Derived, not chosen.** The engine names at most
 * {@link MAX_CANDIDATES_PER_FINDING} tools per finding, and a class served by a
 * single entry has a single point of failure; multiply by the number of classes
 * the taxonomy currently calls tool-fixable and the floor falls out. Deriving it
 * means the number cannot drift away from the reasoning that produced it — if a
 * dormant detector comes online and a third class becomes tool-fixable, the
 * floor rises on its own, with nobody having to remember.
 */
export const MIN_RECOMMENDED_ENTRIES = MAX_CANDIDATES_PER_FINDING * toolFixableClasses().length;

/** Whole months between two dates, floored. The unit every staleness rule is stated in. */
function monthsBetween(from: Date, to: Date): number {
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  return to.getUTCDate() < from.getUTCDate() ? months - 1 : months;
}

function parseIsoDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export interface FreshnessBreach {
  readonly rule: 'commit' | 'release' | 'verification';
  /** `Infinity` when the date is missing or unparseable — an unknown age is not a young one. */
  readonly months: number;
  readonly limit: number;
  /** True when the underlying date was only ever known to the month. */
  readonly approximate: boolean;
  readonly text: string;
}

/**
 * Why an entry may or may not be offered **right now**.
 *
 * Computed against a caller-supplied `asOf` rather than by reading the clock
 * internally. That makes the answer reproducible in tests, and it makes the
 * time-dependence visible at every call site instead of hidden inside a
 * pure-looking function.
 */
export interface Admissibility {
  readonly offerable: boolean;
  /** Empty when `offerable`. Otherwise every reason, so the CLI can print all of them. */
  readonly blockers: readonly string[];
  readonly breaches: readonly FreshnessBreach[];
}

function breachFor(
  rule: FreshnessBreach['rule'],
  activity: UpstreamActivity | undefined,
  limit: number,
  asOf: Date,
  missingText: string,
): FreshnessBreach | undefined {
  if (activity === undefined) {
    return { rule, months: Number.POSITIVE_INFINITY, limit, approximate: false, text: missingText };
  }

  const date = parseIsoDate(activity.date);
  if (date === undefined) {
    return {
      rule,
      months: Number.POSITIVE_INFINITY,
      limit,
      approximate: false,
      text: `the recorded ${rule} date "${activity.date}" is not an ISO date`,
    };
  }

  const months = monthsBetween(date, asOf);
  if (months <= limit) return undefined;

  return {
    rule,
    months,
    limit,
    approximate: activity.precision === 'month',
    text:
      `last ${rule} was ${activity.precision === 'month' ? 'approximately ' : ''}` +
      `${String(months)} months before this run, over the ${String(limit)}-month limit`,
  };
}

/**
 * Applies the parts of the inclusion bar that depend on the date this code
 * *runs*, rather than the date it was written.
 *
 * Rules 1, 3, 4, 5 and 6 are structural: they cannot change after the build, so
 * they are enforced once, in the catalogue test, where a breach fails CI. Rules
 * 2 and 7 are temporal — a repository current at build time may be abandoned by
 * the time a user runs the binary, and a sign-off ages — so they are re-applied
 * here, on every run.
 */
export function entryAdmissibility(entry: CatalogueEntry, asOf: Date): Admissibility {
  const blockers: string[] = [];
  const breaches: FreshnessBreach[] = [];

  if (entry.status === 'deprecated') {
    blockers.push(entry.statusReason ?? 'the entry is recorded as deprecated');
  }

  if (entry.verification.source !== 'maintainer-verified') {
    blockers.push(
      'no named human has signed the facts off — identity fields are security-relevant, and ' +
        'automated collection is not admissible as a source of truth for them',
    );
  }

  const candidates = [
    breachFor(
      'verification',
      { date: entry.verification.checkedOn, precision: 'day', tag: undefined },
      MAX_MONTHS_SINCE_VERIFICATION,
      asOf,
      'the entry records no verification date',
    ),
    breachFor(
      'commit',
      entry.verification.upstreamLastCommit,
      MAX_MONTHS_SINCE_COMMIT,
      asOf,
      'no upstream commit date is recorded',
    ),
    breachFor(
      'release',
      entry.verification.upstreamLastRelease,
      MAX_MONTHS_SINCE_RELEASE,
      asOf,
      'upstream has never published a release',
    ),
  ];

  for (const breach of candidates) {
    if (breach === undefined) continue;
    breaches.push(breach);
    blockers.push(breach.text);
  }

  return { offerable: blockers.length === 0, blockers, breaches };
}

export interface CatalogueReadiness {
  readonly recommended: number;
  readonly awaitingSignOff: number;
  readonly deprecated: number;
  /** Entries marked `recommended` that a temporal rule has since put out of date. */
  readonly staleRecommended: number;
  /** False while the catalogue is below {@link MIN_RECOMMENDED_ENTRIES}. */
  readonly meetsFloor: boolean;
  /**
   * What the CLI should do right now: offer entries, or fall back to
   * behavioural guidance with no tool names at all.
   */
  readonly mode: 'catalogue' | 'guidance-only';
  readonly reason: string;
}

/**
 * Whether the catalogue is fit to be offered, computed rather than asserted.
 *
 * Deliberately not a failing test. A test that fails until somebody signs off
 * would block the build on a curation task; this reports the state instead, and
 * the CLI degrades to guidance-only on its own.
 *
 * The count is of entries offerable **on `asOf`**, not of entries marked
 * `recommended` at authoring time. An entry whose sign-off has aged out stops
 * counting towards the floor, which is the entire point of having one.
 */
export function catalogueReadiness(
  entries: readonly CatalogueEntry[],
  asOf: Date,
): CatalogueReadiness {
  const marked = entries.filter((entry) => entry.status === 'recommended');
  const recommended = marked.filter((entry) => entryAdmissibility(entry, asOf).offerable).length;
  const staleRecommended = marked.length - recommended;

  const awaitingSignOff = entries.filter(
    (entry) => entry.status !== 'deprecated' && entry.verification.source !== 'maintainer-verified',
  ).length;
  const deprecated = entries.filter((entry) => entry.status === 'deprecated').length;
  const meetsFloor = recommended >= MIN_RECOMMENDED_ENTRIES;

  const staleNote =
    staleRecommended > 0
      ? ` ${String(staleRecommended)} entr${staleRecommended === 1 ? 'y' : 'ies'} marked ` +
        'recommended no longer pass the freshness rules and were not counted.'
      : '';

  return {
    recommended,
    awaitingSignOff,
    deprecated,
    staleRecommended,
    meetsFloor,
    mode: meetsFloor ? 'catalogue' : 'guidance-only',
    reason: meetsFloor
      ? `${String(recommended)} entries are maintainer-verified and current.${staleNote}`
      : `Only ${String(recommended)} of the required ${String(MIN_RECOMMENDED_ENTRIES)} ` +
        `entries are maintainer-verified and current; ${String(awaitingSignOff)} await sign-off. ` +
        `Advice degrades to behavioural guidance with no tool named.${staleNote}`,
  };
}

/**
 * A stable digest of the catalogue's decision-bearing content.
 *
 * Two jobs. It makes `advise --json` self-identifying, so an output can be tied
 * to the exact dataset that produced it rather than to a version number that
 * moves for unrelated reasons. And it is the field R2's pre-registration will
 * commit to — for the same reason D8 hashes its registration, since a
 * recommendation evaluated against a catalogue that quietly changed underneath
 * it has not been evaluated at all.
 *
 * Prose fields are excluded on purpose: rewording a `summary` must not
 * invalidate an in-flight evaluation, whereas changing an install command, a
 * status or a repository URL must.
 */
export function catalogueDigest(entries: readonly CatalogueEntry[]): string {
  const canonical = [...entries]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) =>
      [
        entry.id,
        entry.repository,
        entry.licence,
        [...entry.mechanisms].sort().join('+'),
        [...entry.surfaces].sort().join('+'),
        [...entry.addresses].sort().join('+'),
        entry.install.command,
        entry.status,
        entry.evidence,
        entry.verification.checkedOn,
        entry.verification.source,
      ].join('\u0000'),
    )
    .join('\n');

  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
