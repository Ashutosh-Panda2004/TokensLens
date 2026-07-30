import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import { buildLedger } from '../../ledger/ledger.js';
import { printHeading, printJson, printLine, printTable } from '../output.js';

interface LedgerCommandOptions {
  readonly json?: boolean;
}

export function registerLedgerCommand(program: Command): void {
  program
    .command('ledger')
    .description('Show the exact credit ledger by day, model, session, and cost centre.')
    .option('--json', 'print machine-readable JSON instead of tables')
    .action(async (options: LedgerCommandOptions) => {
      const db = await openLedgerForReading();
      const ledger = buildLedger(db);

      if (options.json) {
        printJson(ledger);
        return;
      }

      printHeading('TokenLens — Credit Ledger');
      printLine(
        `Total: ${ledger.totalCredits.toFixed(1)} credits across ${String(ledger.requestCount)} request(s)`,
      );
      printLine(
        `  measured: ${ledger.measuredCredits.toFixed(1)} · ` +
          `modelled (rate-card estimate): ${ledger.modelledCredits.toFixed(1)}`,
      );

      printHeading('By day');
      printTable(
        ledger.byDay.map((day) => ({
          day: day.day,
          credits: day.credits.toFixed(1),
          requests: day.requestCount,
        })),
      );

      printHeading('By model');
      printTable(
        ledger.byModel.map((model) => ({
          model: model.model,
          credits: model.credits.toFixed(1),
          requests: model.requestCount,
          'cr/1k': model.rate.creditsPerKPromptToken.toFixed(3),
        })),
      );

      printHeading('By cost centre');
      printTable(
        ledger.byCostCentre.map((centre) => ({
          label: centre.label,
          tokens: centre.tokens,
          credits: centre.credits.toFixed(1),
        })),
      );
    });
}
