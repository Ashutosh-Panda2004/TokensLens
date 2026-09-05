import {
  configFilePath,
  readMergedConfig,
  readConfig,
  readUserConfig,
  userConfigFilePath,
  writeConfig,
  writeUserConfig,
  type ConfigLayer,
} from '../shared/config.js';
import {
  COPILOT_PLANS,
  parseAllowanceValue,
  resolveAllowance,
  type Allowance,
  type CopilotPlan,
} from '../ledger/budget.js';
import type { ScopeMode } from '../scope/types.js';

/**
 * The settings a person may edit, and nothing else.
 *
 * This is the write surface of an otherwise read-only server, so it is an
 * explicit allowlist rather than "merge whatever JSON arrives". A config
 * file the user hand-edits is one thing; a config file a web page can write
 * arbitrary keys into is a different risk entirely, and the difference is
 * this list.
 */
export interface TokenLensSettings {
  readonly plan?: CopilotPlan;
  /** Included credits per month, or the string `unlimited`. */
  readonly monthlyAllowance?: number | string;
  readonly defaultScope?: ScopeMode;
  readonly defaultRange?: string;
  readonly dashboardPort?: number;
}

const RANGES = ['all', '7', '30', '90', 'mtd'];
const SCOPES: readonly ScopeMode[] = ['folder', 'workspace', 'all'];

export interface SettingsFieldDescriptor {
  readonly key: keyof TokenLensSettings;
  readonly label: string;
  readonly help: string;
  readonly kind: 'choice' | 'allowance' | 'port';
  readonly choices?: readonly string[];
  /** What this setting actually changes. Stated so no field is decorative. */
  readonly affects: string;
}

export const SETTINGS_FIELDS: readonly SettingsFieldDescriptor[] = [
  {
    key: 'plan',
    label: 'Copilot plan',
    help: 'Sets the published per-seat allowance used when no explicit figure is given. Business and Enterprise credits are pooled across the billing entity rather than per seat.',
    kind: 'choice',
    choices: COPILOT_PLANS,
    affects: 'tokenlens budget, the HUD, the Budget view, and the MCP budget-guard tool',
  },
  {
    key: 'monthlyAllowance',
    label: 'Monthly allowance',
    help: 'Credits included per month, or "unlimited" when your organisation sets no monthly limit. TokenLens makes no network calls, so it cannot read this from GitHub.',
    kind: 'allowance',
    affects: 'the overage warning, the projected exhaustion date, and budget remaining',
  },
  {
    key: 'defaultScope',
    label: 'Default scope',
    help: 'Which workspaces a command covers when no --scope flag is given.',
    kind: 'choice',
    choices: SCOPES,
    affects: 'ledger, sessions, budget and the dashboard on first load',
  },
  {
    key: 'defaultRange',
    label: 'Default date range',
    help: 'The range the dashboard opens on.',
    kind: 'choice',
    choices: RANGES,
    affects: 'the dashboard only',
  },
  {
    key: 'dashboardPort',
    label: 'Dashboard port',
    help: 'Port tokenlens dashboard listens on when --port is not given.',
    kind: 'port',
    affects: 'tokenlens dashboard',
  },
];

export interface ValidationResult {
  readonly value: TokenLensSettings;
  readonly errors: readonly string[];
}

/** The settings object while it is being built — the public shape is readonly. */
type MutableSettings = { -readonly [K in keyof TokenLensSettings]: TokenLensSettings[K] };

/**
 * Validates a patch from the browser.
 *
 * Every field is checked and anything unrecognised is **rejected rather
 * than ignored**. A silently dropped key writes a file the user believes
 * contains their setting, and they conclude the setting does not work.
 */
export function validateSettingsPatch(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const value: MutableSettings = {};

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { value: {}, errors: ['Expected a JSON object of settings.'] };
  }

  const known = new Set<string>(SETTINGS_FIELDS.map((field) => field.key));

  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key)) {
      errors.push(`Unknown setting "${key}".`);
      continue;
    }

    // An explicit null or empty string means "unset this and fall back to
    // whichever layer is next", which is not the same as writing a zero.
    if (entry === null || entry === '') continue;

    switch (key) {
      case 'plan': {
        const plan = COPILOT_PLANS.find((candidate) => candidate === entry);
        if (plan !== undefined) value.plan = plan;
        else errors.push(`plan must be one of: ${COPILOT_PLANS.join(', ')}.`);
        break;
      }
      case 'monthlyAllowance': {
        if (typeof entry !== 'string' && typeof entry !== 'number') {
          errors.push('monthlyAllowance must be a number or "unlimited".');
          break;
        }
        try {
          // `null` from the parser means "no limit", stored as the word
          // rather than as an absent key — absent would fall through to the
          // layer below instead of overriding it.
          value.monthlyAllowance = parseAllowanceValue(entry, 'config') ?? 'unlimited';
        } catch (error) {
          errors.push(error instanceof Error ? error.message : 'Invalid monthly allowance.');
        }
        break;
      }
      case 'defaultScope': {
        const scope = SCOPES.find((candidate) => candidate === entry);
        if (scope) value.defaultScope = scope;
        else errors.push(`defaultScope must be one of: ${SCOPES.join(', ')}.`);
        break;
      }
      case 'defaultRange': {
        const range = RANGES.find((candidate) => candidate === entry);
        if (range !== undefined) value.defaultRange = range;
        else errors.push(`defaultRange must be one of: ${RANGES.join(', ')}.`);
        break;
      }
      case 'dashboardPort': {
        const port = Number(entry);
        // Below 1024 needs privileges on POSIX; above 65535 is not a port.
        if (Number.isInteger(port) && port >= 1024 && port <= 65535) value.dashboardPort = port;
        else errors.push('dashboardPort must be a whole number between 1024 and 65535.');
        break;
      }
      default:
        break;
    }
  }

  return { value, errors };
}

