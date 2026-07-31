import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { printHeading, printJson, printLine, printTable } from '../output.js';
import { formatCount, formatCredits, formatPercent } from '../../waste/format.js';
import { openLedgerForReading } from '../context.js';
import { loadOrCreateInstallSalt } from '../../ingest/redact.js';
import { assertContained } from '../../shared/safe.js';
import { auditBundle, buildBundle, BUNDLE_MANIFEST, type OrgBundle } from '../../org/bundle.js';
import { rollUp } from '../../org/rollup.js';
import { buildAlert, buildExecutiveReport, detectAnomalies } from '../../org/alerts.js';
import { detectDrift, snapshotFit, type PolicyFitSnapshot } from '../../org/drift.js';
import { assessCache, detectDuplication, type QuestionObservation } from '../../org/duplication.js';
import { ingestOtel, OTEL_LIMITATIONS, type OtelPayload } from '../../org/otel.js';
import { parsePolicyBuffer } from '../../simulate/policy.js';

interface SyncOptions {
  readonly team: string;
  readonly developers: string;
  readonly out?: string;
  readonly json?: boolean;
}

interface RollupOptions {
  readonly bundles: string;
  readonly json?: boolean;
}

interface DriftOptions extends RollupOptions {
  readonly policy: string;
  readonly snapshot?: string;
  readonly writeSnapshot?: string;
}

/**
 * **Phase D9 — the fleet, and the loop that keeps the policy honest.**
 *
 * Everything up to here runs on one machine and is trivially private
 * because there is no outward path. These commands create one, so each of
 * them is built around the same question: what exactly leaves, and can
 * somebody check?
 */
