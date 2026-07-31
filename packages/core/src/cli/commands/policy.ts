import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import { printHeading, printJson, printLine, printTable } from '../output.js';
import { formatCredits } from '../../waste/format.js';
import { assertContained } from '../../shared/safe.js';
import { tokenLensDir } from '../../shared/config.js';
import { parsePolicyBuffer, type Policy } from '../../simulate/policy.js';
import { recommendPolicy } from '../../simulate/optimiser.js';
import { buildDetectContext } from '../../waste/context.js';
import { detectChannel, CHANNEL_PRECEDENCE, type ManagedChannel } from '../../policy/channel.js';
import { emitPolicy, type PolicyEmission, type PolicyLine } from '../../policy/emit.js';
import { verifyPolicy } from '../../policy/verify.js';

const DEFAULT_POLICY_FILE = 'policy.yml';
const DEFAULT_OUT_DIR = 'tokenlens-policy';

interface EmitOptions {
  readonly policy?: string;
  readonly channel?: string;
  readonly out?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

interface DetectOptions {
  readonly json?: boolean;
}

export function registerPolicyCommand(program: Command): void {
  const policy = program
    .command('policy')
    .description('Compile a measured policy into the artefact your platform team deploys.');

  policy
    .command('detect')
    .description('Report which managed-settings channel is in effect on this machine.')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: DetectOptions) => {
      const detection = await detectChannel();

      if (options.json) {
        printJson(detection);
        return;
      }

      printHeading('TokenLens — managed-settings channel');
      printLine(`platform: ${detection.platform}`);
      printLine();
      printTable(
        detection.evidence.map((item) => ({
          channel: item.channel,
          status: item.status,
          where: item.where,
        })),
      );

      printLine();
      for (const item of detection.evidence) {
        printLine(`${item.channel}: ${item.detail}`);
      }

      printLine();
      printLine(
        detection.active === undefined
          ? 'No managed-settings channel is currently delivering Copilot policy on this machine.'
          : `Active channel: ${detection.active} — it outranks ${CHANNEL_PRECEDENCE.slice(
              CHANNEL_PRECEDENCE.indexOf(detection.active) + 1,
            ).join(' and ')}.`,
      );
      if (detection.uncertain) {
        printLine();
        printLine(`⚠ ${detection.caveat}`);
      }
    });

  policy
    .command('emit')
    .description('Compile the policy into deployable artefacts, with the credits each line saves.')
    .option(
      '--policy <file>',
      `policy file to compile (default: .tokenlens/${DEFAULT_POLICY_FILE})`,
    )
    .option('--channel <channel>', 'native-mdm, server-managed or file-based (default: detected)')
    .option('--out <dir>', `write artefacts here (default: ./${DEFAULT_OUT_DIR})`)
    .option('--dry-run', 'print the diff and the credit impact without writing anything')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: EmitOptions) => {
      const db = await openLedgerForReading();
      const resolved = await loadPolicy(db, options.policy);
      if (!resolved) return;

      const emission = await emitPolicy(db, resolved.policy, {
        ...(options.channel !== undefined ? { channel: parseChannel(options.channel) } : {}),
      });

      if (options.json) {
        printJson(emission);
        return;
      }

      printEmission(emission, resolved.source);

      if (options.dryRun) {
        printLine();
        printLine('Dry run — nothing was written. Re-run without --dry-run to produce the files.');
        return;
      }

      const outDir = resolve(options.out ?? DEFAULT_OUT_DIR);
      await writeArtefacts(emission, outDir);

      printLine();
      printHeading('Written');
      for (const artefact of emission.artefacts) {
        printLine(
          `  ${artefact.role === 'rollback' ? '↩' : '·'} ${artefact.path} — ${artefact.description}`,
        );
      }
      printLine();
      printLine(`Artefacts are in ${outDir}. Nothing on this machine was changed.`);
      printLine(
        'Deploy them through review, never by copying them into place directly — and keep the rollback files, ' +
          'which were generated from the state this machine was in before the change.',
      );
    });

  policy
    .command('verify')
    .description('Check whether the intended values are the effective values after a deploy.')
    .option('--policy <file>', `policy file to verify (default: .tokenlens/${DEFAULT_POLICY_FILE})`)
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: EmitOptions) => {
      const db = await openLedgerForReading();
      const resolved = await loadPolicy(db, options.policy);
      if (!resolved) return;

      const verification = await verifyPolicy(resolved.policy);

      if (options.json) {
        printJson(verification);
        return;
      }

      printHeading('TokenLens — policy verification');
      if (verification.lines.length === 0) {
        printLine(
          'This policy contains no setting that could be deployed, so there is nothing to verify.',
        );
        return;
      }

      printTable(
        verification.lines.map((line) => ({
          setting: line.settingId,
          surface: line.surface,
          intended: line.intended,
          effective: line.effective ?? '—',
          status: line.status,
        })),
      );

      printLine();
      for (const line of verification.lines) {
        if (line.status !== 'applied') printLine(`${line.settingId}: ${line.detail}`);
      }

      printLine();
      if (verification.ok) {
        printLine('✓ Every setting in this policy is in effect.');
      } else if (verification.unverifiable === verification.lines.length) {
        printLine(
          '⚠ Nothing could be verified from this machine. That is not a failure and not a pass — ' +
            'server-managed settings leave no local artefact. Run `Developer: Policy Diagnostics` in VS Code.',
        );
        process.exitCode = 1;
      } else {
        printLine(
          `⚠ ${String(verification.lines.filter((l) => l.status !== 'applied').length)} of ` +
            `${String(verification.lines.length)} setting(s) are not in effect. ` +
            'The most common cause is emitting to a channel that a higher-precedence one overrides.',
        );
        process.exitCode = 1;
      }
    });
}

