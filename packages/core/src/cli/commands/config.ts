import type { Command } from 'commander';
import {
  createSettingsStore,
  SETTINGS_FIELDS,
  SETTINGS_SOURCE_LABEL,
  type EffectiveSettings,
  type TokenLensSettings,
} from '../../dashboard/settings.js';
import { printHeading, printJson, printLine } from '../output.js';

/**
 * The one place every surface asks "what settings are actually in force?".
 *
 * The dashboard writes config, the CLI reads it, and the extension reads it
 * through the CLI — three clients over one pair of files. Before this
 * command each resolved the layers itself, and the extension additionally
 * carried settings of its own, so the three could disagree about the plan
 * while all three were "working".
 *
 * The answer therefore carries **where each value came from**, not just the
 * value. A figure whose origin is unstated invites the reader to assume it
 * was configured when it may only be a built-in default.
 */
interface ConfigCommandOptions {
  readonly json?: boolean;
}

function settingValue(settings: TokenLensSettings, key: keyof TokenLensSettings): string {
  const value = settings[key];
  if (value === undefined) return '(not set)';
  return String(value);
}

export function registerConfigCommand(program: Command): void {
  program
    .command('config')
    .description('Show the settings in force across the CLI, dashboard and VS Code extension.')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: ConfigCommandOptions) => {
      const settings: EffectiveSettings = await createSettingsStore().read();

      if (options.json) {
        printJson({
          effective: settings.effective,
          sources: settings.sources,
          allowance: settings.allowance,
          paths: settings.paths,
          ...(settings.overriddenByEnv !== undefined
            ? { overriddenByEnv: settings.overriddenByEnv }
            : {}),
        });
        return;
      }

      printHeading('TokenLens — settings in force');
      for (const field of SETTINGS_FIELDS) {
        const source = settings.sources[field.key];
        printLine(
          `${field.label.padEnd(20)} ${settingValue(settings.effective, field.key).padEnd(14)} ` +
            `[${SETTINGS_SOURCE_LABEL[source]}]`,
        );
      }

      printLine();
      printLine(`project config: ${settings.paths.project}`);
      printLine(`machine config: ${settings.paths.user}`);

      if (settings.overriddenByEnv !== undefined) {
        printLine();
        printLine(
          `${settings.overriddenByEnv} is set and outranks both files, so editing them ` +
            'will not change the allowance until it is unset.',
        );
      }

      printLine();
      printLine('These settings are shared. Change them once:');
      printLine('  tokenlens dashboard  →  Settings');
      printLine('and the CLI and the VS Code extension both follow.');
    });
}
