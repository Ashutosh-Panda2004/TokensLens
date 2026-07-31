import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { printHeading, printJson, printLine, printTable } from '../output.js';
import { formatCount, formatCredits, formatPercent } from '../../waste/format.js';
import { loadOrCreateInstallSalt } from '../../ingest/redact.js';
import { openLedgerForReading } from '../context.js';
import { buildLedger } from '../../ledger/ledger.js';
import { getAllRequests } from '../../store/database.js';
import { assignHoldout, parseRoster, type HoldoutDesign } from '../../holdout/assignment.js';
import {
  assessFeasibility,
  assessPower,
  DEFAULT_ALPHA,
  DEFAULT_POWER,
} from '../../holdout/power.js';
import { buildPreregistration, checkRegistration } from '../../holdout/preregistration.js';
import {
  checkIntegrity,
  readHoldout,
  writeHoldout,
  type HoldoutRecord,
} from '../../holdout/store.js';
import { analyseHoldout, type HoldoutAnalysis } from '../../holdout/analysis.js';
import { measureOverrides } from '../../holdout/override.js';
import { assessRollback } from '../../holdout/rollback.js';
import { buildSavingsPnl, type PnlInput } from '../../holdout/pnl.js';
import {
  COST_EFFICIENCY_WARNING,
  evaluateGuardrails,
  type MetricObservation,
} from '../../holdout/metrics.js';
import { measureDurability } from '../../outcomes/durability.js';
import { readGitHistory } from '../../outcomes/git.js';
import { isGitRepository } from '../../outcomes/report.js';
import { parsePolicyBuffer } from '../../simulate/policy.js';

interface AssignOptions {
  readonly roster: string;
  readonly fraction: string;
  readonly seed: string;
  readonly horizon: string;
  readonly periodDays: string;
  readonly force?: boolean;
  readonly json?: boolean;
}

interface AnalyseOptions {
  readonly since?: string;
  readonly horizon: string;
  readonly periodDays: string;
  readonly json?: boolean;
}

interface PnlOptions {
  readonly input: string;
  readonly json?: boolean;
}

interface OverrideOptions {
  readonly policy: string;
  readonly json?: boolean;
}

/**
 * **Phase D8 — the commands that make the rest of TokenLens believable.**
 *
 * Everything else in this product answers *"what would happen if"*. These
 * four answer *"did it"*, and the difference is a control group that was
 * chosen before anyone saw a result.
 */