export interface SettingsStore {
  read(): Promise<EffectiveSettings>;
  write(layer: ConfigLayer, patch: TokenLensSettings): Promise<EffectiveSettings>;
}

/** Where a single settled value came from, most specific first. */
export type SettingsSource = 'env' | 'project-config' | 'user-config' | 'default';

export type SettingsSources = Readonly<Record<keyof TokenLensSettings, SettingsSource>>;

export const SETTINGS_SOURCE_LABEL: Readonly<Record<SettingsSource, string>> = {
  env: 'environment variable',
  'project-config': './.tokenlens/config.json',
  'user-config': '~/.tokenlens/config.json',
  default: 'built-in default',
};

/**
 * Names the layer that settled each field.
 *
 * The merge alone cannot answer "why is it this value", and every surface
 * needs to: the dashboard so a save that changes nothing is explicable, the
 * CLI so it can point at a file, and the extension so it does not present a
 * built-in default as configuration.
 */
function settingsSources(
  project: TokenLensSettings,
  user: TokenLensSettings,
  env: string | undefined,
): SettingsSources {
  const envApplies = env !== undefined && env.trim() !== '';
  const sourceOf = (key: keyof TokenLensSettings): SettingsSource => {
    if (key === 'monthlyAllowance' && envApplies) return 'env';
    if (project[key] !== undefined) return 'project-config';
    if (user[key] !== undefined) return 'user-config';
    return 'default';
  };

  return {
    plan: sourceOf('plan'),
    monthlyAllowance: sourceOf('monthlyAllowance'),
    defaultScope: sourceOf('defaultScope'),
    defaultRange: sourceOf('defaultRange'),
    dashboardPort: sourceOf('dashboardPort'),
  };
}

export interface EffectiveSettings {
  readonly effective: TokenLensSettings;
  readonly project: TokenLensSettings;
  readonly user: TokenLensSettings;
  readonly allowance: Allowance;
  readonly sources: SettingsSources;
  readonly paths: { readonly project: string; readonly user: string };
  /**
   * Set when an environment variable outranks the config file, so the page
   * can say that saving will not change the figure. Without this a user
   * saves, sees no change, and concludes the feature is broken — when in
   * fact it worked and something more specific won.
   */
  readonly overriddenByEnv?: string;
}

/**
 * Live settings for the dashboard.
 *
 * Deliberately re-reads on every request rather than caching: the config
 * file can be edited by hand or by the CLI while the server is running, and
 * a dashboard showing a value the CLI no longer agrees with is worse than
 * one that costs two small file reads.
 */
export function createSettingsStore(cwd: string = process.cwd()): SettingsStore {
  async function read(): Promise<EffectiveSettings> {
    const { merged, project, user } = await readMergedConfig<TokenLensSettings>({}, cwd);
    const plan: CopilotPlan = merged.plan ?? 'enterprise';
    const env = process.env.TOKENLENS_MONTHLY_ALLOWANCE;

    // Both layers are passed separately, not the merge, so the reported
    // source names the file the reader would actually have to edit.
    const allowance = resolveAllowance({
      plan,
      env,
      config: project.monthlyAllowance,
      userConfig: user.monthlyAllowance,
    });

    return {
      effective: merged,
      project,
      user,
      allowance,
      sources: settingsSources(project, user, env),
      paths: { project: configFilePath(cwd), user: userConfigFilePath() },
      ...(env !== undefined && env.trim() !== ''
        ? { overriddenByEnv: 'TOKENLENS_MONTHLY_ALLOWANCE' }
        : {}),
    };
  }

  /**
   * Merges a validated patch into one layer and writes it.
   *
   * Reads the target layer directly rather than the merge, so writing the
   * project file cannot silently copy the user layer's values into it and
   * freeze them there.
   */
  async function write(layer: ConfigLayer, patch: TokenLensSettings): Promise<EffectiveSettings> {
    const current =
      layer === 'user'
        ? await readUserConfig<TokenLensSettings>({})
        : await readConfig<TokenLensSettings>({}, cwd);

    const next = { ...current, ...patch };

    if (layer === 'user') await writeUserConfig(next);
    else await writeConfig(next, cwd);

    return read();
  }

  return { read, write };
}
