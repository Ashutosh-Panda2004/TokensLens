import { entryAdmissibility } from './catalogue.js';
import { MAX_CANDIDATES_PER_FINDING, taxonomyFor } from './taxonomy.js';
import { MECHANISM_GUIDANCE, behaviourGuidanceFor, mechanismsFor } from './guidance.js';
import { describeSignal } from './residual.js';
import type { Admissibility, CatalogueEntry } from './catalogue.js';
import type { FixMechanism } from './taxonomy.js';
import type { ResidualSignal } from './residual.js';
import type { BehaviourGuidance } from './guidance.js';
import type { WasteClass, WasteFinding } from '../waste/types.js';

/**
 * D11 — residual-gated matching.
 *
 * ## The one rule this file exists to enforce
 *
 * > A tool is only ever recommended for waste that remains after TokenLens's own
 * > lever is applied.
 *
 * Everything here is a consequence of that. A finding is not sufficient: the
 * class must be tool-fixable, its residual probe must clear its threshold on a
 * sufficient sample, the catalogue must be over its floor, and an entry must
 * still be admissible on the day the code runs. Any one of those failing
 * produces a **named silence** rather than nothing, because "we looked and there
 * is nothing to offer" and "we did not look" must not render identically.
 *
 * ## What is deliberately absent
 *
 * No score. Ordering is a documented lexicographic tuple recomputed at match
 * time, so any placement can be re-derived from the entry six months later. A
 * stored weight is a number nobody can defend once the person who chose it has
 * moved on.
 *
 * See D11-PRESCRIPTIVE-ADVICE.md §1.2 and §3.1.
 */

export type SilenceCode =
  /** TokenLens's own tier-A/B lever fully addresses the class. */
  | 'self-fixed'
  /** The fix is a habit; guidance is emitted instead. */
  | 'behaviour-fixable'
  /** No detector exists for the class yet. */
  | 'dormant'
  /** The class is tool-fixable but this corpus produced no finding for it. */
  | 'no-finding'
  /** The probe ran but the sample was too thin to judge. */
  | 'insufficient-sample'
  /** The probe ran on a good sample and found the lever had already reached it. */
  | 'residual-below-threshold'
  /** The catalogue is under its floor, so no tool is named for anything. */
  | 'guidance-only'
  /** A residual exists, but nothing in the catalogue is admissible against it today. */
  | 'no-admissible-entry';

export interface AdviceSilence {
  readonly class: WasteClass;
  readonly code: SilenceCode;
  /** Plain language, aimed at a reader who is entitled to ask why they got nothing. */
  readonly reason: string;
  /** Present when a probe ran, so the reader can see the number that decided it. */
  readonly signal: ResidualSignal | undefined;
}

export interface AdviceOffer {
  readonly class: WasteClass;
  readonly entry: CatalogueEntry;
  /** 1-based, within the class. Never exceeds {@link MAX_CANDIDATES_PER_FINDING}. */
  readonly rank: number;
  /** The residual that justified the offer. An offer without one is a bug. */
  readonly signal: ResidualSignal;
  /** Why this entry, and why in this position. Derived, never stored. */
  readonly why: readonly string[];
  /** Everything the reader should weigh before installing. Never omitted, never softened. */
  readonly caveats: readonly string[];
}

/**
 * A tool the engine has considered and will not offer, kept so the refusal can
 * be made by name.
 *
 * A recommendation engine that stays quiet about the obvious candidate looks
 * either ignorant of it or evasive about it. Saying *"RouteLLM is the obvious
 * answer here and it is not being offered, for these reasons"* is the more
 * useful output and the more defensible one.
 */
export interface AdviceRefusal {
  readonly class: WasteClass;
  readonly entry: CatalogueEntry;
  readonly reason: string;
}

export interface MechanismSuggestion {
  readonly class: WasteClass;
  readonly mechanism: FixMechanism;
  readonly headline: string;
  readonly whatItDoes: string;
  readonly howYouWouldKnow: string;
}

