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

  // Phase D2.
  registerDashboardCommand(program);

  // Phase D3.
  registerWasteCommand(program);
  registerMcpRoiCommand(program);

  // Phase D4.
  registerSimulateCommand(program);

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
