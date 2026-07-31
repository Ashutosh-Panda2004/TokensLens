import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { printHeading, printJson, printLine, printTable } from '../output.js';
import { formatCount, formatCredits, formatPercent } from '../../waste/format.js';
import { loadOrCreateInstallSalt } from '../../ingest/redact.js';
import { hashIdentifier } from '../../privacy/identifiers.js';
import {
  buildOutcomeReport,
  buildPanel,
  isGitRepository,
  type OutcomeReport,
} from '../../outcomes/report.js';
import { readGitHistory } from '../../outcomes/git.js';
import { measureDurability } from '../../outcomes/durability.js';
import { estimateStaggeredDid, type CohortAssignment, type DidResult } from '../../outcomes/did.js';
import type { PrivacyContext } from '../../privacy/scope.js';

/** `outcomes` reads this machine's own repository, for the person sitting at it. */
const SELF: PrivacyContext = { scope: 'self', subjectCount: 1 };

interface CommonOptions {
  readonly json?: boolean;
  readonly since?: string;
  readonly horizon: string;
}

interface EffectOptions extends CommonOptions {
  readonly cohorts?: string;
  readonly periodDays: string;
  readonly metric: string;
}

export function registerOutcomesCommand(program: Command): void {
  const outcomes = program
    .command('outcomes')
    .description(
      'Measure whether the spend bought anything: durability, effort, and displacement.',
    );

  outcomes
    .command('survival', { isDefault: true })
    .description('How much of what is written survives, and where the effort goes.')
    .option('--since <date>', 'only consider history after this date, e.g. 2026-01-01')
    .option('--horizon <days>', 'days a change must survive to count', '30')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: CommonOptions) => {
      const report = await load(options);
      if (!report) return;

      if (options.json) {
        printJson(report);
        return;
      }
      printSurvival(report);
    });

  outcomes
    .command('displacement')
    .description('Detect work being relocated into review and rework rather than eliminated.')
    .option('--since <date>', 'only consider history after this date')
    .option('--horizon <days>', 'days a change must survive to count', '30')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: CommonOptions) => {
      const report = await load(options);
      if (!report) return;

      if (options.json) {
        printJson(report.displacement);
        return;
      }
      printDisplacement(report);
    });

  outcomes
    .command('effect')
    .description('Estimate what a dated change in AI availability actually did.')
    .requiredOption(
      '--cohorts <file>',
      'CSV of `developer-email,YYYY-MM-DD` — the Copilot licence assignment export. Empty date means never treated',
    )
    .option('--since <date>', 'only consider history after this date')
    .option('--horizon <days>', 'days a change must survive to count', '30')
    .option('--period-days <days>', 'days per panel period', '7')
    .option('--metric <name>', 'survival or size', 'survival')
    .option('--json', 'print machine-readable JSON instead of a summary')
    .action(async (options: EffectOptions) => {
      const result = await estimateEffect(options);
      if (!result) return;

      if (options.json) {
        printJson(result);
        return;
      }
      printEffect(result, options.metric);
    });
}

async function load(options: CommonOptions): Promise<OutcomeReport | undefined> {
  const cwd = process.cwd();
  if (!(await isGitRepository(cwd))) {
    printLine('Not a git repository, so there are no outcomes to measure here.');
    printLine('Run this from inside the repository whose changes you want to measure.');
    process.exitCode = 1;
    return undefined;
  }

  const report = await buildOutcomeReport({
    cwd,
    privacy: SELF,
    horizonDays: Number.parseInt(options.horizon, 10) || 30,
    ...(options.since !== undefined ? { since: new Date(options.since) } : {}),
  });

  if (report.changeCount === 0) {
    printLine('No commits in range. Widen --since, or check you are in the right repository.');
    process.exitCode = 1;
    return undefined;
  }
  return report;
}

