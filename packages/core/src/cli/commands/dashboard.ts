import type { Command } from 'commander';
import open from 'open';
import { openLedgerForReading, collectDetectInputs } from '../context.js';
import { createDashboardServer } from '../../dashboard/server.js';
import { generateDashboardToken } from '../../dashboard/token.js';
import { exportHtml, exportJson } from '../../dashboard/export.js';
import { printLine } from '../output.js';
import { logger } from '../../shared/logger.js';
import { readMergedConfig } from '../../shared/config.js';
import { PortUnavailableError } from '../../shared/errors.js';
import { parsePlan, resolveAllowance } from '../../ledger/budget.js';
import { readWorkspaceMap } from '../../scope/index.js';
import { createSettingsStore } from '../../dashboard/settings.js';
import { addScopeOptions, scopeFromOptions, type ScopeCommandOptions } from '../scope-options.js';
import type { PrivacyContext } from '../../privacy/scope.js';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

interface DashboardCommandOptions extends ScopeCommandOptions {
  readonly port?: string;
  readonly open?: boolean;
  readonly json?: string;
  readonly html?: string;
  readonly plan?: string;
  readonly allowance?: string;
  readonly self?: boolean;
}

/** The subset of `.tokenlens/config.json` this command reads. */
interface DashboardConfig {
  readonly plan?: string;
  readonly monthlyAllowance?: string | number;
}

async function shutdown(app: FastifyInstance, db: Database.Database): Promise<void> {
  await app.close();
  db.close();
  process.exit(0);
}

const DEFAULT_PORT = 7331;
/** How far to walk before giving up. Twenty dashboards is not a port problem. */
const PORT_SCAN_LIMIT = 20;

function isAddressInUse(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'EADDRINUSE';
}

/**
 * Binds the first free port at or after `preferred`.
 *
 * An **explicitly requested** port is never moved. Asking for 7331 and
 * silently being given 7332 hides that something else already owns the
 * address, and the next thing the user does is point a browser at the port
 * they asked for. A *default*, though, is a convenience rather than a
 * request — so a second dashboard walks forward instead of failing, and says
 * that it did.
 */
async function listenOnFreePort(
  app: FastifyInstance,
  preferred: number,
  explicit: boolean,
): Promise<number> {
  const attempts = explicit ? 1 : PORT_SCAN_LIMIT;

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferred + offset;
    try {
      // 127.0.0.1 explicitly, never the default (which on some Node/OS
      // combinations means "all interfaces") — audit defect D-17.
      await app.listen({ host: '127.0.0.1', port });
      return port;
    } catch (error) {
      if (!isAddressInUse(error)) throw error;

      if (offset === attempts - 1) {
        throw new PortUnavailableError(
          explicit
            ? `Port ${String(preferred)} is already in use. Another TokenLens dashboard, or something else, is on it. ` +
                'Run without --port to have one chosen for you.'
            : `Ports ${String(preferred)} to ${String(port)} are all in use. Stop a running dashboard, or pass --port explicitly.`,
          { port: preferred, attempted: offset + 1, explicit },
          { cause: error },
        );
      }
    }
  }

  throw new PortUnavailableError(`Could not bind a port at or after ${String(preferred)}.`, {
    port: preferred,
    attempted: attempts,
    explicit,
  });
}

export function registerDashboardCommand(program: Command): void {
  const command = program
    .command('dashboard')
    .description('Start the local read-only reporting dashboard, or export a static report.')
    .option('--port <port>', 'port to listen on (default: 7331, or dashboardPort from config)')
    .option('--open', 'open the dashboard in your default browser')
    .option('--json <file>', 'write a JSON report to <file> and exit, instead of starting a server')
    .option(
      '--html <file>',
      'write a self-contained HTML report to <file> and exit, instead of starting a server',
    )
    .option('--plan <plan>', 'the Copilot plan to forecast against')
    .option(
      '--allowance <credits>',
      'monthly included credits, or "unlimited" when your organisation sets no monthly limit',
    )
    .option(
      '--self',
      'this export is for your own eyes only — keeps per-session detail. ' +
        'Without it, exports are treated as shareable and that detail is withheld.',
    );

  addScopeOptions(command).action(async (options: DashboardCommandOptions) => {
    const config = (await readMergedConfig<DashboardConfig>({})).merged;
    const plan =
      options.plan !== undefined
        ? parsePlan(options.plan, '--plan')
        : config.plan !== undefined
          ? parsePlan(config.plan, 'config.json')
          : 'enterprise';
    const allowance = resolveAllowance({
      plan,
      flag: options.allowance,
      env: process.env.TOKENLENS_MONTHLY_ALLOWANCE,
      config: config.monthlyAllowance,
    });
    const db = await openLedgerForReading();

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
        await exportJson(db, options.json, allowance, undefined, privacy);
        logger.success(`Wrote JSON report to ${options.json}`);
      }
      if (options.html !== undefined) {
        await exportHtml(db, options.html, allowance, undefined, privacy);
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
    const [locations, detectInputs] = await Promise.all([
      readWorkspaceMap(),
      collectDetectInputs(),
    ]);
    const scope = await scopeFromOptions(options);
    const settings = createSettingsStore();
    const configured = (await settings.read()).effective;

    const app = createDashboardServer({
      db,
      token,
      allowance,
      locations,
      scope,
      detectInputs,
      settings,
      range: configured.defaultRange,
    });

    const configuredPort = configured.dashboardPort;
    // `Number.parseInt` yields NaN rather than nullish for junk, so this
    // cannot be a `??` chain without letting NaN through as a port.
    const requested = options.port === undefined ? Number.NaN : Number.parseInt(options.port, 10);
    const explicit = Number.isInteger(requested);
    const preferred = explicit ? requested : (configuredPort ?? DEFAULT_PORT);

    const port = await listenOnFreePort(app, preferred, explicit);
    const url = `http://127.0.0.1:${String(port)}/?token=${token}`;

    printLine(`TokenLens dashboard running at ${url}`);
    if (port !== preferred) {
      printLine(`(${String(preferred)} was busy, so this one moved to ${String(port)}.)`);
    }
    printLine('Press Ctrl+C to stop.');

    if (options.open) {
      await open(url);
    }

    process.on('SIGINT', () => void shutdown(app, db));
    process.on('SIGTERM', () => void shutdown(app, db));
  });
}
