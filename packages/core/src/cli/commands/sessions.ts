import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import { buildLedger } from '../../ledger/ledger.js';
import { printHeading, printJson, printLine, printTable } from '../output.js';
import { shortId } from '../../privacy/identifiers.js';
import { mayIncludeEntityList, suppressionNotice } from '../../privacy/guard.js';
import type { PrivacyContext } from '../../privacy/scope.js';
import { addScopeOptions, scopeFromOptions, type ScopeCommandOptions } from '../scope-options.js';
import { describeScope } from '../../scope/index.js';

interface SessionsCommandOptions extends ScopeCommandOptions {
  readonly top: string;
  readonly json?: boolean;
  readonly shared?: boolean;
}

const DEFAULT_TOP_N = 10;

export function registerSessionsCommand(program: Command): void {
  const command = program
    .command('sessions')
    .description(
      'Rank your own sessions by credit spend — proves whether spend concentrates in a few sessions (F11).',
    )
    .option('--top <n>', 'limit to the top N sessions', String(DEFAULT_TOP_N))
    .option('--json', 'print machine-readable JSON instead of a table')
    .option(
      '--shared',
      'produce output intended to leave this machine — suppresses per-session detail',
    );

  addScopeOptions(command).action(async (options: SessionsCommandOptions) => {
    const scope = await scopeFromOptions(options);
    const db = await openLedgerForReading();
    const ledger = buildLedger(db, { scope });

    // A local ledger describes exactly one developer, so a shared ranking
    // of its sessions is a ranking of one person's work. The scope flag
    // makes that explicit rather than leaving the reader to notice.
    const ctx: PrivacyContext = {
      scope: options.shared ? 'shared' : 'self',
      subjectCount: 1,
    };

    if (!mayIncludeEntityList(ctx)) {
      printHeading('TokenLens — session concentration');
      printLine(
        `${String(ledger.bySession.length)} session(s), ` +
          `${ledger.totalCredits.toFixed(1)} credits in total.`,
      );
      printLine(describeScope(scope));
      printLine();
      printLine(suppressionNotice());
      return;
    }

    const parsedLimit = Number.parseInt(options.top, 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_TOP_N;
    const top = ledger.bySession.slice(0, limit);

    if (options.json) {
      printJson({ scope: describeScope(scope), sessions: top });
      return;
    }

    printHeading(`TokenLens — top ${String(top.length)} session(s) by credits`);
    printLine(describeScope(scope));
    printTable(
      top.map((session, index) => ({
        rank: index + 1,
        // Already a salted hash by the time it reaches here; shortened
        // only so the table stays readable.
        session: shortId(session.sessionId),
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

    printLine();
    printLine('Your own data, on your own machine. Use --shared for output that leaves it.');
  });
}
