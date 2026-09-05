import { Command } from 'commander';
import { VERSION } from '../version.js';
import { NotImplementedError } from '../shared/errors.js';
import { ROADMAP_COMMANDS } from './roadmap.js';
import { registerLedgerCommand } from './commands/ledger.js';
import { registerSessionsCommand } from './commands/sessions.js';
import { registerVerifyCommand } from './commands/verify.js';
import { registerBudgetCommand } from './commands/budget.js';
import { registerDashboardCommand } from './commands/dashboard.js';
import { registerMcpRoiCommand, registerWasteCommand } from './commands/waste.js';
import { registerSimulateCommand } from './commands/simulate.js';
import { registerPolicyCommand } from './commands/policy.js';
import { registerOutcomesCommand } from './commands/outcomes.js';
import { registerHookCommand, registerMcpCommand } from './commands/hook.js';
import { registerHoldoutCommand } from './commands/holdout.js';
import { registerOrgCommand } from './commands/org.js';
import { registerAdviseCommand } from './commands/advise.js';
import { registerProjectsCommand } from './commands/projects.js';
import { registerConfigCommand } from './commands/config.js';
import { registerContributeCommand } from './commands/contribute.js';
import { registerHudCommand } from './commands/hud.js';
import { registerReportCommand } from './commands/report.js';

/**
 * Builds the commander program from scratch on every call — no shared
 * module-level instance. This is what makes the CLI testable: each test
 * gets an isolated `Command` and parses a synthetic `argv`, with no risk of
 * state leaking between tests.
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('tokenlens')
    .description(
      'TokenLens — measured GitHub Copilot credit ledger, waste attribution, ' +
        'and policy compiler for VS Code.',
    )
    .version(VERSION, '-v, --version', 'print the installed TokenLens version')
    // Converts commander's own process.exit() calls (help, version, usage
    // errors) into a thrown CommanderError, so cli/index.ts controls the
    // actual process exit uniformly instead of commander doing it directly.
    .exitOverride();

  // Phase D1 — implemented for real, not roadmap stubs.
  registerLedgerCommand(program);
  registerSessionsCommand(program);
  registerVerifyCommand(program);
  registerBudgetCommand(program);

  // Phase D13 — which project is this spend actually about?
  registerProjectsCommand(program);

  // Shared settings, read by the CLI, the dashboard and the extension alike.
  registerConfigCommand(program);

  // Opt-in anonymous aggregates. Produces a local file; uploads nothing.
  registerContributeCommand(program);

  // D14 — the single snapshot the VS Code HUD renders from.
  registerHudCommand(program);

  // A month of spend as Markdown, for a person or an assistant to analyse.
  registerReportCommand(program);

  // Phase D2.
  registerDashboardCommand(program);

  // Phase D3.
  registerWasteCommand(program);
  registerMcpRoiCommand(program);

  // Phase D4.
  registerSimulateCommand(program);

  // Phase D5.
  registerPolicyCommand(program);

  // Phase D10.
  registerOutcomesCommand(program);

  // Phase D6.
  registerHookCommand(program);
  registerMcpCommand(program);

  // Phase D8.
  registerHoldoutCommand(program);

  // Phase D9.
  registerOrgCommand(program);

  // Phase D11.
  registerAdviseCommand(program);

  for (const roadmapCommand of ROADMAP_COMMANDS) {
    program
      .command(roadmapCommand.name)
      .description(
        `${roadmapCommand.summary} (ships in Phase ${roadmapCommand.phase} — not yet implemented)`,
      )
      .action(() => {
        throw new NotImplementedError(roadmapCommand.name, roadmapCommand.phase);
      });
  }

  return program;
}
