import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { detectChannel, type ChannelDetection } from './channel.js';
import { resolveSettings } from './keys.js';
import type { Policy } from '../simulate/policy.js';

export type VerificationStatus =
  /** The intended value is the effective value. */
  | 'applied'
  /** The channel was readable and the setting is not there. */
  | 'missing'
  /** Something else is in effect. */
  | 'differs'
  /** The channel that would carry it cannot be read from here. */
  | 'unverifiable';

export interface VerificationLine {
  readonly settingId: string;
  readonly surface: 'managed' | 'workspace' | 'agent';
  readonly intended: string;
  readonly effective: string | undefined;
  readonly status: VerificationStatus;
  readonly detail: string;
}

export interface PolicyVerification {
  readonly detection: ChannelDetection;
  readonly lines: readonly VerificationLine[];
  /** True only when every line that *could* be checked came back `applied`. */
  readonly ok: boolean;
  readonly unverifiable: number;
}

export interface VerifyPolicyOptions {
  readonly detection?: ChannelDetection;
  readonly cwd?: string;
}

/**
 * Re-reads the machine after a deployment and asserts that the intended
 * values are the **effective** ones (DEVELOPMENT-PLAN.md D5.9).
 *
 * ## Why this command exists at all
 *
 * Managed Settings precedence is winner-take-all. A payload written to a
 * losing channel deploys cleanly, reports success, and does nothing. There
 * is no error anywhere in that sequence — the only way to find out is to
 * look at what is actually in effect afterwards, which is what this does.
 *
 * `unverifiable` is a first-class outcome and is never folded into `ok`.
 * Server-managed settings leave no local artefact, so on a machine governed
 * that way this command can honestly report almost nothing, and saying so
 * is more useful than a green tick that means "found no evidence either
 * way".
 */
export async function verifyPolicy(
  policy: Policy,
  options: VerifyPolicyOptions = {},
): Promise<PolicyVerification> {
  const detection = options.detection ?? (await detectChannel());
  const { settings } = resolveSettings(policy);
  const cwd = options.cwd ?? process.cwd();

  const activeEvidence = detection.evidence.find((item) => item.channel === detection.active);
  const managedValues = activeEvidence?.values;
  const workspaceValues = await readWorkspaceSettings(join(cwd, '.vscode', 'settings.json'));

  const lines = settings.map((setting): VerificationLine => {
    const intended =
      typeof setting.value === 'string' ? setting.value : JSON.stringify(setting.value);

    if (setting.key.surface === 'managed') {
      if (managedValues === undefined) {
        return {
          settingId: setting.key.managedName ?? setting.key.id,
          surface: 'managed',
          intended,
          effective: undefined,
          status: 'unverifiable',
          detail:
            detection.active === undefined
              ? 'No managed channel is observable from this machine. Run `Developer: Policy Diagnostics` in VS Code.'
              : `The active channel (${detection.active}) does not expose its values to this process.`,
        };
      }
      const raw = managedValues[setting.key.managedName ?? ''];
      const effective =
        raw === undefined ? undefined : typeof raw === 'string' ? raw : JSON.stringify(raw);
      return {
        settingId: setting.key.managedName ?? setting.key.id,
        surface: 'managed',
        intended,
        effective,
        status:
          effective === undefined ? 'missing' : effective === intended ? 'applied' : 'differs',
        detail:
          effective === undefined
            ? `Not present in the active ${String(detection.active)} channel.`
            : effective === intended
              ? 'Intended value is the effective value.'
              : `Effective value is "${effective}", not "${intended}".`,
      };
    }

    const id = setting.key.settingId ?? setting.key.id;
    if (workspaceValues === undefined) {
      return {
        settingId: id,
        surface: 'workspace',
        intended,
        effective: undefined,
        status: 'unverifiable',
        detail: 'No readable .vscode/settings.json in this workspace.',
      };
    }

    const raw = workspaceValues[id];
    const effective =
      raw === undefined ? undefined : typeof raw === 'string' ? raw : JSON.stringify(raw);
    return {
      settingId: id,
      surface: 'workspace',
      intended,
      effective,
      status: effective === undefined ? 'missing' : effective === intended ? 'applied' : 'differs',
      detail:
        effective === undefined
          ? 'Not present in .vscode/settings.json.'
          : effective === intended
            ? 'Intended value is the effective value.'
            : `Effective value is ${effective}, not ${intended}.`,
    };
  });

  const unverifiable = lines.filter((line) => line.status === 'unverifiable').length;

  return {
    detection,
    lines,
    // A line nobody could check is not a line that passed.
    ok: lines.length > 0 && lines.every((line) => line.status === 'applied'),
    unverifiable,
  };
}

async function readWorkspaceSettings(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
