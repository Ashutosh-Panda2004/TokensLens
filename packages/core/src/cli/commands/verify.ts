import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import { getRequestById } from '../../store/database.js';
import { printHeading, printJson, printLine } from '../output.js';
import { logger } from '../../shared/logger.js';

interface VerifyCommandOptions {
  readonly json?: boolean;
}

export function registerVerifyCommand(program: Command): void {
  program
    .command('verify')
    .argument(
      '<requestId>',
      'the request id to trace back to its source (see "tokenlens sessions" or "tokenlens ledger --json")',
    )
    .description("Print the source file and byte offset backing a request's figures.")
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (requestId: string, options: VerifyCommandOptions) => {
      const db = await openLedgerForReading();
      const row = getRequestById(db, requestId);

      if (!row) {
        logger.error(
          `No request found with id "${requestId}". Try "tokenlens sessions --top" or ` +
            '"tokenlens ledger --json" to find a valid one.',
        );
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        printJson(row);
        return;
      }

      printHeading(`TokenLens — verify ${requestId}`);
      printLine(`session:       ${row.sessionId} (hashed)`);
      printLine(`model:         ${row.model}`);
      printLine(`prompt tokens: ${String(row.promptTokens)}`);
      printLine(`output tokens: ${String(row.outputTokens)}`);
      printLine(
        `credits:       ${
          row.credits !== null
            ? `${row.credits.toFixed(3)} [measured]`
            : '(not measured on this request — see the rate-card estimate in "tokenlens ledger")'
        }`,
      );
      // Relative to the local workspaceStorage root — the absolute form
      // starts with the OS user's home directory and so names a person.
      // Join it to that root to open the file.
      printLine(`source file:   <workspaceStorage>/${row.sourceFile}`);
      printLine(`byte offset:   ${String(row.sourceOffset)}`);
    });
}
