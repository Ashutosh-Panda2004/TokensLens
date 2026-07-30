import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import { buildLedger } from '../../ledger/ledger.js';
import { printHeading, printJson, printTable } from '../output.js';

interface SessionsCommandOptions {
  readonly top: string;
  readonly json?: boolean;
}

const DEFAULT_TOP_N = 10;

export function registerSessionsCommand(program: Command): void {
  program
    .command('sessions')
    .description(
      'Rank sessions by credit spend — proves whether spend concentrates in a few sessions (F11).',
    )
    .option('--top <n>', 'limit to the top N sessions', String(DEFAULT_TOP_N))
    .option('--json', 'print machine-readable JSON instead of a table')
    .action(async (options: SessionsCommandOptions) => {
      const db = await openLedgerForReading();
      const ledger = buildLedger(db);

      const parsedLimit = Number.parseInt(options.top, 10);
      const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_TOP_N;
      const top = ledger.bySession.slice(0, limit);

      if (options.json) {
        printJson(top);
        return;
      }

      printHeading(`TokenLens — top ${String(top.length)} session(s) by credits`);
      printTable(
        top.map((session, index) => ({
          rank: index + 1,
          session: session.sessionId,
          credits: session.credits.toFixed(1),
          requests: session.requestCount,
        })),
      );

      if (ledger.bySession.length > 0) {
        const topShare = top.reduce((sum, s) => sum + s.credits, 0) / ledger.totalCredits;
        printTable([
          {
            'sessions shown': top.length,
            'of total sessions': ledger.bySession.length,
            'share of total credits': `${(topShare * 100).toFixed(1)}%`,
          },
        ]);
      }
    });
}
