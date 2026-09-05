import type Database from 'better-sqlite3';
import { buildLedger, type LedgerSummary } from '../ledger/ledger.js';
import {
  creditsToUsd,
  forecastBudget,
  isPooledPlan,
  type Allowance,
  type BudgetForecast,
} from '../ledger/budget.js';
import { buildSubstitutionAdvice, type SubstitutionAdvice } from '../ledger/substitution.js';
import { longestSessionId, projectNextTurnCost } from '../ledger/next-turn.js';
import { buildWasteReport, serverOf, type WasteReport } from '../waste/report.js';
import { assertReportSafe, mayIncludeEntityList } from '../privacy/guard.js';
import type { PrivacyContext } from '../privacy/scope.js';
import type { ScopeSelection } from '../scope/types.js';
import { getAllToolCalls } from '../store/database.js';
import { VERSION } from '../version.js';
import { ANALYSIS_BRIEF } from './brief.js';

/**
 * **A month of spend, written to be read by a person and analysed by an
 * assistant.**
 *
 * The dashboard answers questions somebody already knows to ask. This is for
 * the opposite case: hand the whole month to a capable model and let it find
 * what nobody thought to look for. So the document carries the *decomposition*
 * — where the tokens went, how conversations grew, what the detectors already
 * found — rather than a headline, because a headline gives an analyst nothing
 * to work with.
 *
 * ## Why Markdown
 *
 * It is the one format that is simultaneously readable by a human, pasteable
 * into any assistant, and unambiguous about structure. JSON is worse to read;
 * HTML is worse to paste.
 *
 * ## Privacy
 *
 * This file is *designed to be sent somewhere else*, which makes it the most
 * dangerous artefact the tool produces. It therefore defaults to `shared`
 * scope exactly as the other exporters do: per-session detail is withheld
 * unless explicitly asked for, and `assertReportSafe` runs over the payload
 * before a single byte is rendered.
 */
export interface MonthlyReportOptions {
  /** `YYYY-MM`. */
  readonly period: string;
  readonly allowance: Allowance;
  readonly scope?: ScopeSelection | undefined;
  readonly scopeLabel: string;
  readonly privacy?: PrivacyContext;
  readonly now?: Date;
}

export interface MonthlyReport {
  readonly period: string;
  readonly generatedAt: string;
  readonly scopeLabel: string;
  readonly ledger: LedgerSummary;
  readonly budget: BudgetForecast;
  readonly waste: WasteReport;
  readonly advice: SubstitutionAdvice;
  readonly session:
    | {
        readonly turns: number;
        readonly credits: number;
        readonly nextTurnCredits: number;
        readonly multipleOfFreshTurn: number;
        readonly freshTurnCredits: number;
      }
    | undefined;
  readonly privacy: PrivacyContext;
}

/** The months that actually have recorded activity, newest first. */
export function availablePeriods(db: Database.Database, scope?: ScopeSelection): string[] {
  const ledger = buildLedger(db, scope ? { scope } : undefined);
  const months = new Set(ledger.byDay.map((day) => day.day.slice(0, 7)));
  return [...months].sort().reverse();
}

