import type { Command } from 'commander';
import open from 'open';
import { openLedgerForReading } from '../context.js';
import { createDashboardServer } from '../../dashboard/server.js';
import { generateDashboardToken } from '../../dashboard/token.js';
import { exportHtml, exportJson } from '../../dashboard/export.js';
import { printLine } from '../output.js';
import { logger } from '../../shared/logger.js';
import type { CopilotPlan } from '../../ledger/budget.js';
import type { PrivacyContext } from '../../privacy/scope.js';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

interface DashboardCommandOptions {
  readonly port: string;
  readonly open?: boolean;
  readonly json?: string;
  readonly html?: string;
  readonly plan: string;
  readonly self?: boolean;
}

function parsePlan(value: string): CopilotPlan {
  return value === 'business' ? 'business' : 'enterprise';
}

async function shutdown(app: FastifyInstance, db: Database.Database): Promise<void> {
  await app.close();
  db.close();
  process.exit(0);
}

export function registerDashboardCommand(program: Command): void {
  program
    .command('dashboard')
    .description('Start the local read-only reporting dashboard, or export a static report.')
    .option('--port <port>', 'port to listen on', '7331')
    .option('--open', 'open the dashboard in your default browser')
    .option('--json <file>', 'write a JSON report to <file> and exit, instead of starting a server')
    .option(
      '--html <file>',
      'write a self-contained HTML report to <file> and exit, instead of starting a server',
    )
    .option('--plan <plan>', 'business or enterprise, for the budget forecast', 'enterprise')
    .option(
      '--self',
      'this export is for your own eyes only — keeps per-session detail. ' +
        'Without it, exports are treated as shareable and that detail is withheld.',
    )
    .action(async (options: DashboardCommandOptions) => {
      const db = await openLedgerForReading();
      const plan = parsePlan(options.plan);

      // An exported file is the artefact most likely to be forwarded, so the
      // default is the safe scope and the permissive one must be asked for.
      const privacy: PrivacyContext = {
        scope: options.self ? 'self' : 'shared',
        subjectCount: 1,
      };

      // Both exports can be requested at once — they are independent
      // artefacts of the same snapshot, so honouring only the first would
      // silently drop the other.
      if (options.json !== undefined || options.html !== undefined) {
        if (options.json !== undefined) {
          await exportJson(db, options.json, plan, undefined, privacy);
          logger.success(`Wrote JSON report to ${options.json}`);
        }
        if (options.html !== undefined) {
          await exportHtml(db, options.html, plan, undefined, privacy);
          logger.success(`Wrote HTML report to ${options.html}`);
        }
        if (privacy.scope === 'shared') {
          logger.info(
            'Per-session detail was withheld so this file is safe to share. Use --self to keep it.',
          );
        }
        db.close();
        return;
      }

      const token = generateDashboardToken();
      const app = createDashboardServer({ db, token });
      const port = Number.parseInt(options.port, 10) || 7331;

      // 127.0.0.1 explicitly, never the default (which on some Node/OS
      // combinations means "all interfaces") — audit defect D-17.
      await app.listen({ host: '127.0.0.1', port });
      const url = `http://127.0.0.1:${String(port)}/?token=${token}`;

      printLine(`TokenLens dashboard running at ${url}`);
      printLine('Press Ctrl+C to stop.');

      if (options.open) {
        await open(url);
      }

      process.on('SIGINT', () => void shutdown(app, db));
      process.on('SIGTERM', () => void shutdown(app, db));
    });
}