export function registerHoldoutCommand(program: Command): void {
  const holdout = program
    .command('holdout')
    .description(
      'Randomised holdout: design it, register it, and measure what the policy actually did.',
    );

  holdout
    .command('assign')
    .description('Draw a stratified randomised holdout and write the pre-registration.')
    .requiredOption(
      '--roster <file>',
      'CSV of `identifier,team,pre-period-credits`. Identifiers are hashed on read',
    )
    .option('--fraction <share>', 'share held out', '0.15')
    .option('--seed <n>', 'randomisation seed, recorded in the registration', '20260801')
    .option('--horizon <days>', 'days a change must survive to count', '30')
    .option('--period-days <days>', 'days per panel period', '7')
    .option('--force', 'overwrite an existing design — discards the pre-registration')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: AssignOptions) => {
      const cwd = process.cwd();
      const salt = await loadOrCreateInstallSalt(cwd);

      let roster: string;
      try {
        roster = await readFile(options.roster, 'utf8');
      } catch {
        printLine(`Could not read ${options.roster}.`);
        process.exitCode = 1;
        return;
      }

      const units = parseRoster(roster, salt);
      if (units.length === 0) {
        printLine(
          `No usable rows in ${options.roster}. Expected lines of \`identifier,team,credits\`.`,
        );
        process.exitCode = 1;
        return;
      }

      const design = assignHoldout(units, {
        holdoutFraction: Number.parseFloat(options.fraction) || 0.15,
        seed: Number.parseInt(options.seed, 10) || 0,
      });

      const preregistration = buildPreregistration({
        design,
        horizonDays: Number.parseInt(options.horizon, 10) || 30,
        periodDays: Number.parseInt(options.periodDays, 10) || 7,
        alpha: DEFAULT_ALPHA,
        power: DEFAULT_POWER,
      });

      const record: HoldoutRecord = { version: 1, design, preregistration };
      const path = await writeHoldout(record, cwd, { force: options.force === true });

      if (options.json) {
        printJson({ path, ...record });
        return;
      }
      printDesign(design, path, preregistration.hash);
    });

  holdout
    .command('status')
    .description('Show the current design, its registration hash, and whether it is intact.')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: { readonly json?: boolean }) => {
      const record = await readHoldout();
      if (!record) {
        printLine(
          'No holdout design in this workspace. Run `tokenlens holdout assign --roster <file>`.',
        );
        printLine();
        printLine(
          'Without one, the strongest claim available is a before/after comparison, which cannot ' +
            'separate a policy from a quarter.',
        );
        process.exitCode = 1;
        return;
      }

      const integrity = checkIntegrity(record);
      if (options.json) {
        printJson({ ...record, integrity });
        return;
      }

      printDesign(record.design, undefined, record.preregistration.hash);
      printLine();
      printHeading(integrity.intact ? 'Registration' : '⚠ Registration');
      printLine(integrity.detail);
      printLine(`registered:  ${record.preregistration.registration.registeredAt.slice(0, 19)}`);
      printLine(`deployed:    ${record.deployedAt ?? 'not yet — run `tokenlens holdout deploy`'}`);
      printLine();
      printHeading('Stopping rules, agreed in advance');
      for (const rule of record.preregistration.registration.stoppingRules) printLine(`· ${rule}`);
    });

  holdout
    .command('deploy')
    .description('Record the moment the policy was pushed. The estimator needs a treatment date.')
    .action(async () => {
      const record = await readHoldout();
      if (!record) {
        printLine('No holdout design to deploy against.');
        process.exitCode = 1;
        return;
      }
      if (record.deployedAt !== undefined) {
        printLine(`Already recorded as deployed at ${record.deployedAt}.`);
        printLine(
          'The deployment date is not amended once set: moving it after seeing results would move the ' +
            'pre-period boundary, which is the least visible way to change an answer.',
        );
        process.exitCode = 1;
        return;
      }
      const deployedAt = new Date().toISOString();
      await writeHoldout({ ...record, deployedAt }, process.cwd(), { force: true });
      printLine(`Deployment recorded at ${deployedAt}.`);
      printLine('From here on, treated units are treated and the pre-period is closed.');
    });

  holdout
    .command('analyse')
    .description('Estimate what the policy did, with the caveats printed before the number.')
    .option('--since <date>', 'only consider history after this date')
    .option('--horizon <days>', 'days a change must survive to count', '30')
    .option('--period-days <days>', 'days per panel period', '7')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: AnalyseOptions) => {
      const cwd = process.cwd();
      const record = await readHoldout(cwd);
      if (!record) {
        printLine('No holdout design in this workspace. Run `tokenlens holdout assign` first.');
        process.exitCode = 1;
        return;
      }
      if (!(await isGitRepository(cwd))) {
        printLine('Not a git repository, so there are no outcomes to measure.');
        process.exitCode = 1;
        return;
      }

      const salt = await loadOrCreateInstallSalt(cwd);
      const commits = await readGitHistory(
        { cwd, ...(options.since !== undefined ? { since: new Date(options.since) } : {}) },
        salt,
      );
      const durability = measureDurability(commits, {
        horizonDays: Number.parseInt(options.horizon, 10) || 30,
      });

      const registration = checkRegistration(
        record.preregistration,
        record.preregistration.registration,
      );

      const analysis = analyseHoldout({
        assignments: record.design.assignments,
        changes: durability.changes,
        deployedAt: record.deployedAt === undefined ? undefined : Date.parse(record.deployedAt),
        periodDays: Number.parseInt(options.periodDays, 10) || 7,
        registration,
        observations: await ledgerObservations(record),
      });

      if (options.json) {
        printJson(analysis);
        return;
      }
      printAnalysis(analysis);
    });

  holdout
    .command('overrides')
    .description('AUTO-25 — are developers switching back off the routed model?')
    .requiredOption('--policy <file>', 'the deployed policy file')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: OverrideOptions) => {
      const record = await readHoldout();
      const parsed = parsePolicyBuffer(await readFile(options.policy), {
        filePath: options.policy,
      });
      const db = await openLedgerForReading();
      const requests = getAllRequests(db);

      const since = record?.deployedAt === undefined ? undefined : Date.parse(record.deployedAt);
      const report = measureOverrides(
        requests,
        parsed.policy,
        since === undefined ? {} : { since },
      );

      if (options.json) {
        printJson(report);
        return;
      }

      printHeading('TokenLens — model override monitor (AUTO-25)');
      printLine(`routed model: ${report.routedModel ?? 'none set by this policy'}`);
      printLine(
        `requests:     ${formatCount(report.requestsConsidered)}` +
          (since === undefined
            ? ' (all history — no deployment date recorded)'
            : ' since deployment'),
      );
      printLine(
        `override rate: ${report.overrideRate === undefined ? '—' : formatPercent(report.overrideRate)}`,
      );
      printLine();
      printTable(
        report.byModel.map((row) => ({
          model: row.model,
          requests: formatCount(row.requests),
          share: formatPercent(row.share),
        })),
      );
      printLine();
      printLine(report.detail);
    });

  holdout
    .command('rollback')
    .description('AUTO-26 — check the guardrails and revert without asking if one has broken.')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: { readonly json?: boolean }) => {
      const record = await readHoldout();
      if (!record) {
        printLine('No holdout design, so there are no guardrails to check.');
        process.exitCode = 1;
        return;
      }

      const assessment = assessRollback(
        evaluateGuardrails(await ledgerObservations(record)).breaches,
      );
      if (options.json) {
        printJson(assessment);
        return;
      }

      printHeading(
        assessment.decision === 'revert' ? '⚠ TokenLens — rollback' : 'TokenLens — rollback',
      );
      printLine(assessment.detail);
      if (assessment.manualActionRequired !== undefined) {
        printLine();
        printLine(assessment.manualActionRequired);
        process.exitCode = 1;
      }
      for (const breach of assessment.breaches) printLine(`· ${breach.detail}`);
    });

  holdout
    .command('pnl')
    .description('D8.9 — realised saving against simulated, and the gap between them.')
    .requiredOption(
      '--input <file>',
      'JSON array of {month, simulatedCredits, treatedMeanCredits, holdoutMeanCredits, treatedUnits, holdoutUnits}',
    )
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: PnlOptions) => {
      let rows: PnlInput[];
      try {
        rows = JSON.parse(await readFile(options.input, 'utf8')) as PnlInput[];
      } catch {
        printLine(`Could not read ${options.input} as JSON.`);
        process.exitCode = 1;
        return;
      }

      const pnl = buildSavingsPnl(rows);
      if (options.json) {
        printJson(pnl);
        return;
      }

      printHeading('TokenLens — savings P&L');
      printTable(
        pnl.rows.map((row) => ({
          month: row.month,
          simulated: formatCredits(row.simulatedCredits),
          realised: row.estimable ? formatCredits(row.realisedCredits) : 'not estimable',
          gap: row.estimable ? formatCredits(row.gapCredits) : '—',
        })),
      );
      printLine();
      printLine(
        `simulated ${formatCredits(pnl.simulatedCredits)} · realised ${formatCredits(pnl.realisedCredits)} · ` +
          `gap ${formatCredits(pnl.gapCredits)}`,
      );
      printLine();
      printLine(pnl.detail);
      if (pnl.defect !== undefined) {
        printLine();
        printHeading('⚠ Reported as a TokenLens defect');
        printLine(pnl.defect);
      }
    });
}