export function registerOrgCommand(program: Command): void {
  const org = program
    .command('org')
    .description(
      'Fleet rollup, anomaly alerts, and the closed loop that re-fits policy against drift.',
    );

  org
    .command('sync')
    .description(
      'Produce this install’s aggregate-only bundle, with a manifest of every field in it.',
    )
    .requiredOption('--team <name>', 'team this install belongs to — supplied, never detected')
    .option('--developers <n>', 'developers behind this install', '1')
    .option('--out <file>', 'write the bundle here instead of printing it')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: SyncOptions) => {
      const cwd = process.cwd();
      const salt = await loadOrCreateInstallSalt(cwd);
      const db = await openLedgerForReading();

      const bundle = buildBundle(db, {
        team: options.team,
        developers: Number.parseInt(options.developers, 10) || 1,
        cwd,
        salt,
      });

      const audit = auditBundle(bundle);
      if (!audit.safe) {
        // Refusing to write is the point. An undeclared field is one the
        // security review did not see, and shipping it while printing a
        // warning would mean the warning is the only thing standing between
        // this and an unreviewed egress.
        printLine(audit.detail);
        process.exitCode = 1;
        return;
      }

      if (options.out !== undefined) {
        const target = assertContained(cwd, resolve(cwd, options.out));
        await mkdir(join(target, '..'), { recursive: true });
        await writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
        printLine(`Bundle written to ${target}.`);
        printLine(audit.detail);
        return;
      }

      if (options.json) {
        printJson(bundle);
        return;
      }

      printHeading('TokenLens — sync bundle');
      printLine(`team:        ${bundle.team}`);
      printLine(`period:      ${bundle.periodFrom} to ${bundle.periodTo}`);
      printLine(
        `credits:     ${formatCredits(bundle.totalCredits)} over ${formatCount(bundle.requestCount)} request(s)`,
      );
      printLine();
      printHeading('Everything that leaves this machine');
      printTable(BUNDLE_MANIFEST.map((entry) => ({ field: entry.field, why: entry.why })));
      printLine();
      printLine(audit.detail);
      printLine();
      printLine(
        'No prompts, completions, file paths, file contents, tool arguments or session identifiers are ' +
          'present — not redacted, absent. Re-run with --out to write it.',
      );
    });

  org
    .command('rollup')
    .description('Merge synced bundles into a fleet view, with small teams suppressed.')
    .requiredOption('--bundles <dir>', 'directory of bundle JSON files')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: RollupOptions) => {
      const bundles = await readBundles(options.bundles);
      if (bundles.length === 0) {
        printLine(`No readable bundles in ${options.bundles}.`);
        process.exitCode = 1;
        return;
      }

      const rollup = rollUp(bundles);
      if (options.json) {
        printJson(rollup);
        return;
      }

      printHeading('TokenLens — fleet rollup');
      printLine(`installs:   ${formatCount(rollup.installs)}`);
      printLine(`developers: ${formatCount(rollup.developers)}`);
      printLine(
        `credits:    ${formatCredits(rollup.totalCredits)} (${formatPercent(rollup.measuredShare)} measured)`,
      );
      printLine(`period:     ${rollup.periodFrom} to ${rollup.periodTo}`);

      printLine();
      printHeading('By team');
      printTable(
        rollup.byTeam.map((team) => ({
          team: team.team,
          developers: formatCount(team.developers),
          credits: formatCredits(team.credits),
          'per dev': formatCredits(team.creditsPerDeveloper),
        })),
      );

      printLine();
      printHeading('Tool surface');
      printTable(
        rollup.toolSurface.slice(0, 10).map((row) => ({
          server: row.server,
          installs: formatCount(row.installs),
          tools: formatCount(row.toolCount),
          'calls/install': row.invocationsPerInstall.toFixed(1),
        })),
      );

      printLine();
      printHeading('Measured spend distribution');
      printTable([
        {
          p10: formatCredits(rollup.distribution.p10),
          median: formatCredits(rollup.distribution.median),
          mean: formatCredits(rollup.distribution.mean),
          p90: formatCredits(rollup.distribution.p90),
          gini:
            rollup.distribution.gini === undefined
              ? 'not estimable'
              : rollup.distribution.gini.toFixed(2),
        },
      ]);
      printLine();
      printLine(rollup.distribution.detail);
      printLine();
      printLine(rollup.detail);
    });

  org
    .command('report')
    .description('The exec/FinOps summary, with its caveats attached rather than appended.')
    .requiredOption('--bundles <dir>', 'directory of bundle JSON files')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: RollupOptions) => {
      const bundles = await readBundles(options.bundles);
      if (bundles.length === 0) {
        printLine(`No readable bundles in ${options.bundles}.`);
        process.exitCode = 1;
        return;
      }

      const report = buildExecutiveReport(rollUp(bundles), bundles);
      if (options.json) {
        printJson(report);
        return;
      }

      printHeading('TokenLens — fleet summary');
      printLine(`period:      ${report.period}`);
      printLine(
        `installs:    ${formatCount(report.installs)} · developers ${formatCount(report.developers)}`,
      );
      printLine(`credits:     ${formatCredits(report.totalCredits)}`);
      printLine(`per dev:     ${formatCredits(report.creditsPerDeveloper)}`);
      printLine();
      printHeading('Where it went');
      printTable(report.topModels.map((m) => ({ model: m.model, share: formatPercent(m.share) })));
      printLine();
      printHeading('Largest attributed causes');
      printTable(
        report.topWaste.map((w) => ({ class: w.class, credits: formatCredits(w.credits) })),
      );
      printLine();
      printHeading('Read this before quoting any of the above');
      for (const caveat of report.caveats) printLine(`· ${caveat}`);
    });

  org
    .command('alerts')
    .description('Robust anomaly detection over daily spend. Produces a payload; posts nothing.')
    .requiredOption('--bundles <dir>', 'directory of bundle JSON files')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: RollupOptions) => {
      const bundles = await readBundles(options.bundles);
      const daily = new Map<string, number>();
      for (const bundle of bundles) {
        for (const day of bundle.daily) daily.set(day.day, (daily.get(day.day) ?? 0) + day.credits);
      }

      const series = [...daily.entries()]
        .map(([day, credits]) => ({ day, credits }))
        .sort((a, b) => a.day.localeCompare(b.day));

      const report = detectAnomalies(series);
      const payload = buildAlert(report, rollUp(bundles));

      if (options.json) {
        printJson({ report, payload });
        return;
      }

      printHeading('TokenLens — spend anomalies');
      printLine(report.detail);
      if (report.anomalies.length > 0) {
        printLine();
        printTable(
          report.anomalies.slice(0, 10).map((anomaly) => ({
            day: anomaly.day,
            credits: formatCredits(anomaly.credits),
            typical: formatCredits(anomaly.expected),
            z: anomaly.robustZ.toFixed(1),
            severity: anomaly.severity,
          })),
        );
      }
      if (payload) {
        printLine();
        printHeading('Payload');
        printLine(JSON.stringify(payload));
        printLine();
        printLine(payload.delivery);
      }
    });

  org
    .command('drift')
    .description('E4 — has the fleet moved out from under the policy?')
    .requiredOption('--bundles <dir>', 'directory of bundle JSON files')
    .requiredOption('--policy <file>', 'the deployed policy')
    .option('--snapshot <file>', 'what the policy was fitted against')
    .option('--write-snapshot <file>', 'record today as the fit baseline instead of checking drift')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: DriftOptions) => {
      const bundles = await readBundles(options.bundles);
      if (bundles.length === 0) {
        printLine(`No readable bundles in ${options.bundles}.`);
        process.exitCode = 1;
        return;
      }

      if (options.writeSnapshot !== undefined) {
        const snapshot = snapshotFit(bundles);
        const target = assertContained(
          process.cwd(),
          resolve(process.cwd(), options.writeSnapshot),
        );
        await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        printLine(`Fit baseline written to ${target}.`);
        printLine(
          `${String(snapshot.models.length)} model(s), ${String(snapshot.servers.length)} MCP server(s), ` +
            `${String(snapshot.toolCount)} tool definition(s). Drift is measured from here.`,
        );
        return;
      }

      if (options.snapshot === undefined) {
        printLine(
          'Pass --snapshot <file>, or --write-snapshot <file> to record today as the baseline.',
        );
        printLine(
          'Without a baseline the first drift check has nothing to compare against, and would report zero ' +
            'drift forever.',
        );
        process.exitCode = 1;
        return;
      }

      const snapshot = JSON.parse(await readFile(options.snapshot, 'utf8')) as PolicyFitSnapshot;
      const parsed = parsePolicyBuffer(await readFile(options.policy), {
        filePath: options.policy,
      });
      const report = detectDrift(snapshot, bundles, parsed.policy);

      if (options.json) {
        printJson(report);
        return;
      }

      printHeading(
        report.refitRecommended ? '⚠ TokenLens — policy drift' : 'TokenLens — policy drift',
      );
      printLine(
        `fitted:     ${report.fittedAt.slice(0, 10)} (${String(report.daysSinceFit)} days ago)`,
      );
      printLine(
        `unseen:     ${formatPercent(report.unseenCreditShare)} of credits on models the policy never saw`,
      );
      printLine();
      if (report.findings.length === 0) {
        printLine('Nothing has moved since the fit.');
      } else {
        for (const finding of report.findings) {
          printLine(`${finding.kind}: ${finding.detail}`);
          printLine(`    → ${finding.action}`);
        }
      }
      printLine();
      printLine(report.detail);
      printLine();
      printLine(
        'Drift is detected automatically and applied by a person. A machine silently rewriting a managed ' +
          'setting on every laptop because a new model appeared is the one thing an IT organisation will ' +
          'not forgive.',
      );
    });

  org
    .command('duplication')
    .description('W8 — the same question, asked by many people. Structural matches only.')
    .requiredOption('--questions <file>', 'JSON array of {questionHash, askedBy, credits, ts}')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { readonly questions: string; readonly json?: boolean }) => {
      let observations: QuestionObservation[];
      try {
        observations = JSON.parse(
          await readFile(options.questions, 'utf8'),
        ) as QuestionObservation[];
      } catch {
        printLine(`Could not read ${options.questions} as JSON.`);
        process.exitCode = 1;
        return;
      }

      const report = detectDuplication(observations);
      const totalCredits = observations.reduce((sum, o) => sum + o.credits, 0);
      const cache = assessCache(report, totalCredits);

      if (options.json) {
        printJson({ report, cache });
        return;
      }

      printHeading('TokenLens — cross-developer duplication (W8)');
      printLine(report.detail);
      if (report.clusters.length > 0) {
        printLine();
        printTable(
          report.clusters.slice(0, 10).map((cluster) => ({
            question: `${cluster.questionHash.slice(0, 12)}…`,
            askers: formatCount(cluster.askedBy),
            asked: formatCount(cluster.occurrences),
            redundant: formatCredits(cluster.redundantCredits),
          })),
        );
      }
      printLine();
      printHeading('Shared answer cache');
      printLine(cache.detail);
      printLine();
      for (const item of report.unavailable) {
        printLine(`Not built: ${item.what}`);
        printLine(`  ${item.reason}`);
        printLine(`  unblocked by: ${item.unblockedBy}`);
      }
    });

  org
    .command('otel')
    .description('D9.1 — ingest a managed OTel export instead of reading journals.')
    .requiredOption('--input <file>', 'OTLP/JSON export')
    .option('--json', 'print machine-readable JSON')
    .action(async (options: { readonly input: string; readonly json?: boolean }) => {
      const salt = await loadOrCreateInstallSalt(process.cwd());
      let payload: OtelPayload;
      try {
        payload = JSON.parse(await readFile(options.input, 'utf8')) as OtelPayload;
      } catch {
        printLine(`Could not read ${options.input} as JSON.`);
        process.exitCode = 1;
        return;
      }

      const result = ingestOtel(payload, salt);
      if (options.json) {
        printJson({ ...result, limitations: OTEL_LIMITATIONS });
        return;
      }

      printHeading('TokenLens — managed OTel ingest');
      printLine(result.detail);
      printLine();
      printHeading('What OTel still cannot supply');
      for (const limitation of OTEL_LIMITATIONS) {
        printLine(`· ${limitation.reason}`);
        printLine(`  unblocked by: ${limitation.unblockedBy}`);
      }
    });
}

async function readBundles(dir: string): Promise<OrgBundle[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const bundles: OrgBundle[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as OrgBundle;
      // A bundle without a manifest was not produced by `org sync`, and
      // reading it would mean trusting an unaudited payload into the fleet
      // figures.
      if (parsed.bundleVersion === 1 && Array.isArray(parsed.manifest)) bundles.push(parsed);
    } catch {
      // Skipped and counted by the caller's file listing; one malformed
      // bundle must not discard a fleet.
      continue;
    }
  }
  return bundles;
}
