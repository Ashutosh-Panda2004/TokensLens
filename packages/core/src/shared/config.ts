import { join } from 'node:path';
import { ConfigError } from './errors.js';
import { pathExists, readJsonFileOrDefault, writeJsonFileAtomic } from './io.js';
import { CONFIG_FILE_NAME, TOKENLENS_DIR } from './constants.js';

const ENV_REFERENCE_PATTERN = /^env:(.+)$/;

/** True when `value` uses the `env:VAR_NAME` secret-indirection convention. */
export function isEnvReference(value: string): boolean {
  return ENV_REFERENCE_PATTERN.test(value);
}

/**
 * Resolves the `env:VAR_NAME` secret-indirection convention: config files
 * store a *reference* to an environment variable, never the secret itself,
 * so credentials never land in a file that might be committed to source
 * control. Values without the `env:` prefix pass through unchanged.
 */
export function resolveEnvReference(value: string): string {
  const match = ENV_REFERENCE_PATTERN.exec(value);
  if (!match) return value;

  const variableName = match[1] ?? '';
  const resolved = process.env[variableName];
  if (!resolved) {
    throw new ConfigError(
      `Config references environment variable "${variableName}", which is not set.`,
      { reason: 'missing-env-var', variableName },
    );
  }
  return resolved;
}

/** Absolute path to the `.tokenlens/` directory for a given working directory. */
export function tokenLensDir(cwd: string = process.cwd()): string {
  return join(cwd, TOKENLENS_DIR);
}

/** Absolute path to `.tokenlens/config.json` for a given working directory. */
export function configFilePath(cwd: string = process.cwd()): string {
  return join(tokenLensDir(cwd), CONFIG_FILE_NAME);
}

export async function configExists(cwd: string = process.cwd()): Promise<boolean> {
  return pathExists(configFilePath(cwd));
}

/**
 * Reads `.tokenlens/config.json`.
 *
 * Deliberately stricter than the generic readers in `io.ts`: a *missing*
 * file is normal (`fallback` applies — the tool is simply not configured
 * yet) but a *present, malformed* file throws {@link ConfigError} instead
 * of silently falling back. The user believes their settings are in
 * effect; pretending otherwise would violate the "degrade loudly, never
 * silently" principle (PLAN.md P5) for the one file the user hand-edits.
 */
export async function readConfig<T>(fallback: T, cwd: string = process.cwd()): Promise<T> {
  const filePath = configFilePath(cwd);

  try {
    return await readJsonFileOrDefault(filePath, fallback, { onParseError: 'throw' });
  } catch (error) {
    throw new ConfigError(
      `Failed to parse ${filePath}. The file exists but is not valid JSON.`,
      { reason: 'malformed-json', filePath },
      { cause: error },
    );
  }
}

/**
 * Writes `.tokenlens/config.json` atomically, creating the directory if
 * needed. Deliberately untyped (`unknown`, not a generic `<T>`): the
 * function does nothing with the shape of `value` beyond serialising it,
 * so a generic here would only decorate the signature, not constrain it.
 */
export async function writeConfig(value: unknown, cwd: string = process.cwd()): Promise<void> {
  await writeJsonFileAtomic(configFilePath(cwd), value);
}
