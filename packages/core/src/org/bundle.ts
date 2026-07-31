import type Database from 'better-sqlite3';
import { buildLedger, type LedgerSummary } from '../ledger/ledger.js';
import { buildWasteReport } from '../waste/report.js';
import { assertReportSafe } from '../privacy/guard.js';
import { MIN_GROUP_SIZE, type PrivacyContext } from '../privacy/scope.js';
import { hashIdentifier } from '../privacy/identifiers.js';
import { getAllRequests, getAllToolCalls } from '../store/database.js';
import { serverOf } from '../waste/report.js';
import { VERSION } from '../version.js';

/**
 * **D9.2 — `tokenlens sync`: what leaves the machine, stated exhaustively.**
 *
 * ## The problem this has to solve socially, not technically
 *
 * Every phase before this one runs entirely on one developer's laptop, so
 * the privacy guarantee is trivially true: nothing leaves, because there is
 * no outward path. D9 introduces one, and the moment that exists, S1 stops
 * being a property of the architecture and becomes a claim somebody has to
 * verify.
 *
 * So the bundle is designed to be **audited in one sitting**. It carries an
 * explicit `manifest` naming every field it contains and why, and the same
 * `assertReportSafe` gate that guards every other report runs over it
 * before it is written. A reviewer reads the manifest, spot-checks the
 * payload against it, and is done — instead of reading the whole codebase
 * and taking the rest on trust.
 *
 * ## What is deliberately absent
 *
 * No prompts, no completions, no file paths, no file contents, no tool
 * arguments, no session identifiers, no repository names. Not "redacted" —
 * absent. A redacted field is a field that was collected, and the shape of
 * the redaction usually leaks something.
 *
 * The one apparent exception is the MCP server name, which is a vendor
 * identifier rather than anything about the developer, and which the whole
 * tool-surface analysis is useless without.
 */
export const BUNDLE_VERSION = 1;

export interface BundleManifestEntry {
  readonly field: string;
  readonly why: string;
}

export interface ModelAggregate {
  readonly model: string;
  readonly credits: number;
  readonly requests: number;
}

export interface ToolSurfaceAggregate {
  readonly server: string;
  readonly toolCount: number;
  readonly invocations: number;
}

export interface WasteAggregate {
  readonly class: string;
  readonly credits: number;
  readonly confidence: number;
}

export interface OrgBundle {
  readonly bundleVersion: number;
  readonly producedBy: string;
  /** Hashed install identity. Stable across syncs, meaningless off this machine. */
  readonly installId: string;
  readonly team: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly developers: number;
  readonly totalCredits: number;
  readonly measuredCredits: number;
  readonly modelledCredits: number;
  readonly requestCount: number;
  readonly byModel: readonly ModelAggregate[];
  readonly byCostCentre: readonly { readonly label: string; readonly credits: number }[];
  readonly byWasteClass: readonly WasteAggregate[];
  readonly toolSurface: readonly ToolSurfaceAggregate[];
  /** Daily totals only — no session, no request, no path. */
  readonly daily: readonly {
    readonly day: string;
    readonly credits: number;
    readonly requests: number;
  }[];
  readonly manifest: readonly BundleManifestEntry[];
}

/**
 * One entry per field, named exactly as the field is named.
 *
 * The first version of this grouped fields (`totalCredits / measured /
 * modelled`) for readability, and `auditBundle` immediately caught that
 * two of the three names did not exist and that `requestCount` was
 * undeclared entirely. That is the mechanism working: a manifest written
 * for a human to skim had already drifted from the payload before the
 * payload had ever been sent.
 */
export const BUNDLE_MANIFEST: readonly BundleManifestEntry[] = [
  {
    field: 'installId',
    why: 'Salted hash of the install path. De-duplicates repeat syncs; reverses to nothing.',
  },
  {
    field: 'team',
    why: 'Supplied by the operator, not detected. Enables the team rollup and nothing else.',
  },
  { field: 'periodFrom', why: 'Start of the aggregation window.' },
  { field: 'periodTo', why: 'End of the aggregation window.' },
  {
    field: 'developers',
    why: 'Headcount behind the figures, so k-anonymity can be enforced at the far end.',
  },
  { field: 'totalCredits', why: 'The spend for the window.' },
  { field: 'measuredCredits', why: 'How much of the spend came from a recorded credit figure.' },
  {
    field: 'modelledCredits',
    why: 'How much came from a rate-card estimate, so the two are never silently summed.',
  },
  { field: 'requestCount', why: 'Number of requests behind the credits.' },
  {
    field: 'byModel',
    why: 'Credits and request counts per model id. Model ids are vendor identifiers.',
  },
  {
    field: 'byCostCentre',
    why: 'Where the tokens went: tool definitions, history, retrieved content. Labels only.',
  },
  {
    field: 'byWasteClass',
    why: 'Attributed credits per waste class. Class ids only — no evidence, no offenders.',
  },
  {
    field: 'toolSurface',
    why: 'MCP server names with tool and invocation counts. Vendor identifiers, needed for the tool-surface tax.',
  },
  {
    field: 'daily',
    why: 'Daily credit and request totals. The coarsest series that still supports anomaly detection.',
  },
];