function printSurvival(report: OutcomeReport): void {
  printHeading('TokenLens — outcome measurement');
  printLine(
    `window:    ${new Date(report.windowFrom).toISOString().slice(0, 10)} to ` +
      new Date(report.windowTo).toISOString().slice(0, 10),
  );
  printLine(
    `changes:   ${formatCount(report.changeCount)} from ${formatCount(report.authorCount)} author(s)`,
  );
  printLine(`horizon:   ${String(report.horizonDays)} days`);

  printLine();
  printHeading('Durability');
  printTable([
    {
      durable: formatCount(report.durability.durable),
      'not durable': formatCount(report.durability.notDurable),
      'too recent to tell': formatCount(report.durability.unknown),
      'durable rate':
        report.durability.durableRate === undefined
          ? '—'
          : formatPercent(report.durability.durableRate),
    },
  ]);
  printLine();
  printLine(
    '"Too recent to tell" is reported separately on purpose: a change merged yesterday has not been ' +
      'reverted, and counting that as durable would make the newest work look perfect every time this runs.',
  );

  if (report.survivalAtHorizon !== undefined) {
    printLine();
    printLine(
      `${formatPercent(report.survivalAtHorizon)} of added lines were still present at ${String(report.horizonDays)} days.`,
    );
  } else {
    printLine();
    printLine(
      `Line survival at ${String(report.horizonDays)} days is not estimable — too few lines have been observed that long.`,
    );
  }
  printLine(
    `Churn attribution covered ${formatPercent(report.attributionCoverage)} of all deletions; ` +
      'the rest landed on code older than the horizon and is maintenance, not churn.',
  );

  printLine();
  printHeading('Where the effort went');
  printTable([
    { term: 'authoring', hours: report.effort.authorHours.toFixed(1) },
    { term: 'rework', hours: report.effort.reworkHours.toFixed(1) },
    { term: 'failure response', hours: report.effort.failureHours.toFixed(1) },
    { term: 'review', hours: 'not measurable' },
  ]);

  if (report.effort.reworkRatio !== undefined) {
    printLine();
    printLine(
      `rework ratio: ${report.effort.reworkRatio.toFixed(2)} hours of rework and failure per hour of authoring`,
    );
  }
  if (report.hoursPerDurableChange !== undefined) {
    printLine(
      `measurable hours per durable change: ${formatCredits(report.hoursPerDurableChange)} ` +
        '(excludes review, which git cannot supply)',
    );
  }

  printLine();
  printLine(
    'The claim this supports is an identity, not a model: effort per durable change = authoring + review + ' +
      'rework + failure. If AI creates productivity the total falls; if it relocates work the total holds ' +
      'while the mix shifts.',
  );

  printUnavailable(report);
  printLine();
  printLine('Run `tokenlens outcomes displacement` to see whether the mix is shifting.');
}

function printDisplacement(report: OutcomeReport): void {
  const { displacement } = report;

  printHeading('TokenLens — productivity displacement');
  printLine(
    `comparing the last ${String(displacement.windowDays)} days against the ${String(displacement.windowDays)} before.`,
  );

  printLine();
  if (displacement.findings.length === 0) {
    printLine('No measurable displacement signature fired.');
    printLine(
      'That is the absence of evidence of relocation, not evidence of a gain. A before/after comparison ' +
        'says what moved, never what moved it.',
    );
  } else {
    printTable(
      displacement.findings.map((finding) => ({
        class: finding.class,
        signature: finding.title,
        movement: finding.magnitude.toFixed(3),
        unit: finding.unit,
        confidence: formatPercent(finding.confidence, 0),
      })),
    );
    printLine();
    for (const finding of displacement.findings) {
      printLine(`${finding.class}: ${finding.detail}`);
      for (const assumption of finding.assumptions) printLine(`    · ${assumption}`);
    }
  }

  printLine();
  if (displacement.compositeAlarm) {
    printHeading('⚠ Composite displacement alarm');
  } else {
    printHeading('Composite check');
  }
  printLine(displacement.compositeDetail);

  if (displacement.unavailable.length > 0) {
    printLine();
    printLine(
      `${String(displacement.unavailable.length)} class(es) could not be assessed from git alone:`,
    );
    for (const item of displacement.unavailable) {
      printLine(`  ${item.class} ${item.name} — ${item.reason}`);
      printLine(`    unblocked by: ${item.unblockedBy}`);
    }
  }
}