/**
 * The only metrics available without a fleet collector: cost-centre mix and
 * the override rate come from this machine's ledger. Throughput, cycle time
 * and revert rate need git, and are supplied by `analyse`. Anything not
 * supplied is reported as unobserved, never as zero.
 */
async function ledgerObservations(record: HoldoutRecord): Promise<MetricObservation[]> {
  const db = await openLedgerForReading();
  const ledger = buildLedger(db);
  const deployedAt = record.deployedAt === undefined ? undefined : Date.parse(record.deployedAt);
  if (deployedAt === undefined || ledger.requestCount === 0) return [];

  const requests = getAllRequests(db);
  const before = requests.filter((r) => r.ts < deployedAt);
  const after = requests.filter((r) => r.ts >= deployedAt);
  if (before.length === 0 || after.length === 0) return [];

  const creditsOf = (rows: typeof requests): number =>
    rows.reduce((sum, row) => sum + (row.credits ?? 0), 0) / Math.max(1, rows.length);

  return [
    {
      metric: 'credits-per-durable-change',
      baseline: creditsOf(before),
      current: creditsOf(after),
      observations: after.length,
    },
  ];
}

function printDesign(design: HoldoutDesign, path: string | undefined, hash: string): void {
  printHeading('TokenLens — randomised holdout');
  if (path !== undefined) printLine(`written to: ${path}`);
  printLine(`units:      ${formatCount(design.assignments.length)}`);
  printLine(
    `holdout:    ${formatCount(design.balance.holdoutUnits)} ` +
      `(${formatPercent(design.holdoutFraction)} target) · treated ${formatCount(design.balance.treatedUnits)}`,
  );
  printLine(`strata:     ${formatCount(design.balance.strata.length)} (${design.dimensions})`);
  printLine(`seed:       ${String(design.seed)}`);
  printLine(`hash:       ${hash}`);
  printLine();
  printLine(design.dimensionsDetail);

  printLine();
  printHeading(design.balance.balanced ? 'Balance check — passed' : '⚠ Balance check — FAILED');
  printLine(design.balance.detail);
  printLine(
    `holdout holds ${formatPercent(design.balance.holdoutSpendShare)} of pre-period spend and ` +
      `${formatPercent(design.balance.holdoutHeadcountShare)} of headcount.`,
  );
  if (design.balance.concentrationWarning !== undefined) {
    printLine();
    printLine(`⚠ ${design.balance.concentrationWarning}`);
  }

  const power = assessPower({
    standardDeviation: standardDeviationOf(design.assignments.map((a) => a.preSpend)),
    treatedUnits: design.balance.treatedUnits,
    holdoutUnits: design.balance.holdoutUnits,
    baseline: design.balance.treatedMeanSpend,
  });

  printLine();
  printHeading('What this design can detect');
  printLine(power.detail);
  printLine();
  printLine(
    'Computed now, before any result exists. An experiment that cannot see the effect it is looking for ' +
      'will return an interval straddling zero, and that will be read as "it did not work".',
  );

  const feasibility = assessFeasibility(
    power,
    design.balance.treatedMeanSpend * 0.2,
    standardDeviationOf(design.assignments.map((a) => a.preSpend)),
  );
  printLine();
  printLine(`Against a 20% saving: ${feasibility.feasible ? 'detectable.' : 'not detectable.'}`);
  if (!feasibility.feasible) printLine(feasibility.detail);
}

