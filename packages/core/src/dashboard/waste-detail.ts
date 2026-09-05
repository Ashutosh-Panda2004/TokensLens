import type Database from 'better-sqlite3';
import {
  behaviourGuidanceFor,
  mechanismsFor,
  MECHANISM_GUIDANCE,
  type BehaviourGuidance,
  type MechanismGuidance,
} from '../advice/guidance.js';
import { taxonomyFor } from '../advice/taxonomy.js';
import { buildAdviceReport } from '../advice/report.js';
import { describeSignal } from '../advice/residual.js';
import type { CatalogueReadiness } from '../advice/catalogue.js';
import { buildWasteReport } from '../waste/report.js';
import type { WasteClass, WasteFinding, UnavailableClass } from '../waste/types.js';
import type { DetectContextInputs } from '../waste/context.js';
import type { PrivacyContext } from '../privacy/scope.js';

/**
 * The "how do I fix this?" payload.
 *
 * Every field here already existed and was already computed — the waste
 * report carried `Remediation`, the taxonomy carried the fix nature, the
 * advice engine carried behaviour guidance, mechanism guidance, the
 * residual probe and a named catalogue entry. None of it ever reached the
 * dashboard, which showed a credit figure and a one-line summary and
 * stopped. This joins them so a reader can act on a finding without
 * leaving the page.
 */
export interface FixGuidanceView {
  readonly fixNature: string;
  readonly whoFixesIt: string;
  /** The habit, where the class is one a person fixes rather than a setting. */
  readonly behaviour?: BehaviourGuidance;
  /** What a third-party tool would have to do, described without naming one. */
  readonly mechanisms: readonly (MechanismGuidance & { id: string })[];
  /** A named, vetted tool — only when the residual gate opened for this class. */
  readonly tools: readonly {
    readonly id: string;
    readonly name: string;
    readonly repository: string;
    readonly summary: string;
    readonly licence: string;
    readonly installCommand: string;
    readonly reversible: boolean;
    readonly status: string;
    /** Never omitted and never softened — what to weigh before installing. */
    readonly caveats: readonly string[];
    readonly why: readonly string[];
    readonly statusReason?: string;
  }[];
  /**
   * Why nothing was named. Present whenever `tools` is empty and the
   * engine made a deliberate choice — an absence with no explanation reads
   * as an oversight, which is the opposite of what it is.
   */
  readonly notOfferedReason?: string;
  /** The measured residual behind that decision, in words. */
  readonly residual?: string;
}

export interface WasteFindingView {
  readonly finding: WasteFinding;
  readonly guidance: FixGuidanceView;
}

export interface WasteBoardView {
  readonly findings: readonly WasteFindingView[];
  readonly unavailable: readonly UnavailableClass[];
  readonly totalLedgerCredits: number;
  readonly attributedCredits: number;
  readonly attributedShare: number;
  readonly overlapWarning?: string;
  readonly catalogueReadiness: CatalogueReadiness;
}

const FIX_NATURE_TEXT: Readonly<Record<string, string>> = {
  'self-fixed': 'TokenLens itself — a managed setting or a runtime guard',
  'residual-tool-fixable': 'TokenLens first; a third-party tool only for what survives',
  'behaviour-fixable': 'you — this one is a habit, not a setting',
  dormant: 'nobody yet — the data to judge it is not recorded',
};

function guidanceFor(
  wasteClass: WasteClass,
  advice: ReturnType<typeof buildAdviceReport>,
): FixGuidanceView {
  const taxonomy = taxonomyFor(wasteClass);
  const behaviour = behaviourGuidanceFor(wasteClass);

  const mechanisms = mechanismsFor(wasteClass).map((id) => ({ id, ...MECHANISM_GUIDANCE[id] }));

  const offers = advice.match.offers.filter((offer) => offer.class === wasteClass);
  const tools = offers.map((offer) => {
    const entry = offer.entry;
    return {
      id: entry.id,
      name: entry.name,
      repository: entry.repository,
      summary: entry.summary,
      licence: entry.licence,
      installCommand: entry.install.command,
      reversible: entry.install.reversible,
      status: entry.status,
      caveats: offer.caveats,
      why: offer.why,
      ...(entry.statusReason !== undefined ? { statusReason: entry.statusReason } : {}),
    };
  });

  const silence = advice.match.silences.find((entry) => entry.class === wasteClass);
  const signal =
    taxonomy.residual === undefined
      ? undefined
      : advice.signals.find((entry) => entry.probe === taxonomy.residual?.probe);

  return {
    fixNature: taxonomy.nature,
    whoFixesIt: FIX_NATURE_TEXT[taxonomy.nature] ?? taxonomy.nature,
    ...(behaviour !== undefined ? { behaviour } : {}),
    mechanisms,
    tools,
    ...(tools.length === 0 && silence !== undefined ? { notOfferedReason: silence.reason } : {}),
    ...(signal !== undefined ? { residual: describeSignal(signal) } : {}),
  };
}

/**
 * Assembles the waste board the dashboard renders.
 *
 * Deliberately builds the advice report too. The two were always meant to
 * be read together — a finding without its remedy is a complaint — and
 * running them separately let the UI show one and silently drop the other.
 */
export function buildWasteBoard(
  db: Database.Database,
  privacy: PrivacyContext,
  inputs: DetectContextInputs = {},
): WasteBoardView {
  const waste = buildWasteReport(db, privacy, inputs);
  const advice = buildAdviceReport(db, { privacy, inputs });

  return {
    findings: waste.findings.map((finding) => ({
      finding,
      guidance: guidanceFor(finding.class, advice),
    })),
    unavailable: waste.unavailable,
    totalLedgerCredits: waste.totalLedgerCredits,
    attributedCredits: waste.attributedCredits,
    attributedShare: waste.attributedShare,
    ...(waste.overlapWarning !== undefined ? { overlapWarning: waste.overlapWarning } : {}),
    catalogueReadiness: advice.readiness,
  };
}