function printUnavailable(report: OutcomeReport): void {
  if (report.unavailable.length === 0) return;
  printLine();
  printLine(
    `${String(report.unavailable.length)} term(s) of the identity are not measurable from git:`,
  );
  for (const term of report.unavailable) {
    printLine(`  ${term.term} — ${term.reason}`);
    printLine(`    unblocked by: ${term.unblockedBy}`);
  }
}

interface EffectRun {
  readonly result: DidResult;
  readonly periods: number;
  readonly groups: number;
  /** Cohort identifiers that matched an author in this repository. */
  readonly matchedUnits: number;
}

async function estimateEffect(options: EffectOptions): Promise<EffectRun | undefined> {
  const cwd = process.cwd();
  if (!(await isGitRepository(cwd))) {
    printLine('Not a git repository.');
    process.exitCode = 1;
    return undefined;
  }
  if (options.cohorts === undefined) return undefined;

  const salt = await loadOrCreateInstallSalt(cwd);
  const cohorts = await readCohorts(options.cohorts, salt);
  if (cohorts.length === 0) {
    printLine(`No usable rows in ${options.cohorts}. Expected lines of \`group,YYYY-MM-DD\`.`);
    process.exitCode = 1;
    return undefined;
  }

  const commits = await readGitHistory(
    { cwd, ...(options.since !== undefined ? { since: new Date(options.since) } : {}) },
    salt,
  );
  const durability = measureDurability(commits, {
    horizonDays: Number.parseInt(options.horizon, 10) || 30,
  });

  const periodDays = Number.parseInt(options.periodDays, 10) || 7;
  const panel = buildPanel(
    durability.changes,
    (changes) => {
      const observed = changes.filter((change) => change.fullyObserved && change.linesAdded > 0);
      if (observed.length === 0) return undefined;
      return options.metric === 'size'
        ? observed.reduce((sum, change) => sum + change.linesAdded, 0) / observed.length
        : observed.reduce((sum, change) => sum + change.survivingFraction, 0) / observed.length;
    },
    { periodDays, groupOf: (change) => change.authorId },
  );

  const periodMs = periodDays * 24 * 60 * 60 * 1000;
  const assignments: CohortAssignment[] = cohorts.map((entry) =>
    entry.treatedOn === undefined
      ? { unit: entry.unit }
      : { unit: entry.unit, treatedAt: Math.floor(entry.treatedOn / periodMs) },
  );

  const panelUnits = new Set(panel.map((point) => point.unit));

  // Diagnosed before the estimator runs, because "no estimate" has several
  // very different causes and the user needs the right one. An empty panel
  // is not a failed design — it means no change has been observed for long
  // enough to have an outcome yet.
  if (panel.length === 0) {
    printHeading('TokenLens — estimated effect');
    printLine(
      'No change has been observed for the full horizon, so there is no outcome to explain.',
    );
    printLine();
    printLine(
      `Every change in this history is younger than ${String(Number.parseInt(options.horizon, 10) || 30)} days. ` +
        'Shorten the horizon with --horizon, or wait: an effect on durability cannot be estimated before ' +
        'anything has had the chance to prove durable.',
    );
    process.exitCode = 1;
    return undefined;
  }

  if (assignments.every((entry) => !panelUnits.has(entry.unit))) {
    printHeading('TokenLens — estimated effect');
    printLine('None of the identifiers in the cohort file matched an author in this repository.');
    printLine();
    printLine(
      'The file should contain the same e-mail addresses git records as commit authors. They are hashed on ' +
        'read with this install’s salt, so the file may name people even though nothing downstream does.',
    );
    process.exitCode = 1;
    return undefined;
  }

  return {
    result: estimateStaggeredDid(panel, assignments),
    periods: new Set(panel.map((point) => point.period)).size,
    groups: panelUnits.size,
    matchedUnits: assignments.filter((entry) => panelUnits.has(entry.unit)).length,
  };
}

/**
 * Cohort file: `developer-email,YYYY-MM-DD`, one per line, `#` for comments.
 * An empty date means never treated, which is the control group. In practice
 * this is the Copilot licence assignment export, unmodified.
 *
 * The identifier is hashed with the install salt before use — the same
 * construction git authors go through — so a file naming real people
 * produces a panel that does not, and the join still works.
 */
