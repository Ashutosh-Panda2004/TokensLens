import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { openLedgerForReading } from '../context.js';
import { buildDetectContext } from '../../waste/context.js';
import { printHeading, printJson, printLine, printTable } from '../output.js';
import { formatCount, formatCredits, formatPercent } from '../../waste/format.js';
import { tokenLensDir } from '../../shared/config.js';
import {
  parsePolicyBuffer,
  stringifyPolicy,
  type NotSimulated,
  type Policy,
} from '../../simulate/policy.js';
import { recommendPolicy } from '../../simulate/optimiser.js';
import { buildSimulation, type LeverResult, type SimulationReport } from '../../simulate/report.js';
import { REALISATION } from '../../simulate/replay.js';
import type { CopilotPlan } from '../../ledger/budget.js';
import type { PrivacyContext } from '../../privacy/scope.js';

/** `simulate` reads this machine's own ledger, for the person sitting at it. */
const SELF: PrivacyContext = { scope: 'self', subjectCount: 1 };

const DEFAULT_POLICY_FILE = 'policy.yml';

interface SimulateCommandOptions {
  readonly policy?: string;
  readonly all?: boolean;
  readonly emitPolicy?: boolean;
  readonly explain?: string;
  readonly json?: boolean;
  readonly plan: string;
  readonly seats: string;
}

export function registerSimulateCommand(program: Command): void {
  program
    .command('simulate')
    .description('Replay recorded sessions under an alternative policy and price the difference.')
    .option('--policy <file>', `policy file to replay (default: .tokenlens/${DEFAULT_POLICY_FILE})`)
    .option('--all', 'derive a policy from this corpus and rank every lever by what it saves')
    .option('--emit-policy', 'print the derived policy as YAML instead of simulating it')
    .option('--explain <lever>', 'print the assumptions, risks and evidence behind one lever')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .option('--plan <plan>', 'business or enterprise', 'enterprise')
    .option('--seats <count>', 'seats to extrapolate the contract ceiling across', '1')
    .action(async (options: SimulateCommandOptions) => {
      const db = await openLedgerForReading();
      const { policy, notSimulated, source } = await resolvePolicy(db, options);

      if (options.emitPolicy) {
        printLine(stringifyPolicy(policy));
        return;
      }

      const report = buildSimulation(db, policy, {
        privacy: SELF,
        notSimulated,
        plan: parsePlan(options.plan),
        seats: Number.parseInt(options.seats, 10) || 1,
      });

      if (options.json) {
        printJson(report);
        return;
      }

      if (options.explain) {
        printExplanation(report, options.explain);
        return;
      }

      printReport(report, source);
    });
}

/**
 * `--all` derives the policy from the corpus; otherwise a file is read.
 *
 * The file is never silently defaulted away: if `--policy` was given and the
 * file is missing, that is an error, because running a *different* policy
 * from the one asked for and reporting a number would be worse than failing.
 */
async function resolvePolicy(
  db: Parameters<typeof buildDetectContext>[0],
  options: SimulateCommandOptions,
): Promise<{ policy: Policy; notSimulated: readonly NotSimulated[]; source: string }> {
  if (options.all || (options.emitPolicy && options.policy === undefined)) {
    return {
      policy: recommendPolicy(buildDetectContext(db)),
      notSimulated: [],
      source: 'derived from this corpus',
    };
  }

  const path = options.policy ?? join(tokenLensDir(), DEFAULT_POLICY_FILE);
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch {
    printLine(`No policy file at ${path}.`);
    printLine();
    printLine('Either write one, or start from a policy derived from your own measured data:');
    printLine(`  tokenlens simulate --emit-policy > ${path}`);
    printLine('  tokenlens simulate --all');
    process.exitCode = 1;
    return { policy: { version: 1 }, notSimulated: [], source: path };
  }

  const parsed = parsePolicyBuffer(buffer, { filePath: path });
  return { policy: parsed.policy, notSimulated: parsed.notSimulated, source: path };
}

function parsePlan(value: string): CopilotPlan {
  return value === 'business' ? 'business' : 'enterprise';
}

function band(lever: LeverResult): string {
  return `${formatCredits(lever.credits.low)} – ${formatCredits(lever.credits.high)}`;
}

function printReport(report: SimulationReport, source: string): void {
  printHeading('TokenLens — simulation');
  printLine(`policy:    ${source}`);
  printLine(
    `baseline:  ${formatCredits(report.baselineCredits)} credits over ${formatCount(report.requestCount)} request(s)`,
  );

  if (report.levers.length === 0) {
    printLine();
    printLine('This policy configures no lever that can be replayed, so it saves exactly nothing.');
    printNotSimulated(report);
    return;
  }

  printLine();
  printTable(
    report.levers.map((lever) => ({
      lever: lever.name,
      tier: lever.tier,
      requests: formatCount(lever.requestsAffected),
      'saving (credits)': band(lever),
      share: formatPercent(lever.shareOfBaseline),
    })),
  );

  printLine();
  printHeading('Combined — one replay, all levers');
  printLine(
    `saving:              ${formatCredits(report.combined.low)} – ${formatCredits(report.combined.high)} credits ` +
      `(${formatPercent(report.reduction.low)} – ${formatPercent(report.reduction.high)} of baseline)`,
  );
  printLine(
    `naive sum of levers: ${formatCredits(report.naiveSumCredits)} credits — not claimed, and not claimable`,
  );
  printLine(
    `overlap removed:     ${formatCredits(report.overlapCredits)} credits counted by more than one lever`,
  );
  printLine(
    `formula cross-check: ${formatCredits(report.multiplicativeEstimateCredits)} credits ` +
      '(1 − ∏(1 − tᵢ); the replay above needs no independence assumption and supersedes it)',
  );
  printLine();
  printLine(
    'The range is the realisation band, not a rounding: tier A is a setting nobody has to agree to, ' +
      `tier C is advice a person may ignore (A ${formatPercent(REALISATION.A.low, 0)}–${formatPercent(REALISATION.A.high, 0)}, ` +
      `B ${formatPercent(REALISATION.B.low, 0)}–${formatPercent(REALISATION.B.high, 0)}, ` +
      `C ${formatPercent(REALISATION.C.low, 0)}–${formatPercent(REALISATION.C.high, 0)}).`,
  );

  printCeiling(report);
  printRisks(report);
  printNotSimulated(report);

  printLine();
  printLine(
    `Run \`tokenlens simulate --explain ${report.levers[0]?.id ?? 'model-routing'}\` for the assumptions and evidence behind any lever.`,
  );
}