export interface AdviceMatch {
  readonly offers: readonly AdviceOffer[];
  readonly silences: readonly AdviceSilence[];
  readonly refusals: readonly AdviceRefusal[];
  readonly behaviour: readonly BehaviourGuidance[];
  readonly mechanisms: readonly MechanismSuggestion[];
}

export interface MatchInput {
  readonly findings: readonly WasteFinding[];
  readonly signals: readonly ResidualSignal[];
  readonly catalogue: readonly CatalogueEntry[];
  readonly mode: 'catalogue' | 'guidance-only';
  /** The date the rules are applied against. Injected so the result is reproducible. */
  readonly asOf: Date;
}

/**
 * Every class, in order, so the walk below cannot quietly omit one. Ordering the
 * output by class rather than by severity keeps two runs comparable line for
 * line, which is what makes a diff between them readable.
 */
const ALL_CLASSES: readonly WasteClass[] = [
  'W1',
  'W2',
  'W3',
  'W4',
  'W5',
  'W6',
  'W7',
  'W8',
  'W9',
  'W10',
  'W11',
  'W12',
  'W13',
  'W14',
];

// ---------------------------------------------------------------------------
// Ordering — derived, documented, total, and stable
// ---------------------------------------------------------------------------

const STATUS_ORDER: Readonly<Record<CatalogueEntry['status'], number>> = {
  recommended: 0,
  caution: 1,
  deprecated: 2,
};

const EVIDENCE_ORDER: Readonly<Record<CatalogueEntry['evidence'], number>> = {
  'measured-local': 0,
  mechanism: 1,
  'upstream-claim': 2,
};

const COMPLEXITY_ORDER: Readonly<Record<CatalogueEntry['install']['complexity'], number>> = {
  'one-line': 0,
  'config-edit': 1,
  'multi-step': 2,
};

/** How many of the residual's mechanisms this entry actually implements. */
function mechanismFit(entry: CatalogueEntry, wanted: readonly FixMechanism[]): number {
  const implemented = new Set(entry.mechanisms);
  return wanted.filter((mechanism) => implemented.has(mechanism)).length;
}

/**
 * The ordering key, in priority order and with the reasoning attached to each
 * component:
 *
 * 1. **status** — a caveated entry never outranks an uncaveated one.
 * 2. **evidence** — something measured beats something merely claimed upstream.
 * 3. **mechanism fit**, descending — an entry covering both of the residual's
 *    mechanisms is a better answer than one covering half of it.
 * 4. **install complexity** — between two comparable answers, prefer the one
 *    that costs a line. Effort is a real cost and it is paid by the reader.
 * 5. **requiresLocalModel** — downloading and running a model over your own
 *    prompts is a materially larger ask, so it loses every tie up to here.
 * 6. **id** — a stable, meaningless tie-break, so identical inputs always
 *    produce identical output. Determinism is what makes the output quotable.
 */
function orderingKey(entry: CatalogueEntry, wanted: readonly FixMechanism[]): readonly number[] {
  return [
    STATUS_ORDER[entry.status],
    EVIDENCE_ORDER[entry.evidence],
    -mechanismFit(entry, wanted),
    COMPLEXITY_ORDER[entry.install.complexity],
    entry.requiresLocalModel ? 1 : 0,
  ];
}