export function monthBounds(period: string): { readonly from: string; readonly to: string } {
  const [year, month] = period.split('-').map(Number);
  const start = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1));
  const end = new Date(Date.UTC(year ?? 1970, month ?? 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export function buildMonthlyReport(
  db: Database.Database,
  options: MonthlyReportOptions,
): MonthlyReport {
  const { from, to } = monthBounds(options.period);
  const privacy: PrivacyContext = options.privacy ?? { scope: 'shared', subjectCount: 1 };

  const ledger = buildLedger(db, {
    ...(options.scope ? { scope: options.scope } : {}),
    from,
    to,
  });

  const budget = forecastBudget(
    ledger,
    options.allowance,
    options.now ?? new Date(`${to}T12:00:00Z`),
  );

  const sessionId = longestSessionId(db, options.scope);
  const projection =
    sessionId === undefined ? undefined : projectNextTurnCost(db, sessionId, options.scope);

  const report: MonthlyReport = {
    period: options.period,
    generatedAt: (options.now ?? new Date()).toISOString(),
    scopeLabel: options.scopeLabel,
    ledger,
    budget,
    waste: buildWasteReport(db, privacy),
    advice: buildSubstitutionAdvice(ledger),
    session:
      projection === undefined
        ? undefined
        : {
            turns: projection.turnsSoFar,
            credits: projection.sessionCredits,
            nextTurnCredits: projection.nextTurnCredits,
            multipleOfFreshTurn: projection.multipleOfFreshTurn,
            freshTurnCredits: projection.freshTurnCredits,
          },
    privacy,
  };

  // The guard runs over the assembled payload, not over the rendered text: a
  // check on prose would be a check on the renderer, not on the data.
  assertReportSafe(
    { ...report, ledger: mayIncludeEntityList(privacy) ? ledger : withoutSessions(ledger) },
    privacy,
  );
  return report;
}

function withoutSessions(ledger: LedgerSummary): LedgerSummary {
  return { ...ledger, bySession: [] };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const money = (credits: number): string => `$${creditsToUsd(credits).toFixed(2)}`;
const num = (value: number, digits = 0): string =>
  value.toLocaleString('en-US', { maximumFractionDigits: digits });
const pct = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '_No rows._\n';
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

export function renderMonthlyReportMarkdown(report: MonthlyReport, db?: Database.Database): string {
  const { ledger, budget, waste, advice } = report;
  const decomposed = ledger.byCostCentre.reduce((sum, centre) => sum + centre.credits, 0) || 1;
  const perDay = ledger.byDay.length > 0 ? ledger.totalCredits / ledger.byDay.length : 0;

  const lines: string[] = [];
  const push = (...text: string[]): void => {
    lines.push(...text);
  };

  push(`# GitHub Copilot spend — ${report.period}`, '');
  push(
    `Produced by TokenLens ${VERSION} on ${report.generatedAt.slice(0, 10)}.`,
    `Scope: ${report.scopeLabel}`,
    '',
  );

  // --- what this is, stated before any number ---
  push('## How to read this', '');
  push(
    'Copilot bills **GitHub AI Credits**, priced from input, output and cached tokens at a fixed',
    'rate of **1 credit = $0.01 USD**. Code completions and next-edit suggestions are *not* billed',
    'and are unlimited on every paid plan, so nothing here is about autocomplete.',
    '',
    `Of the credits below, **${pct(ledger.totalCredits > 0 ? ledger.measuredCredits / ledger.totalCredits : 0)} were measured**`,
    'from a recorded value and the rest are rate-card estimates. Estimated figures are marked where',
    'they matter. Nothing in this document is a prediction of behaviour — only an extrapolation of',
    'what was recorded.',
    '',
  );

  // --- headline ---
  push('## The month in figures', '');
  push(
    table(
      ['Measure', 'Value'],
      [
        ['Credits', num(ledger.totalCredits, 1)],
        ['Money', money(ledger.totalCredits)],
        ['Requests', num(ledger.requestCount)],
        ['Active days', num(ledger.byDay.length)],
        ['Credits per active day', num(perDay, 1)],
        [
          'Measured share',
          pct(ledger.totalCredits > 0 ? ledger.measuredCredits / ledger.totalCredits : 0),
        ],
      ],
    ),
    '',
  );

  // --- budget ---
  push('## Allowance and forecast', '');
  push(
    table(
      ['Measure', 'Value'],
      [
        ['Plan', budget.plan],
        [
          'Monthly allowance',
          budget.monthlyAllowance === null
            ? 'no limit set'
            : `${num(budget.monthlyAllowance)} credits (${money(budget.monthlyAllowance)})`,
        ],
        ['Allowance came from', budget.allowanceSource],
        [
          'Month to date',
          `${num(budget.monthToDateCredits, 1)} credits (${money(budget.monthToDateCredits)})`,
        ],
        [
          'Projected month end',
          `${num(budget.projectedMonthEndCredits, 1)} credits (${money(budget.projectedMonthEndCredits)})`,
        ],
        [
          'Beyond the allowance',
          budget.monthlyAllowance === null
            ? 'not applicable'
            : money(Math.max(0, budget.monthToDateCredits - budget.monthlyAllowance)),
        ],
      ],
    ),
    '',
  );
  if (isPooledPlan(budget.plan)) {
    push(
      '> On Business and Enterprise the allowance is pooled across the billing entity, so any',
      '> "remaining" figure is a claim on a shared pool rather than a personal quota.',
      '',
    );
  }
  if (budget.promotionalUntil !== undefined) {
    push(
      `> The allowance above is a promotional amount that ends on ${budget.promotionalUntil}.`,
      '',
    );
  }

  // --- where the tokens went: the most analysable section ---
  push('## Where the tokens went', '');
  push(
    'Every request re-sends its context, so this decomposition is usually a better guide to cost',
    'than the model mix is.',
    '',
    table(
      ['Cost centre', 'Credits', 'Money', 'Share'],
      ledger.byCostCentre
        .slice()
        .sort((a, b) => b.credits - a.credits)
        .map((centre) => [
          centre.label,
          num(centre.credits, 1),
          money(centre.credits),
          pct(centre.credits / decomposed),
        ]),
    ),
    '',
  );

  // --- model mix ---
  push('## Model mix', '');
  push(
    table(
      ['Model', 'Credits', 'Money', 'Requests', 'Credits per request'],
      ledger.byModel.map((model) => [
        model.model,
        num(model.credits, 1),
        money(model.credits),
        num(model.requestCount),
        num(model.requestCount > 0 ? model.credits / model.requestCount : 0, 1),
      ]),
    ),
    '',
  );

  // --- conversation economics ---
  if (report.session) {
    const session = report.session;
    push('## Conversation economics', '');
    push(
      `The longest conversation in scope ran **${num(session.turns)} turns** and cost`,
      `**${num(session.credits, 1)} credits (${money(session.credits)})**.`,
      '',
      `Fitted over that conversation's own turns, the next turn projects at`,
      `**${num(session.nextTurnCredits, 1)} credits (${money(session.nextTurnCredits)})** —`,
      `**${session.multipleOfFreshTurn.toFixed(1)}×** the median first turn of a fresh chat`,
      `(${num(session.freshTurnCredits, 1)} credits).`,
      '',
      'This is the compounding effect of re-sending history, and it is the one cost that a change',
      'of habit rather than a change of setting can remove.',
      '',
    );
  }

  // --- daily pattern ---
  push('## Daily pattern', '');
  push(
    table(
      ['Day', 'Credits', 'Money', 'Requests'],
      ledger.byDay.map((day) => [
        day.day,
        num(day.credits, 1),
        money(day.credits),
        num(day.requestCount),
      ]),
    ),
    '',
  );

  // --- waste findings ---
  push('## What the detectors found', '');
  if (waste.findings.length === 0) {
    push('_No findings._', '');
  } else {
    push(
      table(
        ['Class', 'Finding', 'Attributed credits', 'Money', 'Confidence', 'Remediation'],
        waste.findings.map((finding) => [
          finding.class,
          finding.title,
          num(finding.credits.value, 1),
          money(finding.credits.value),
          finding.confidence.toFixed(2),
          `${finding.remediation.summary} (tier ${finding.remediation.tier})`,
        ]),
      ),
      '',
    );
    if (waste.overlapWarning !== undefined) {
      push(`> ${waste.overlapWarning}`, '');
    }
  }

  if (waste.unavailable.length > 0) {
    push('### Classes that could not be assessed', '');
    push(
      'Listed because omitting them would imply their waste is zero, which is a stronger claim than',
      'the data supports.',
      '',
    );
    for (const entry of waste.unavailable) {
      push(
        `- **${entry.class} · ${entry.name}** — ${entry.reason} _Unblocked by: ${entry.unblockedBy}_`,
      );
    }
    push('');
  }

  // --- priced model lever ---
  if (advice.substitutions.length > 0) {
    push('## Priced model substitution', '');
    push(
      `Covering ${advice.window.replace('-', ' ')}, not just this month — a rate needs samples.`,
      '',
      table(
        ['From', 'To', 'Requests', 'Current', 'If substituted', 'Saving'],
        advice.substitutions.map((entry) => [
          entry.from,
          entry.to,
          num(entry.requests),
          money(entry.currentCredits),
          money(entry.substitutedCredits),
          money(entry.savedCredits),
        ]),
      ),
      '',
    );
    for (const caveat of advice.caveats) push(`> ${caveat}`, '');
    push('');
  }

  // --- tool surface ---
  if (db !== undefined) {
    const tools = toolSurface(db);
    if (tools.length > 0) {
      push('## Tool surface', '');
      push(
        'Every tool definition is re-sent on every request, so an unused server is a standing charge.',
        '',
        table(
          ['Server', 'Distinct tools', 'Invocations'],
          tools.map((tool) => [tool.server, num(tool.toolCount), num(tool.invocations)]),
        ),
        '',
      );
    }
  }

  if (!mayIncludeEntityList(report.privacy)) {
    push(
      '> Per-session detail is withheld because this report is treated as shareable. Regenerate with',
      '> `--self` to keep it in a copy you do not intend to send anywhere.',
      '',
    );
  }

  push('---', '');
  push(ANALYSIS_BRIEF.trim(), '');

  return lines.join('\n');
}

function toolSurface(
  db: Database.Database,
): { server: string; toolCount: number; invocations: number }[] {
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