/**
 * The section that stops a reduction being read as cash. Printed always,
 * including when the policy stays well under the ceiling — a constraint
 * disclosed only when it bites looks like one that was being hidden.
 */
function printCeiling(report: SimulationReport): void {
  const { ceiling, cash } = report;

  printLine();
  printHeading('What that is worth against the contract');
  printLine(`plan:                ${ceiling.plan} × ${formatCount(ceiling.seats)} seat(s)`);
  printLine(`included allowance:  ${formatCredits(ceiling.includedCredits)} credits/month`);
  printLine(`projected run-rate:  ${formatCredits(ceiling.projectedMonthlyCredits)} credits/month`);

  if (ceiling.overageCredits <= 0) {
    printLine('billable overage:    none — this spend sits inside the included allowance.');
    printLine();
    printLine(
      'Every credit this policy saves is therefore allowance that goes unused, not money off an invoice. ' +
        'It still buys headroom, and headroom is worth having, but it is not a cash saving and is not reported as one.',
    );
    return;
  }

  printLine(
    `billable overage:    ${formatCredits(ceiling.overageCredits)} credits/month — the entire cash pool`,
  );
  if (ceiling.reductionThatEliminatesOverage !== undefined) {
    printLine(
      `ceiling:             a ${formatPercent(ceiling.reductionThatEliminatesOverage)} reduction eliminates the overage entirely. Beyond that, savings stop being cash.`,
    );
  }

  printLine();
  printLine(
    `cash saving:         ${formatCredits(cash.low.cashCredits)} – ${formatCredits(cash.high.cashCredits)} credits/month ` +
      `(${formatPercent(cash.low.shareOfMaxCashSaving)} – ${formatPercent(cash.high.shareOfMaxCashSaving)} of the maximum achievable)`,
  );

  if (cash.high.exceedsCeiling) {
    printLine(
      `unused allowance:    ${formatCredits(cash.high.unusedAllowanceCredits)} credits/month at the top of the band — ` +
        'saved, but not billable, and deliberately not counted as cash.',
    );
  }

  if (ceiling.seats > 1) {
    printLine();
    printLine(
      `⚠ ${formatCount(ceiling.seats)} seats were extrapolated from one machine's measured run-rate. ` +
        'That assumes every other seat spends like this one, which is an assumption, not a measurement.',
    );
  }
}

function printRisks(report: SimulationReport): void {
  const warnings = report.levers.flatMap((lever) =>
    lever.risks.filter((risk) => risk.severity === 'warning').map((risk) => ({ lever, risk })),
  );
  if (warnings.length === 0) return;

  printLine();
  printHeading('What this policy costs you');
  for (const { lever, risk } of warnings) {
    printLine(`· [${lever.name}] ${risk.text}`);
  }
}

function printNotSimulated(report: SimulationReport): void {
  if (report.notSimulated.length === 0) return;

  printLine();
  printLine(
    `${String(report.notSimulated.length)} policy line(s) were understood but could not be costed:`,
  );
  for (const item of report.notSimulated) {
    printLine(`  ${item.at} — ${item.reason}`);
    printLine(`    unblocked by: ${item.unblockedBy}`);
  }
  printLine();
  printLine(
    'These are reported rather than dropped: a line silently ignored would show a zero saving, ' +
      'which reads as "this does not help" instead of "this was not measured".',
  );
}

function printExplanation(report: SimulationReport, wanted: string): void {
  const lever = report.levers.find((entry) => entry.id === wanted.toLowerCase());
  if (!lever) {
    printLine(`No lever \`${wanted}\` in this simulation.`);
    printLine(`Configured levers: ${report.levers.map((entry) => entry.id).join(', ') || 'none'}`);
    return;
  }

  printHeading(`${lever.id} · ${lever.name}`);
  printLine(`tier:       ${lever.tier}`);
  printLine(`action:     ${lever.action}`);
  printLine(
    `requests:   ${formatCount(lever.requestsAffected)} of ${formatCount(report.requestCount)}`,
  );
  printLine(
    `saving:     ${band(lever)} credits (${formatCredits(lever.credits.theoretical)} at full adoption)`,
  );

  printLine();
  printLine('assumptions:');
  for (const assumption of lever.assumptions) printLine(`  · ${assumption}`);

  if (lever.risks.length > 0) {
    printLine();
    printLine('risks:');
    for (const risk of lever.risks) {
      printLine(`  ${risk.severity === 'warning' ? '⚠' : '·'} ${risk.text}`);
    }
  }

  printLine();
  printLine('evidence:');
  for (const item of lever.evidence) {
    printLine(`  [${item.kind}] ${item.ref}`);
    printLine(`      ${item.detail}`);
  }
}
