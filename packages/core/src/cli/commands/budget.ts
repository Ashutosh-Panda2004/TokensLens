import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import { buildLedger } from '../../ledger/ledger.js';
import { forecastBudget, type CopilotPlan } from '../../ledger/budget.js';
import { printHeading, printJson, printLine } from '../output.js';

interface BudgetCommandOptions {
  readonly plan: string;
  readonly json?: boolean;
}

function parsePlan(value: string): CopilotPlan {
  return value === 'business' ? 'business' : 'enterprise';
}

export function registerBudgetCommand(program: Command): void {
  program
    .command('budget')
    .description('Show the credit burn-down and month-end forecast against your plan allowance.')
    .option('--plan <plan>', 'business or enterprise', 'enterprise')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: BudgetCommandOptions) => {
      const db = await openLedgerForReading();
      const ledger = buildLedger(db);
      const forecast = forecastBudget(ledger, parsePlan(options.plan));

      if (options.json) {
        printJson(forecast);
        return;
      }

      printHeading('TokenLens — budget burn-down');
      printLine(`plan:                ${forecast.plan}`);
      printLine(`monthly allowance:   ${String(forecast.monthlyAllowance)} credits`);
      printLine(
        `month-to-date:       ${forecast.monthToDateCredits.toFixed(1)} credits ` +
          `(day ${String(forecast.daysElapsedInMonth)} of ${String(forecast.daysInMonth)})`,
      );
      printLine(`projected month-end: ${forecast.projectedMonthEndCredits.toFixed(1)} credits`);

      if (forecast.onTrackToExceedAllowance) {
        printLine(
          `⚠ projected overage: ${forecast.projectedOverage.toFixed(1)} credits over the included allowance`,
        );
      } else {
        printLine('on track to stay within the included allowance.');
      }
    });
}
