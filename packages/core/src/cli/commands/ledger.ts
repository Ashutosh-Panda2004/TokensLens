import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import { buildLedger } from '../../ledger/ledger.js';
import { addScopeOptions, emptyScopeLines, scopeFromOptions } from '../scope-options.js';
import { describeScope, isEmptyScope } from '../../scope/index.js';
import type { ScopeCommandOptions } from '../scope-options.js';
import { printHeading, printJson, printLine, printTable } from '../output.js';

interface LedgerCommandOptions extends ScopeCommandOptions {
  readonly json?: boolean;
}

export function registerLedgerCommand(program: Command): void {
  const command = program
    .command('ledger')
    .description('Show the exact credit ledger by day, model, session, and cost centre.')
    .option('--json', 'print machine-readable JSON instead of tables');

  addScopeOptions(command).action(async (options: LedgerCommandOptions) => {
    const scope = await scopeFromOptions(options);
    const db = await openLedgerForReading();
    const ledger = buildLedger(db, { scope });

    if (options.json) {
      printJson({ scope: describeScope(scope), ...ledger });
      return;
    }

    if (isEmptyScope(scope)) {
      // Never a blank table: "nothing here" and "you spent nothing" are
      // opposite claims, and only one of them is true.
      const machineWide = buildLedger(db);
      printHeading('TokenLens — Credit Ledger');
      for (const line of emptyScopeLines(scope, machineWide.totalCredits)) printLine(line);
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
    printLine(`  ${describeScope(scope)}`);

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
