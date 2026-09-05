import type { Command } from 'commander';
import { resolveScope, type ScopeMode, type ScopeSelection } from '../scope/index.js';
import { readMergedConfig } from '../shared/config.js';
import { ConfigError } from '../shared/errors.js';

export interface ScopeCommandOptions {
  readonly scope?: string;
  /** Repeatable: a VS Code workspace can hold several folders. */
  readonly at?: string | readonly string[];
  readonly all?: boolean;
}

const VALID_MODES: readonly ScopeMode[] = ['folder', 'workspace', 'path', 'all'];

function collectAnchor(value: string, previous: readonly string[] = []): string[] {
  return [...previous, value];
}

/**
 * The scope flags every ledger-reading command shares.
 *
 * Added in one place so the four commands cannot drift into describing the
 * same concept three different ways — and so a command that reads the
 * ledger cannot quietly ship without them.
 */
export function addScopeOptions(command: Command): Command {
  return command
    .option(
      '--scope <mode>',
      'folder (this directory and below, the default), workspace (exact match), path, or all',
    )
    .option(
      '--at <dir>',
      'anchor the scope at this directory instead of the current one (repeatable)',
      collectAnchor,
    )
    .option('--all', 'every workspace on this machine, not just this folder');
}

/**
 * Resolves the flags into a selection.
 *
 * An unrecognised `--scope` is a **hard error**, not a fallback to the
 * default. Silently ignoring it would report the current folder to somebody
 * who asked for the whole machine, and the figure would look entirely
 * plausible.
 */
export async function scopeFromOptions(options: ScopeCommandOptions): Promise<ScopeSelection> {
  if (options.scope !== undefined && !VALID_MODES.includes(options.scope as ScopeMode)) {
    throw new ConfigError(
      `Unknown --scope "${options.scope}". Use one of: ${VALID_MODES.join(', ')}.`,
      { reason: 'invalid-scope', value: options.scope },
    );
  }

  // Precedence, most specific first: --all, --scope, the configured default,
  // then `folder`. Same shape as the allowance, and for the same reason.
  const configured = (await readMergedConfig<{ defaultScope?: string }>({})).merged.defaultScope;
  const fromConfig = VALID_MODES.includes(configured as ScopeMode)
    ? (configured as ScopeMode)
    : undefined;

  const mode: ScopeMode = options.all
    ? 'all'
    : options.scope !== undefined
      ? (options.scope as ScopeMode)
      : (fromConfig ?? 'folder');

  const anchors =
    options.at === undefined ? [] : typeof options.at === 'string' ? [options.at] : options.at;

  return resolveScope({
    mode,
    ...(anchors.length > 0 ? { at: anchors } : {}),
  });
}

/**
 * The sentence an empty scope must produce.
 *
 * This is the exact situation that created the phase: standing in a folder
 * with no chat history and being shown the entire machine's spend. A blank
 * table would be no better — it reads as "you have spent nothing" when the
 * truth is "nothing here has been measured, and there is plenty elsewhere".
 */
export function emptyScopeLines(scope: ScopeSelection, machineWideCredits: number): string[] {
  return [
    'No VS Code chat history for this folder (or anything beneath it).',
    '',
    `  Scope        ${scope.rootDisplayPath ?? '(current folder)'}`,
    `  Workspaces   0 of ${String(scope.totalWorkspaceCount)} on this machine`,
    `  Machine-wide ${machineWideCredits.toFixed(1)} credits — run with --all to see it`,
  ];
}