async function readCohorts(
  path: string,
  salt: string,
): Promise<{ unit: string; treatedOn?: number }[]> {
  const raw = await readFile(path, 'utf8');
  const rows: { unit: string; treatedOn?: number }[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const [name, date] = trimmed.split(',').map((part) => part.trim());
    if (name === undefined || name === '') continue;

    const unit = hashIdentifier(name.toLowerCase(), salt);
    const parsed = date === undefined || date === '' ? undefined : Date.parse(date);
    rows.push(
      parsed === undefined || Number.isNaN(parsed) ? { unit } : { unit, treatedOn: parsed },
    );
  }

  return rows;
}

function printEffect(run: EffectRun, metric: string): void {
  const { result } = run;

  printHeading('TokenLens — estimated effect');
  printLine(
    `metric:     ${metric === 'size' ? 'mean change size' : 'surviving share of added lines'}`,
  );
  printLine(
    `panel:      ${formatCount(run.groups)} group(s) over ${formatCount(run.periods)} period(s)`,
  );
  printLine(
    `treated:    ${formatCount(result.treatedUnits)}   control: ${formatCount(result.controlUnits)}`,
  );
  printLine(`comparison: ${result.comparisonGroup}`);

  // Printed above the estimate, deliberately. A design whose central
  // assumption fails must say so before it shows a number, not beneath it.
  printLine();
  printHeading(result.preTrend.passes ? 'Pre-trend check — passed' : '⚠ Pre-trend check — FAILED');
  printLine(result.preTrend.detail);
  if (result.preTrend.worstEffect && result.preTrend.worstPeriod !== undefined) {
    printLine(
      `largest pre-treatment difference: ${result.preTrend.worstEffect.point.toFixed(4)} at period ` +
        `${String(result.preTrend.worstPeriod)} ` +
        `[${result.preTrend.worstEffect.low.toFixed(4)}, ${result.preTrend.worstEffect.high.toFixed(4)}]`,
    );
  }

  printLine();
  if (!result.preTrend.passes) {
    printHeading('No estimate reported');
    printLine(
      result.preTrend.untestable
        ? 'Parallel trends could not be tested, because there are no pre-treatment periods in this panel. ' +
            'Without them there is no way to check whether the groups were already moving apart, and an ' +
            'untested assumption is not a satisfied one.'
        : 'Treated and control groups were already diverging before treatment, so anything measured afterwards ' +
            'contains that divergence. Quoting an effect from this panel would be reporting the pre-existing ' +
            'difference as though the treatment had caused it.',
    );
    printLine();
    printLine(
      'This is a result, not a failure: it says this comparison cannot answer the question, which is worth ' +
        'knowing before anyone acts on a number.',
    );
    process.exitCode = 1;
    return;
  }

  if (result.att === undefined) {
    printLine(
      'Nothing was estimable — no cohort had enough units on both sides of the comparison.',
    );
    process.exitCode = 1;
    return;
  }

  printHeading('Effect');
  printLine(
    `${result.att.point.toFixed(4)}  [${result.att.low.toFixed(4)}, ${result.att.high.toFixed(4)}]  (95%, cluster bootstrap on group)`,
  );
  printLine();
  printLine(
    result.att.low <= 0 && result.att.high >= 0
      ? 'The interval contains zero. On this data the treatment cannot be distinguished from no effect — ' +
          'which is an answer, and the one most tools in this category decline to give.'
      : 'The interval excludes zero, so the effect is distinguishable from none at this sample size.',
  );

  if (result.eventStudy.length > 0) {
    printLine();
    printHeading('Event study');
    printTable(
      result.eventStudy.map((point) => ({
        period:
          point.relativePeriod >= 0
            ? `+${String(point.relativePeriod)}`
            : String(point.relativePeriod),
        effect: point.effect.point.toFixed(4),
        low: point.effect.low.toFixed(4),
        high: point.effect.high.toFixed(4),
        groups: point.units,
      })),
    );
    printLine();
    printLine(
      'Periods before 0 are the pre-trend and should straddle zero. Periods from 0 are the effect.',
    );
  }

  if (result.droppedCells > 0) {
    printLine();
    printLine(
      `${formatCount(result.droppedCells)} cohort/period cell(s) were dropped for want of a comparison group.`,
    );
  }
}
