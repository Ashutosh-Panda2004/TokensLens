import { buildDetectContext } from '../waste/context.js';
import { buildWasteReport } from '../waste/report.js';
import { CATALOGUE } from './catalogue.data.js';
import { catalogueDigest, catalogueReadiness, entryAdmissibility } from './catalogue.js';
import { measureResiduals } from './residual.js';
import { matchAdvice } from './match.js';
import type Database from 'better-sqlite3';
import type { CatalogueEntry, CatalogueReadiness } from './catalogue.js';
import type { AdviceMatch } from './match.js';
import type { ResidualSignal } from './residual.js';
import type { DetectContextInputs } from '../waste/context.js';
import type { PrivacyContext } from '../privacy/scope.js';
import type { WasteClass } from '../waste/types.js';

/**
 * D11 — assembling one `tokenlens advise` answer.
 *
 * Read-only end to end. Nothing here writes a row, opens a socket, or inspects
 * the machine for installed software: the input is the ledger D3 already reads,
 * and the output is a value. The worst thing this report can do is say *"nothing
 * to recommend"*, which is a correct answer rather than a defect.
 *
 * See D11-PRESCRIPTIVE-ADVICE.md §7, R1.
 */

/** `tokenlens advise` inspects the caller's own machine — self scope. */
const SELF: PrivacyContext = { scope: 'self', subjectCount: 1 };

export interface CatalogueListing {
  readonly entry: CatalogueEntry;
  /** Whether this entry could be offered on `asOf`, and if not, why not. */
  readonly offerable: boolean;
  readonly blockers: readonly string[];
}

export interface AdviceReport {
  /** ISO instant the rules were applied at. Recorded because the answer depends on it. */
  readonly asOf: string;
  /** Identifies the exact dataset behind this answer. See `catalogueDigest`. */
  readonly catalogueDigest: string;
  readonly readiness: CatalogueReadiness;
  /** Classes the ledger produced a finding for, in the order the waste report ranked them. */
  readonly classesWithFindings: readonly WasteClass[];
  readonly signals: readonly ResidualSignal[];
  readonly match: AdviceMatch;
  /** Every entry with its current admissibility — what `--catalogue` prints. */
  readonly catalogue: readonly CatalogueListing[];
  readonly privacy: PrivacyContext;
}

export interface BuildAdviceOptions {
  /** Injected so tests are deterministic and so time-dependence is visible at the call site. */
  readonly asOf?: Date;
  readonly privacy?: PrivacyContext;
  /** Overridable only for tests; production always uses the compiled-in dataset. */
  readonly catalogue?: readonly CatalogueEntry[];
  /**
   * Commit history and organisation rollup, when the caller has them. Advice is
   * gated on findings, so without these W7 and W8 simply produce no finding and
   * therefore no advice — the same degradation the waste report makes.
   */
  readonly inputs?: DetectContextInputs;
}

export function buildAdviceReport(
  db: Database.Database,
  options: BuildAdviceOptions = {},
): AdviceReport {
  const asOf = options.asOf ?? new Date();
  const privacy = options.privacy ?? SELF;
  const catalogue = options.catalogue ?? CATALOGUE;
  const inputs = options.inputs ?? {};

  const waste = buildWasteReport(db, privacy, inputs);
  const signals = measureResiduals(buildDetectContext(db, inputs));
  const readiness = catalogueReadiness(catalogue, asOf);

  const match = matchAdvice({
    findings: waste.findings,
    signals,
    catalogue,
    mode: readiness.mode,
    asOf,
  });

  return {
    asOf: asOf.toISOString(),
    catalogueDigest: catalogueDigest(catalogue),
    readiness,
    classesWithFindings: waste.findings.map((finding) => finding.class),
    signals,
    match,
    catalogue: catalogue.map((entry) => {
      const admissibility = entryAdmissibility(entry, asOf);
      return {
        entry,
        offerable: admissibility.offerable,
        blockers: admissibility.blockers,
      };
    }),
    privacy,
  };
}
