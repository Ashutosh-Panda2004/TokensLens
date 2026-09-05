import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import { buildLedger } from '../../ledger/ledger.js';
import { forecastBudget, parsePlan, resolveAllowance } from '../../ledger/budget.js';
import { readMergedConfig } from '../../shared/config.js';
import { addScopeOptions, scopeFromOptions, type ScopeCommandOptions } from '../scope-options.js';
import { describeScope } from '../../scope/index.js';
import { printHeading, printJson, printLine } from '../output.js';

interface BudgetCommandOptions extends ScopeCommandOptions {
  readonly plan?: string;
  readonly allowance?: string;
  readonly json?: boolean;
}

/** The subset of `.tokenlens/config.json` this command reads. */
interface BudgetConfig {
  readonly plan?: string;
  readonly monthlyAllowance?: string | number;
}

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  flag: '--allowance',
  env: 'TOKENLENS_MONTHLY_ALLOWANCE',
  config: './.tokenlens/config.json',
  'user-config': '~/.tokenlens/config.json',
  'plan-default': 'plan default — not your organisation’s actual limit',
};

export function registerBudgetCommand(program: Command): void {
  const command = program
    .command('budget')
    .description('Show the credit burn-down and month-end forecast against your plan allowance.')
    .option('--plan <plan>', 'business or enterprise')
    .option(
      '--allowance <credits>',
      'monthly included credits, or "unlimited" when your organisation sets no monthly limit',
    )
    .option('--json', 'print machine-readable JSON instead of a summary');

  addScopeOptions(command).action(async (options: BudgetCommandOptions) => {
    const config = await readMergedConfig<BudgetConfig>({});
    const plan =
      options.plan !== undefined
        ? parsePlan(options.plan, '--plan')
        : config.merged.plan !== undefined
          ? parsePlan(config.merged.plan, 'config.json')
          : 'enterprise';
    const allowance = resolveAllowance({
      plan,
      flag: options.allowance,
      env: process.env.TOKENLENS_MONTHLY_ALLOWANCE,
      config: config.project.monthlyAllowance,
      userConfig: config.user.monthlyAllowance,
    });

    const db = await openLedgerForReading();
    const scope = await scopeFromOptions(options);
    const ledger = buildLedger(db, { scope });
    const forecast = forecastBudget(ledger, allowance);

    if (options.json) {
      printJson({ scope: describeScope(scope), ...forecast });
      return;
    }

    printHeading('TokenLens — budget burn-down');
    printLine(`plan:                ${forecast.plan}`);
    printLine(
      `monthly allowance:   ${
        forecast.monthlyAllowance === null
          ? 'unlimited — no monthly limit set'
          : `${String(forecast.monthlyAllowance)} credits`
      }  [${SOURCE_LABEL[forecast.allowanceSource] ?? forecast.allowanceSource}]`,
    );
    printLine(
      `month-to-date:       ${forecast.monthToDateCredits.toFixed(1)} credits ` +
        `(day ${String(forecast.daysElapsedInMonth)} of ${String(forecast.daysInMonth)})`,
    );
    printLine(`projected month-end: ${forecast.projectedMonthEndCredits.toFixed(1)} credits`);
    printLine(describeScope(scope));

    if (forecast.unlimited) {
      printLine('no monthly limit is enforced, so there is no overage to project.');
    } else if (forecast.onTrackToExceedAllowance) {
      printLine(
        `⚠ projected overage: ${forecast.projectedOverage.toFixed(1)} credits over the included allowance`,
      );
    } else {
      printLine('on track to stay within the included allowance.');
    }

    if (forecast.allowanceSource === 'plan-default') {
      printLine();
      printLine(
        'The allowance above is the published figure for this plan, not a reading of your ' +
          'organisation’s settings — TokenLens makes no network calls, so it cannot see them.',
      );
      printLine('  Set it in the dashboard:  tokenlens dashboard  →  Settings');
      printLine('  Or from here:             tokenlens budget --allowance unlimited');
      printLine(
        '  Machine-wide:             TOKENLENS_MONTHLY_ALLOWANCE, or ~/.tokenlens/config.json',
      );
    }
  });
}
