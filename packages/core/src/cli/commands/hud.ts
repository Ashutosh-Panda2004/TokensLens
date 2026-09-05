import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import { buildHudSnapshot } from '../../ledger/hud.js';
import { parsePlan, resolveAllowance } from '../../ledger/budget.js';
import { readMergedConfig } from '../../shared/config.js';
import { addScopeOptions, scopeFromOptions, type ScopeCommandOptions } from '../scope-options.js';
import { describeScope } from '../../scope/index.js';
import { printJson, printLine } from '../output.js';

interface HudCommandOptions extends ScopeCommandOptions {
  readonly plan?: string;
  readonly allowance?: string;
  readonly json?: boolean;
}

interface HudConfig {
  readonly plan?: string;
  readonly monthlyAllowance?: string | number;
}

/**
 * One command, one database read, one internally consistent answer.
 *
 * The VS Code HUD is the only intended caller, and it is deliberately a
 * single spawn: the previous two-call shape could report a month total from
 * one instant and a breakdown from another.
 */
export function registerHudCommand(program: Command): void {
  const command = program
    .command('hud')
    .description('Everything the VS Code HUD shows, from a single snapshot.')
    .option('--plan <plan>', 'override the configured Copilot plan')
    .option('--allowance <credits>', 'override the configured monthly allowance')
    .option('--json', 'print machine-readable JSON (the default for this command)');

  addScopeOptions(command).action(async (options: HudCommandOptions) => {
    const config = await readMergedConfig<HudConfig>({});
    const plan =
      options.plan !== undefined
        ? parsePlan(options.plan, '--plan')
        : config.merged.plan !== undefined
          ? parsePlan(config.merged.plan, 'config.json')
          : 'enterprise';

    const allowance = resolveAllowance({
      plan,
      flag: options.allowance,
      env: process.env.TOKENLENS_MONTHLY_ALLOWANCE,
      config: config.project.monthlyAllowance,
      userConfig: config.user.monthlyAllowance,
    });

    const db = await openLedgerForReading();
    try {
      const scope = await scopeFromOptions(options);
      const snapshot = buildHudSnapshot(db, {
        allowance,
        scope,
        scopeLabel: describeScope(scope),
      });

      if (options.json === false) {
        printLine(`${snapshot.month.credits.toFixed(1)} credits this month`);
        return;
      }
      printJson(snapshot);
    } finally {
      db.close();
    }
  });
}
