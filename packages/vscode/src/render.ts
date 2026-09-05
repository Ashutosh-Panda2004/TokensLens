import * as vscode from 'vscode';
import type { HudSnapshot } from './core.js';
import { credits } from './format.js';
import { toHudHistoryView, type HudHistoryView } from './history.js';

export { credits } from './format.js';

/**
 * Formatting lives here rather than inside the views, so that a credit
 * figure and its money equivalent are rendered identically everywhere. Two
 * places formatting the same number is two places for them to disagree.
 */
export function money(usd: number): string {
  return usd.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: usd < 10 ? 2 : 0,
  });
}

export function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

export function multiple(value: number): string {
  return value >= 10 ? `${value.toFixed(0)}\u00d7` : `${value.toFixed(1)}\u00d7`;
}

export function ago(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  return `${String(Math.round(minutes / 60))}h ago`;
}

/** What the primary status-bar item should read. */
export type BarMetric = 'auto' | 'remaining' | 'spent' | 'today' | 'session' | 'projected';

export interface BarText {
  readonly text: string;
  readonly severity: 'none' | 'warning' | 'error';
}

/**
 * The sidebar's view model: strings, already formatted.
 *
 * The webview runs in its own context and cannot import from here, so the
 * choice is to duplicate the formatters there or to send it text. Text wins —
 * a second copy of "how a credit figure is written" is a second place for it
 * to drift, and the panel has no business deciding anything.
 */
export interface HudTile {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
}

export interface HudModelRow {
  readonly name: string;
  readonly value: string;
  /** 0..1, rendered as a bar width. */
  readonly share: number;
}

export interface HudView {
  readonly freshness: string;
  readonly scope: string;
  readonly hero: { readonly value: string; readonly label: string; readonly sub: string };
  readonly meter?: {
    readonly fill: number;
    readonly label: string;
    readonly state: 'ok' | 'warn' | 'over';
  };
  readonly tiles: readonly HudTile[];
  readonly session?: {
    readonly next: string;
    readonly multiple: string;
    readonly detail: string;
    readonly warn: boolean;
  };
  readonly models: readonly HudModelRow[];
  readonly history?: HudHistoryView;
  readonly saving?: { readonly value: string; readonly detail: string };
  readonly notes: readonly string[];
}

export function toHudView(snapshot: HudSnapshot): HudView {
  const { month, workspace, session, advice } = snapshot;
  const limited = !month.unlimited && month.allowance !== null;

  const notes: string[] = [
    `${percent(workspace.measuredPercent)} measured, the rest rate-card estimated`,
  ];
  if (month.promotionalUntil !== undefined) {
    notes.push(`Allowance is promotional until ${month.promotionalUntil}`);
  }
  if (month.pooled) notes.push('Credits are pooled across the billing entity, not per seat');

  const biggest = advice.substitutions[0];
  const topShare = workspace.allTime.credits > 0 ? workspace.allTime.credits : 1;

  return {
    freshness: ago(snapshot.generatedAt),
    scope: snapshot.scope,

    hero: limited
      ? {
          value: money((month.remainingCredits ?? 0) / 100),
          label: 'remaining this month',
          sub: `${credits(month.remainingCredits ?? 0)} of ${credits(month.allowance)} credits`,
        }
      : {
          value: money(month.usd),
          label: 'spent this month',
          sub: `${credits(month.credits)} credits · no monthly limit set`,
        },

    ...(limited && month.percentUsed !== null
      ? {
          meter: {
            fill: Math.min(1, month.percentUsed),
            label: `${percent(month.percentUsed)} used · day ${String(month.daysElapsed)} of ${String(month.daysInMonth)}`,
            state:
              month.percentUsed >= 1 ? 'over' : month.onTrackToExceed ? 'warn' : ('ok' as const),
          },
        }
      : {}),

    tiles: [
      {
        label: 'Today',
        value: money(workspace.today.usd),
        sub: `${credits(workspace.today.credits)} cr`,
      },
      {
        label: 'Projected',
        value: money(month.projectedUsd),
        sub: month.onTrackToExceed ? 'over the allowance' : 'by month end',
      },
      { label: 'Requests', value: credits(workspace.requests), sub: 'in this scope' },
      {
        label: 'Billable',
        value: money(month.incrementalUsd),
        sub: month.incrementalUsd > 0 ? 'beyond the allowance' : 'all inside the allowance',
      },
    ],

    ...(session?.nextTurn
      ? {
          session: {
            next: money(session.nextTurn.usd),
            multiple: `${multiple(session.nextTurn.multipleOfFreshTurn)} a fresh chat`,
            detail: `${String(session.turns)} turns · ${money(session.usd)} so far · measured over ${String(session.nextTurn.sampleSize)} turns`,
            warn: session.nextTurn.multipleOfFreshTurn >= 10,
          },
        }
      : {}),

    models: snapshot.topModels.slice(0, 5).map((model) => ({
      name: model.model,
      value: money(model.usd),
      share: Math.min(1, model.credits / topShare),
    })),

    ...(snapshot.history !== undefined ? { history: toHudHistoryView(snapshot.history) } : {}),

    ...(biggest !== undefined && biggest.savedUsd >= 0.5
      ? {
          saving: {
            value: money(biggest.savedUsd),
            detail: `${biggest.from} → ${biggest.to}, all time. Assumes the cheaper model would have done the job.`,
          },
        }
      : {}),

    notes,
  };
}