async function loadPolicy(
  db: Parameters<typeof buildDetectContext>[0],
  file: string | undefined,
): Promise<{ policy: Policy; source: string } | undefined> {
  const path = file ?? join(tokenLensDir(), DEFAULT_POLICY_FILE);

  try {
    const parsed = parsePolicyBuffer(await readFile(path), { filePath: path });
    return { policy: parsed.policy, source: path };
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  if (file !== undefined) {
    printLine(`No policy file at ${path}.`);
    process.exitCode = 1;
    return undefined;
  }

  // No file and none asked for: compile the policy the measurement itself
  // recommends, so the command is useful before anyone has written one.
  printLine(
    `No policy file at ${path} — compiling the policy derived from your own measured data.`,
  );
  printLine(`Run \`tokenlens simulate --emit-policy > ${path}\` to pin it and edit it.`);
  return { policy: recommendPolicy(buildDetectContext(db)), source: 'derived from this corpus' };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

function parseChannel(value: string): ManagedChannel {
  const match = CHANNEL_PRECEDENCE.find((channel) => channel === value);
  if (!match) {
    throw new Error(
      `Unknown channel "${value}". Expected one of: ${CHANNEL_PRECEDENCE.join(', ')}.`,
    );
  }
  return match;
}

function creditsOf(line: PolicyLine): string {
  return line.credits === undefined
    ? 'not priced'
    : `${formatCredits(line.credits.low)}–${formatCredits(line.credits.high)}`;
}

function printEmission(emission: PolicyEmission, source: string): void {
  printHeading('TokenLens — policy compiler');
  printLine(`policy:   ${source}`);
  printLine(`channel:  ${emission.channel}`);

  const changing = emission.lines.filter((line) => line.changes);
  const unchanged = emission.lines.length - changing.length;

  printLine();
  if (emission.lines.length === 0) {
    // Distinct from "nothing would change": this policy contains no line a
    // *setting* can carry, which is a statement about the policy rather
    // than about the machine. The savings it does carry are listed below.
    printLine(
      'This policy contains no line that a managed or workspace setting can express. ' +
        'What it does deliver is listed below — including the agent files, which are themselves a fleet deployment.',
    );
  } else if (changing.length === 0) {
    printLine('Every setting in this policy is already in effect. Nothing would change.');
  } else {
    printTable(
      changing.map((line) => ({
        setting: line.settingId,
        now: line.current ?? '(unset)',
        after: line.desired,
        credits: creditsOf(line),
        automation: line.automation,
        attacks: line.attacks,
      })),
    );
    if (unchanged > 0) {
      printLine();
      printLine(
        `${String(unchanged)} setting(s) already hold the intended value and are unchanged.`,
      );
    }
  }

  const unpriced = changing.filter((line) => line.credits === undefined);
  if (unpriced.length > 0) {
    printLine();
    printLine(
      `${String(unpriced.length)} line(s) are marked "not priced". They are still worth deploying — ` +
        'the saving could not be measured from this corpus, which is not the same as it being zero.',
    );
  }

  if (emission.carriedElsewhere.length > 0) {
    printLine();
    printHeading('Measured savings no setting can deliver');
    for (const entry of emission.carriedElsewhere) {
      printLine(
        `· ${entry.lever} — ${formatCredits(entry.credits.low)}–${formatCredits(entry.credits.high)} credits`,
      );
      printLine(`    carried by: ${entry.carriedBy}`);
    }
  }

  if (emission.deferred.length > 0) {
    printLine();
    printHeading('Policy lines this phase does not emit');
    for (const entry of emission.deferred) {
      printLine(`· ${entry.at} — ${entry.reason}`);
      printLine(`    enforced by: ${entry.enforcedBy}`);
    }
  }

  if (emission.agents.agents.length > 0) {
    printLine();
    printHeading('Generated agents');
    printTable(
      emission.agents.agents.map((agent) => ({
        agent: agent.name,
        tools: agent.tools.length,
        model: agent.model ?? '(inherits)',
        requests: agent.requestsCovered,
      })),
    );
    printLine();
    printLine(
      `These cover ${(emission.agents.coverage * 100).toFixed(1)}% of tool-using requests. ` +
        'They describe what happened, not what should happen — narrowing them further is the point.',
    );
  }
  for (const caveat of emission.agents.caveats) printLine(`  · ${caveat}`);

  if (emission.skipped.length > 0) {
    printLine();
    printHeading('Surfaces skipped');
    for (const entry of emission.skipped) printLine(`⚠ ${entry}`);
  }

  if (emission.detection.uncertain) {
    printLine();
    printLine(`⚠ ${emission.detection.caveat}`);
  }
}

/**
 * Writes artefacts under `outDir`, with every path re-checked against it.
 *
 * The paths are generated rather than user-supplied, so containment is
 * belt-and-braces — but the whole point of `assertContained` is that it does
 * not depend on the caller having reasoned correctly about its inputs.
 */
async function writeArtefacts(emission: PolicyEmission, outDir: string): Promise<void> {
  for (const artefact of emission.artefacts) {
    const target = assertContained(outDir, artefact.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artefact.contents, 'utf8');
  }
}