function compareEntries(
  a: CatalogueEntry,
  b: CatalogueEntry,
  wanted: readonly FixMechanism[],
): number {
  const left = orderingKey(a, wanted);
  const right = orderingKey(b, wanted);
  for (let i = 0; i < left.length; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.id.localeCompare(b.id);
}

function explainPlacement(entry: CatalogueEntry, wanted: readonly FixMechanism[]): string[] {
  const fit = mechanismFit(entry, wanted);
  const why = [
    `addresses the residual by ${entry.mechanisms.join(' and ')}` +
      (fit === wanted.length && wanted.length > 1
        ? ' — every mechanism this residual calls for'
        : ''),
    `reaches the agent as ${entry.surfaces.join(' or ')}, which changes no data flow`,
    `${entry.licence}, and installed with \`${entry.install.command}\``,
  ];

  if (entry.evidence === 'measured-local') {
    why.push('the effect was measured against a TokenLens corpus, not taken from a claim');
  } else if (entry.evidence === 'upstream-claim') {
    why.push(
      'the reduction is the project\u2019s own claim and has not been reproduced here, so no ' +
        'figure is quoted for it',
    );
  } else {
    why.push('the mechanism plainly reduces tokens; the size of the reduction is unmeasured');
  }

  return why;
}

function caveatsFor(entry: CatalogueEntry, admissibility: Admissibility): string[] {
  const caveats: string[] = [];

  if (entry.status === 'caution' && entry.statusReason !== undefined) {
    caveats.push(entry.statusReason);
  }
  if (entry.requiresLocalModel) {
    caveats.push(
      'requires downloading and running a model locally — an inference cost, and a second ' +
        'thing reading your prompts',
    );
  }
  if (entry.install.complexity === 'multi-step') {
    caveats.push('installation is more than one step; budget time for it');
  }
  if (!entry.install.reversible) {
    caveats.push('not reversible by deleting one thing');
  }
  for (const breach of admissibility.breaches) {
    caveats.push(breach.text);
  }

  return caveats;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function silence(
  wasteClass: WasteClass,
  code: SilenceCode,
  reason: string,
  signal?: ResidualSignal,
): AdviceSilence {
  return { class: wasteClass, code, reason, signal };
}

/**
 * Refusals relevant to a class, drawn from `wouldAddress` rather than from
 * `addresses` — a refused entry addresses nothing by definition, so the record
 * of what it *would* have covered is the only thing that can connect it back to
 * a finding.
 */
function refusalsFor(
  wasteClass: WasteClass,
  catalogue: readonly CatalogueEntry[],
): AdviceRefusal[] {
  return catalogue
    .filter((entry) => entry.status === 'deprecated' && entry.wouldAddress.includes(wasteClass))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => ({
      class: wasteClass,
      entry,
      reason:
        entry.statusReason ??
        'recorded as deprecated with no reason given, which is itself a defect',
    }));
}

/**
 * Runs the gate for every waste class and returns what may be said about each.
 *
 * Every one of the fourteen classes is accounted for in exactly one of
 * `offers`, `silences` or `behaviour`. Nothing is skipped: a class absent from
 * the output would be indistinguishable from a class the engine forgot.
 */
export function matchAdvice(input: MatchInput): AdviceMatch {
  const findingClasses = new Set(input.findings.map((finding) => finding.class));
  const signalByClass = new Map(input.signals.map((signal) => [signal.class, signal]));

  const offers: AdviceOffer[] = [];
  const silences: AdviceSilence[] = [];
  const refusals: AdviceRefusal[] = [];
  const behaviour: BehaviourGuidance[] = [];
  const mechanisms: MechanismSuggestion[] = [];

  for (const wasteClass of ALL_CLASSES) {
    const taxonomy = taxonomyFor(wasteClass);

    if (taxonomy.nature === 'self-fixed') {
      silences.push(silence(wasteClass, 'self-fixed', taxonomy.rationale));
      refusals.push(...refusalsFor(wasteClass, input.catalogue));
      continue;
    }

    if (taxonomy.nature === 'behaviour-fixable') {
      const guidance = behaviourGuidanceFor(wasteClass);
      if (guidance !== undefined && findingClasses.has(wasteClass)) behaviour.push(guidance);
      silences.push(silence(wasteClass, 'behaviour-fixable', taxonomy.rationale));
      refusals.push(...refusalsFor(wasteClass, input.catalogue));
      continue;
    }

    if (taxonomy.nature === 'dormant') {
      silences.push(silence(wasteClass, 'dormant', taxonomy.rationale));
      refusals.push(...refusalsFor(wasteClass, input.catalogue));
      continue;
    }

    // --- residual-tool-fixable: the only path that can reach an offer --------

    const residual = taxonomy.residual;
    const signal = signalByClass.get(wasteClass);

    if (residual === undefined || signal === undefined) {
      silences.push(
        silence(
          wasteClass,
          'no-finding',
          'the class is tool-fixable but no residual probe produced a reading for it',
        ),
      );
      continue;
    }

    if (!findingClasses.has(wasteClass)) {
      silences.push(
        silence(
          wasteClass,
          'no-finding',
          'no waste was attributed to this class in the ingested data, so there is no ' +
            'residual to offer anything against',
          signal,
        ),
      );
      continue;
    }

    if (!signal.sufficientSample) {
      silences.push(
        silence(
          wasteClass,
          'insufficient-sample',
          `${signal.label}: ${describeSignal(signal)}. A share computed over a handful of ` +
            'observations is noise wearing a percentage sign, so nothing is offered.',
          signal,
        ),
      );
      continue;
    }

    if (!signal.exceeded) {
      // Two genuinely different silences share this code, and the wording has
      // to distinguish them: a lever reached the waste, or the waste is simply
      // not present at a size worth a dependency.
      const because =
        residual.lever === undefined
          ? 'This class is not present here at a size that would justify adding a dependency.'
          : `TokenLens\u2019s own ${residual.lever} lever already reaches this waste, so a ` +
            'third-party dependency would be paid for twice and would earn nothing.';

      silences.push(
        silence(
          wasteClass,
          'residual-below-threshold',
          `${signal.label}: ${describeSignal(signal)}. ${because}`,
          signal,
        ),
      );
      continue;
    }

    // A genuine residual exists. From here the only question is whether
    // anything may honestly be named against it.
    for (const mechanism of mechanismsFor(wasteClass)) {
      mechanisms.push(mechanismSuggestion(wasteClass, mechanism));
    }
    refusals.push(...refusalsFor(wasteClass, input.catalogue));

    if (input.mode === 'guidance-only') {
      silences.push(
        silence(
          wasteClass,
          'guidance-only',
          'a residual is present, but the catalogue is below its floor of verified entries, so ' +
            'the mechanism is described and no tool is named',
          signal,
        ),
      );
      continue;
    }

    const candidates = input.catalogue
      .filter((entry) => entry.addresses.includes(wasteClass))
      .map((entry) => ({ entry, admissibility: entryAdmissibility(entry, input.asOf) }))
      .filter((candidate) => candidate.admissibility.offerable)
      .sort((a, b) => compareEntries(a.entry, b.entry, residual.mechanisms))
      .slice(0, MAX_CANDIDATES_PER_FINDING);

    if (candidates.length === 0) {
      silences.push(
        silence(
          wasteClass,
          'no-admissible-entry',
          'a residual is present, but no catalogue entry for this class is currently offerable ' +
            '\u2014 each is either unverified, out of date, or recorded as refused',
          signal,
        ),
      );
      continue;
    }

    candidates.forEach((candidate, index) => {
      offers.push({
        class: wasteClass,
        entry: candidate.entry,
        rank: index + 1,
        signal,
        why: explainPlacement(candidate.entry, residual.mechanisms),
        caveats: caveatsFor(candidate.entry, candidate.admissibility),
      });
    });
  }

  return { offers, silences, refusals, behaviour, mechanisms };
}

function mechanismSuggestion(wasteClass: WasteClass, mechanism: FixMechanism): MechanismSuggestion {
  const guidance = MECHANISM_GUIDANCE[mechanism];
  return {
    class: wasteClass,
    mechanism,
    headline: guidance.headline,
    whatItDoes: guidance.whatItDoes,
    howYouWouldKnow: guidance.howYouWouldKnow,
  };
}