function printAnalysis(analysis: HoldoutAnalysis): void {
  printHeading('TokenLens — holdout analysis');

  // Order matters: each of these can invalidate the estimate, and each is
  // easier to accept before the number is on screen.
  if (analysis.registration) {
    printHeading(
      analysis.registration.status === 'registered' ? 'Pre-registration' : '⚠ Pre-registration',
    );
    printLine(analysis.registration.detail);
    for (const difference of analysis.registration.differences) printLine(`  · ${difference}`);
    printLine();
  }

  printHeading(analysis.balance.balanced ? 'Balance' : '⚠ Balance');
  printLine(analysis.balance.detail);
  printLine();

  printHeading('Power');
  printLine(analysis.power.detail);
  printLine();

  printHeading('Primary metric — human effort per durable change');
  printLine(analysis.primary.detail);
  printLine();
  printLine(COST_EFFICIENCY_WARNING);

  if (analysis.secondary.length > 0) {
    printLine();
    printHeading('Secondary metrics and guardrails');
    printTable(
      analysis.secondary.map((row) => ({
        metric: row.metric,
        p: row.pValue === undefined ? '—' : row.pValue.toFixed(4),
        q: row.qValue === undefined ? '—' : row.qValue.toFixed(4),
        claimable: row.significant ? 'yes' : 'no',
      })),
    );
    printLine();
    printLine(
      'q-values are Benjamini–Hochberg adjusted across every secondary metric and guardrail. Testing ten ' +
        'metrics at 0.05 produces a spurious finding about 40% of the time, and it is always the one that ' +
        'ends up in the deck.',
    );
  }

  printLine();
  printHeading(analysis.guardrails.breaches.length > 0 ? '⚠ Guardrails' : 'Guardrails');
  if (analysis.guardrails.breaches.length === 0) {
    printLine(
      `${formatCount(analysis.guardrails.assessed.length)} assessed, none breached. ` +
        `${formatCount(analysis.guardrails.underpowered.length)} had too few observations to judge; ` +
        `${formatCount(analysis.guardrails.missing.length)} were not observed at all.`,
    );
  } else {
    for (const breach of analysis.guardrails.breaches) printLine(`· ${breach.detail}`);
  }

  if (analysis.unavailable.length > 0) {
    printLine();
    printLine(`${String(analysis.unavailable.length)} metric(s) in the design are not measurable:`);
    for (const metric of analysis.unavailable) {
      printLine(`  ${metric.name} — ${metric.reason}`);
      printLine(`    unblocked by: ${metric.unblockedBy}`);
    }
  }

  printLine();
  printHeading('Verdict');
  printLine(analysis.verdict);
}

function standardDeviationOf(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1));
}
