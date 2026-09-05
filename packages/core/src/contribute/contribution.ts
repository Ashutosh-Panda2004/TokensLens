import type Database from 'better-sqlite3';
import { buildLedger } from '../ledger/ledger.js';
import { buildWasteReport } from '../waste/report.js';
import { assertReportSafe } from '../privacy/guard.js';
import type { PrivacyContext } from '../privacy/scope.js';
import { getAllToolCalls } from '../store/database.js';
import { serverOf } from '../waste/report.js';
import { VERSION } from '../version.js';
import { CONTRIBUTION_VERSION } from './consent.js';
import type { BundleManifestEntry } from '../org/bundle.js';

/**
 * **The monthly anonymous contribution.**
 *
 * Purpose: pooled across many installs, these aggregates say which models,
 * which cost centres and which waste classes actually dominate spend in
 * practice — which is the one question no single install can answer about
 * itself, and the reason for asking anyone to share anything.
 *
 * It reuses `assertReportSafe` and the manifest-audit discipline from
 * `org/bundle.ts` rather than inventing a second privacy mechanism. It is a
 * separate payload because it differs in three ways that matter: it is
 * scoped to one calendar month, it carries no team or headcount, and its id
 * is random rather than a hash of a path.
 *
 * ## What is absent
 *
 * No prompts, completions, file paths, file contents, tool arguments,
 * session ids, repository names, workspace names, user names, or timestamps
 * finer than a day. Absent, not redacted — a redacted field was still
 * collected, and the shape of a redaction usually leaks.
 *
 * Model ids and MCP server names are vendor identifiers, not facts about a
 * person, and the analysis is worthless without them.
 */
export interface MonthlyContribution {
  readonly contributionVersion: number;
  readonly producedBy: string;
  /** Random, generated once at consent. Correlates with nothing off this machine. */
  readonly contributorId: string;
  /** `YYYY-MM`. Day-level detail is deliberately not carried off the machine. */
  readonly period: string;
  readonly totalCredits: number;
  readonly measuredCredits: number;
  readonly modelledCredits: number;
  readonly requestCount: number;
  readonly activeDays: number;
  readonly byModel: readonly {
    readonly model: string;
    readonly credits: number;
    readonly requests: number;
  }[];
  readonly byCostCentre: readonly { readonly label: string; readonly credits: number }[];
  readonly byWasteClass: readonly {
    readonly class: string;
    readonly credits: number;
    readonly confidence: number;
  }[];
  readonly toolSurface: readonly {
    readonly server: string;
    readonly toolCount: number;
    readonly invocations: number;
  }[];
  /**
   * Turn-count buckets rather than sessions. This is what makes the
   * compounding cost of long conversations analysable in aggregate without
   * shipping anything about any individual conversation.
   */
  readonly sessionLengths: readonly {
    readonly bucket: string;
    readonly sessions: number;
    readonly credits: number;
  }[];
  readonly manifest: readonly BundleManifestEntry[];
}

export const CONTRIBUTION_MANIFEST: readonly BundleManifestEntry[] = [
  {
    field: 'contributorId',
    why: 'Random bytes generated once when you agreed. Lets the far end ignore a duplicate submission for the same month; reverses to nothing.',
  },
  { field: 'period', why: 'The calendar month the figures cover, as YYYY-MM.' },
  { field: 'totalCredits', why: 'Credits spent in the month.' },
  {
    field: 'measuredCredits',
    why: 'How much of that came from a recorded credit figure rather than an estimate.',
  },
  {
    field: 'modelledCredits',
    why: 'How much was rate-card estimated, so pooled analysis never sums the two as if equal.',
  },
  { field: 'requestCount', why: 'Number of requests behind the credits.' },
  {
    field: 'activeDays',
    why: 'How many days had any activity. Distinguishes heavy use from sustained use; carries no dates.',
  },
  {
    field: 'byModel',
    why: 'Credits and request counts per model id. Model ids are vendor identifiers, and model mix is the largest single cost lever.',
  },
  {
    field: 'byCostCentre',
    why: 'Where the tokens went: tool definitions, history, retrieved content. Labels only.',
  },
  {
    field: 'byWasteClass',
    why: 'Attributed credits per waste class id. No evidence, no offending requests.',
  },
  {
    field: 'toolSurface',
    why: 'MCP server names with tool and invocation counts. Vendor identifiers, needed to price the tool-definition tax.',
  },
  {
    field: 'sessionLengths',
    why: 'Conversation lengths as buckets with totals. Shows the cost of long chats in aggregate without describing any one of them.',
  },
];