export interface BuildBundleOptions {
  readonly team: string;
  readonly developers?: number;
  readonly cwd?: string;
  readonly salt: string;
  readonly now?: Date;
}

export function buildBundle(db: Database.Database, options: BuildBundleOptions): OrgBundle {
  const ledger: LedgerSummary = buildLedger(db);
  const requests = getAllRequests(db);
  const developers = options.developers ?? 1;

  // The bundle is a shared-scope artefact by construction, so the guard
  // runs with shared scope and will refuse anything that names an
  // individual — including anything a future contributor adds to this
  // function without thinking about it.
  const privacy: PrivacyContext = { scope: 'shared', subjectCount: developers };
  const waste = buildWasteReport(db, privacy);

  const first = requests[0]?.ts;
  const last = requests[requests.length - 1]?.ts;

  const bundle: OrgBundle = {
    bundleVersion: BUNDLE_VERSION,
    producedBy: `tokenlens ${VERSION}`,
    installId: hashIdentifier(options.cwd ?? process.cwd(), options.salt),
    team: options.team,
    periodFrom: iso(first),
    periodTo: iso(last ?? options.now?.getTime()),
    developers,
    totalCredits: ledger.totalCredits,
    measuredCredits: ledger.measuredCredits,
    modelledCredits: ledger.modelledCredits,
    requestCount: ledger.requestCount,
    byModel: ledger.byModel.map((model) => ({
      model: model.model,
      credits: model.credits,
      requests: model.requestCount,
    })),
    byCostCentre: ledger.byCostCentre.map((centre) => ({
      label: centre.label,
      credits: centre.credits,
    })),
    byWasteClass: waste.findings.map((finding) => ({
      class: finding.class,
      credits: finding.credits.value,
      confidence: finding.confidence,
    })),
    toolSurface: toolSurface(db),
    daily: ledger.byDay.map((day) => ({
      day: day.day,
      credits: day.credits,
      requests: day.requestCount,
    })),
    manifest: BUNDLE_MANIFEST,
  };

  assertReportSafe(bundle, privacy);
  return bundle;
}

function iso(ts: number | undefined): string {
  return ts === undefined ? '' : new Date(ts).toISOString().slice(0, 10);
}

function toolSurface(db: Database.Database): ToolSurfaceAggregate[] {
  const byServer = new Map<string, { tools: Set<string>; invocations: number }>();
  for (const call of getAllToolCalls(db)) {
    const server = serverOf(call.name);
    const entry = byServer.get(server) ?? { tools: new Set<string>(), invocations: 0 };
    entry.tools.add(call.name);
    entry.invocations += 1;
    byServer.set(server, entry);
  }

  return [...byServer.entries()]
    .map(([server, entry]) => ({
      server,
      toolCount: entry.tools.size,
      invocations: entry.invocations,
    }))
    .sort((a, b) => b.invocations - a.invocations);
}

export interface BundleAudit {
  readonly safe: boolean;
  readonly undeclaredFields: readonly string[];
  readonly detail: string;
}

/**
 * Checks the payload against its own manifest.
 *
 * The manifest is only worth anything if it is enforced. Without this, a
 * field added in six months would ship silently and the manifest would
 * become a historical document that a security review would nonetheless
 * still be reading.
 */
export function auditBundle(bundle: OrgBundle): BundleAudit {
  const declared = new Set(BUNDLE_MANIFEST.map((entry) => entry.field));
  const structural = new Set(['bundleVersion', 'producedBy', 'manifest']);

  const undeclared = Object.keys(bundle).filter(
    (key) => !declared.has(key) && !structural.has(key),
  );

  return {
    safe: undeclared.length === 0,
    undeclaredFields: undeclared,
    detail:
      undeclared.length === 0
        ? `Every field in the bundle is declared in its manifest (${String(BUNDLE_MANIFEST.length)} entries).`
        : `${String(undeclared.length)} field(s) leave this machine without being declared in the manifest: ` +
          `${undeclared.join(', ')}. Add them to BUNDLE_MANIFEST with a reason, or remove them. An undeclared ` +
          'field is one a security review will not have seen.',
  };
}

export const MINIMUM_DEVELOPERS_TO_SHARE = MIN_GROUP_SIZE;