/**
 * The bar has roughly thirty characters and is glanced at, never read, so it
 * carries exactly one idea.
 *
 * Which idea depends on whether a limit exists, because the binding
 * constraint differs: with an allowance the question is what is left, and
 * without one there is nothing to remain — the constraint is the invoice.
 * Reporting "0 cr left" for an unlimited plan, which is what a naive
 * subtraction produces, is the specific defect this function exists to make
 * impossible.
 */
export function barTextFor(snapshot: HudSnapshot, metric: BarMetric): BarText {
  const { month, workspace, session } = snapshot;

  switch (metric) {
    case 'spent':
      return { text: `${credits(month.credits)} cr · ${money(month.usd)}`, severity: 'none' };
    case 'today':
      return {
        text: `${credits(workspace.today.credits)} cr today · ${money(workspace.today.usd)}`,
        severity: 'none',
      };
    case 'projected':
      return {
        text: `${credits(month.projectedCredits)} cr by month end · ${money(month.projectedUsd)}`,
        severity: month.onTrackToExceed ? 'warning' : 'none',
      };
    case 'session':
      return session?.nextTurn
        ? {
            text: `next turn ~${money(session.nextTurn.usd)} · ${multiple(session.nextTurn.multipleOfFreshTurn)} fresh`,
            severity: session.nextTurn.multipleOfFreshTurn >= 10 ? 'warning' : 'none',
          }
        : { text: `${credits(month.credits)} cr · ${money(month.usd)}`, severity: 'none' };
    case 'remaining':
    case 'auto':
    default:
      return autoBar(snapshot);
  }
}

function autoBar(snapshot: HudSnapshot): BarText {
  const { month } = snapshot;

  // Nothing remains when nothing is capped, so spend and its money value are
  // the only honest figures available.
  if (month.unlimited || month.allowance === null || month.remainingCredits === null) {
    return { text: `${credits(month.credits)} cr · ${money(month.usd)} MTD`, severity: 'none' };
  }

  if (month.remainingCredits <= 0) {
    return {
      text: `0 cr left · ${money(month.incrementalUsd)} over`,
      severity: 'error',
    };
  }

  // Past the point where the run-rate is the problem, the date the allowance
  // runs out is more actionable than the size of the shortfall.
  if (month.onTrackToExceed && month.hardBlockDate !== undefined) {
    return {
      text: `${credits(month.remainingCredits)} cr left · out ${shortDate(month.hardBlockDate)}`,
      severity: 'warning',
    };
  }

  return {
    text: `${credits(month.remainingCredits)} cr left · ${money(month.usd)} used`,
    severity: month.onTrackToExceed ? 'warning' : 'none',
  };
}

function shortDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return `${String(date.getUTCDate())} ${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`;
}

/**
 * The hover.
 *
 * Everything the bar could not fit, with its scope and provenance stated —
 * a figure whose scope is unclear is a figure that will be quoted wrongly.
 */
export function tooltipFor(snapshot: HudSnapshot): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = true;
  markdown.supportThemeIcons = true;

  const { month, workspace, session } = snapshot;

  markdown.appendMarkdown(`**TokenLens** · updated ${ago(snapshot.generatedAt)}\n\n`);
  markdown.appendMarkdown('| | credits | money |\n|---|--:|--:|\n');
  markdown.appendMarkdown(`| This month | ${credits(month.credits)} | ${money(month.usd)} |\n`);
  markdown.appendMarkdown(
    `| Projected month end | ${credits(month.projectedCredits)} | ${money(month.projectedUsd)} |\n`,
  );
  if (month.allowance !== null) {
    markdown.appendMarkdown(
      `| Allowance | ${credits(month.allowance)} | ${money(month.allowance / 100)} |\n`,
    );
    markdown.appendMarkdown(
      `| Remaining | ${credits(month.remainingCredits ?? 0)} | ${money((month.remainingCredits ?? 0) / 100)} |\n`,
    );
  }
  markdown.appendMarkdown(
    `| This workspace, today | ${credits(workspace.today.credits)} | ${money(workspace.today.usd)} |\n`,
  );
  markdown.appendMarkdown(
    `| This workspace, all time | ${credits(workspace.allTime.credits)} | ${money(workspace.allTime.usd)} |\n\n`,
  );

  markdown.appendMarkdown(`Day ${String(month.daysElapsed)} of ${String(month.daysInMonth)}. `);

  // Gross value consumed is not the incremental bill: included credits are
  // prepaid inside the subscription.
  if (month.allowance !== null) {
    markdown.appendMarkdown(
      month.incrementalUsd > 0
        ? `**${money(month.incrementalUsd)}** of this month is beyond the allowance, and so is new money.\n\n`
        : 'All of this month is inside the included allowance, so none of it is an extra charge.\n\n',
    );
  } else {
    markdown.appendMarkdown('No monthly limit is set, so every credit is billable.\n\n');
  }

  if (month.promotionalUntil !== undefined) {
    markdown.appendMarkdown(
      `The allowance above is a promotional amount that ends on ${month.promotionalUntil}.\n\n`,
    );
  }

  if (month.pooled) {
    markdown.appendMarkdown(
      'On Business and Enterprise these credits are pooled across the billing entity, so "remaining" is a claim on a shared pool rather than a personal quota.\n\n',
    );
  }

  if (session?.nextTurn) {
    markdown.appendMarkdown(
      `Longest conversation: **${String(session.turns)} turns**, ${credits(session.credits)} credits. ` +
        `The next turn projects at **${money(session.nextTurn.usd)}** — ` +
        `${multiple(session.nextTurn.multipleOfFreshTurn)} what a fresh chat's first turn costs.\n\n`,
    );
  }

  markdown.appendMarkdown(
    `${percent(workspace.measuredPercent)} of this is measured; the rest is rate-card estimated.\n\n`,
  );

  const best = snapshot.advice.substitutions[0];
  if (best !== undefined && best.savedUsd >= 1) {
    markdown.appendMarkdown(
      `Across all recorded history here, running ${best.from} on ${best.to} instead would have cost ` +
        `${money(best.savedUsd)} less — assuming the cheaper model would have done the job, which is a ` +
        'counterfactual rather than a measurement.\n\n',
    );
  }

  markdown.appendMarkdown(`Scope: ${snapshot.scope}\n\n`);
  markdown.appendMarkdown('[Breakdown](command:tokenlens.showBreakdown) · ');
  markdown.appendMarkdown('[Dashboard](command:tokenlens.openDashboard) · ');
  markdown.appendMarkdown('[Refresh](command:tokenlens.refresh)');
  return markdown;
}