/** Buckets, not turn counts — a raw length is closer to a fingerprint than a statistic. */
const LENGTH_BUCKETS: readonly { readonly bucket: string; readonly upTo: number }[] = [
  { bucket: '1-5', upTo: 5 },
  { bucket: '6-20', upTo: 20 },
  { bucket: '21-50', upTo: 50 },
  { bucket: '51-100', upTo: 100 },
  { bucket: '100+', upTo: Number.POSITIVE_INFINITY },
];

export interface BuildContributionOptions {
  readonly contributorId: string;
  /** `YYYY-MM`. Defaults to the month containing `now`. */
  readonly period?: string;
  readonly now?: Date;
}

function monthOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function monthBounds(period: string): { readonly from: string; readonly to: string } {
  const [year, month] = period.split('-').map(Number);
  const start = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1));
  const end = new Date(Date.UTC(year ?? 1970, month ?? 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export function buildContribution(
  db: Database.Database,
  options: BuildContributionOptions,
): MonthlyContribution {
  const period = options.period ?? monthOf(options.now ?? new Date());
  const { from, to } = monthBounds(period);
  const ledger = buildLedger(db, { from, to });

  // Shared scope with a single subject: nobody can be singled out of a
  // report that is entirely about its own author, but every field is still
  // checked against the forbidden-key and path rules.
  const privacy: PrivacyContext = { scope: 'shared', subjectCount: 1 };
  const waste = buildWasteReport(db, privacy);

  const contribution: MonthlyContribution = {
    contributionVersion: CONTRIBUTION_VERSION,
    producedBy: `tokenlens ${VERSION}`,
    contributorId: options.contributorId,
    period,
    totalCredits: ledger.totalCredits,
    measuredCredits: ledger.measuredCredits,
    modelledCredits: ledger.modelledCredits,
    requestCount: ledger.requestCount,
    activeDays: ledger.byDay.length,
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
    sessionLengths: sessionLengths(ledger.bySession),
    manifest: CONTRIBUTION_MANIFEST,
  };

  assertReportSafe(contribution, privacy);
  return contribution;
}

function sessionLengths(
  sessions: readonly { readonly requestCount: number; readonly credits: number }[],
): MonthlyContribution['sessionLengths'] {
  const totals = new Map<string, { sessions: number; credits: number }>();
  for (const session of sessions) {
    const bucket =
      LENGTH_BUCKETS.find((candidate) => session.requestCount <= candidate.upTo)?.bucket ?? '100+';
    const entry = totals.get(bucket) ?? { sessions: 0, credits: 0 };
    entry.sessions += 1;
    entry.credits += session.credits;
    totals.set(bucket, entry);
  }

  return LENGTH_BUCKETS.filter((bucket) => totals.has(bucket.bucket)).map((bucket) => ({
    bucket: bucket.bucket,
    sessions: totals.get(bucket.bucket)?.sessions ?? 0,
    credits: totals.get(bucket.bucket)?.credits ?? 0,
  }));
}

function toolSurface(db: Database.Database): MonthlyContribution['toolSurface'] {
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

export interface ContributionAudit {
  readonly safe: boolean;
  readonly undeclaredFields: readonly string[];
  readonly detail: string;
}

/**
 * Checks the payload against its own manifest, so a field added later
 * cannot ship without a reviewer having read a reason for it.
 */
export function auditContribution(contribution: MonthlyContribution): ContributionAudit {
  const declared = new Set(CONTRIBUTION_MANIFEST.map((entry) => entry.field));
  const structural = new Set(['contributionVersion', 'producedBy', 'manifest']);
  const undeclared = Object.keys(contribution).filter(
    (key) => !declared.has(key) && !structural.has(key),
  );

  return {
    safe: undeclared.length === 0,
    undeclaredFields: undeclared,
    detail:
      undeclared.length === 0
        ? `Every field is declared in the manifest (${String(CONTRIBUTION_MANIFEST.length)} entries).`
        : `${String(undeclared.length)} field(s) would leave this machine undeclared: ${undeclared.join(', ')}. ` +
          'Add them to CONTRIBUTION_MANIFEST with a reason, or remove them.',
  };
}
