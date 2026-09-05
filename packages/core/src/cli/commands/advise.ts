import { openLedgerForReading, collectDetectInputs } from '../context.js';
import { buildAdviceReport } from '../../advice/report.js';
import { describeSignal } from '../../advice/residual.js';
import { taxonomyFor } from '../../advice/taxonomy.js';
import { behaviourGuidanceFor } from '../../advice/guidance.js';
import { printHeading, printJson, printLine, printTable } from '../output.js';
import type { Command } from 'commander';
import type { AdviceReport } from '../../advice/report.js';
import type { WasteClass } from '../../waste/types.js';

/**
 * `tokenlens advise` — D11 R1, read-only.
 *
 * The command has one job the rest of the CLI does not: it has to be able to say
 * *nothing*, convincingly. A recommendation surface that always finds something
 * to recommend is a shop window. So the default output leads with what is being
 * offered, and then prints, for every class that produced no offer, the reason —
 * which is usually that TokenLens's own lever already reached the waste.
 */

interface AdviseOptions {
  readonly json?: boolean;
  readonly explain?: string;
  readonly catalogue?: boolean;
}

function printOffers(report: AdviceReport): void {
  const { offers } = report.match;

  if (offers.length === 0) {
    printLine('No tool is being recommended for this corpus.');
    printLine();
    if (report.readiness.mode === 'guidance-only') {
      printLine(report.readiness.reason);
    } else {
      printLine(
        'Every class either has no residual left after TokenLens\u2019s own fix, is a habit ' +
          'rather than a dependency, or has no detector yet. Run with --explain <class> for ' +
          'the reasoning behind any one of them.',
      );
    }
    return;
  }

  printTable(
    offers.map((offer) => ({
      class: offer.class,
      tool: offer.entry.name,
      rank: offer.rank,
      surface: offer.entry.surfaces.join('/'),
      licence: offer.entry.licence,
      install: offer.entry.install.complexity,
      caveats: offer.caveats.length,
    })),
  );

  for (const offer of offers) {
    printLine();
    printLine(`${offer.class} \u00b7 ${offer.entry.name} \u2014 ${offer.entry.summary}`);
    printLine(`  residual:  ${offer.signal.label} \u2014 ${describeSignal(offer.signal)}`);
    printLine(`  install:   ${offer.entry.install.command}`);
    printLine(`  source:    ${offer.entry.repository}`);
    for (const reason of offer.why) printLine(`  why:       ${reason}`);
    for (const caveat of offer.caveats) printLine(`  \u26a0 caveat:  ${caveat}`);
  }
}

function printGuidance(report: AdviceReport): void {
  const { mechanisms, behaviour } = report.match;
  if (mechanisms.length === 0 && behaviour.length === 0) return;

  printHeading('What would help, without naming anything to install');

  for (const suggestion of mechanisms) {
    printLine(`${suggestion.class} \u00b7 ${suggestion.headline}`);
    printLine(`  ${suggestion.whatItDoes}`);
    printLine(`  you would know it worked if ${suggestion.howYouWouldKnow}`);
    printLine();
  }

  for (const guidance of behaviour) {
    printLine(`${guidance.class} \u00b7 ${guidance.headline}`);
    printLine(`  ${guidance.why}`);
    printLine(`  you would know it worked if ${guidance.howYouWouldKnow}`);
    printLine();
  }
}

function printSilences(report: AdviceReport): void {
  const silences = report.match.silences;
  if (silences.length === 0) return;

  printHeading('Why nothing was offered elsewhere');
  for (const item of silences) {
    printLine(`${item.class.padEnd(4)} [${item.code}] ${item.reason}`);
  }
  printLine();
  printLine(
    'These are printed rather than omitted. \u201cWe looked and there is nothing to offer\u201d ' +
      'and \u201cwe did not look\u201d must not render identically.',
  );
}

function printRefusals(report: AdviceReport): void {
  const refusals = report.match.refusals;
  if (refusals.length === 0) return;

  printHeading('Considered and refused, by name');
  for (const refusal of refusals) {
    printLine(`${refusal.class} \u00b7 ${refusal.entry.name} \u2014 ${refusal.entry.repository}`);
    printLine(`  ${refusal.reason}`);
    printLine();
  }
}

function printCatalogue(report: AdviceReport): void {
  printHeading('TokenLens \u2014 advice catalogue');
  printLine(`digest ${report.catalogueDigest} \u00b7 evaluated as of ${report.asOf}`);
  printLine();

  printTable(
    report.catalogue.map((listing) => ({
      id: listing.entry.id,
      status: listing.entry.status,
      licence: listing.entry.licence,
      addresses: listing.entry.addresses.join(',') || '\u2014',
      verified: listing.entry.verification.checkedOn,
      source: listing.entry.verification.source,
      offerable: listing.offerable ? 'yes' : 'no',
    })),
  );

  for (const listing of report.catalogue) {
    if (listing.offerable) continue;
    printLine();
    printLine(`${listing.entry.id} is not offerable:`);
    for (const blocker of listing.blockers) printLine(`  \u00b7 ${blocker}`);
  }

  printLine();
  printLine(report.readiness.reason);
}

function printExplanation(report: AdviceReport, wanted: WasteClass): void {
  const taxonomy = taxonomyFor(wanted);
  printHeading(`${wanted} \u00b7 ${taxonomy.nature}`);
  printLine(taxonomy.rationale);

  if (taxonomy.residual !== undefined) {
    printLine();
    printLine(
      `lever:            ${taxonomy.residual.lever ?? '\u2014 none; TokenLens cannot fix this itself'}`,
    );
    printLine(`lever reaches:    ${taxonomy.residual.leverReaches}`);
    printLine(`residual:         ${taxonomy.residual.residual}`);
    printLine(`mechanisms:       ${taxonomy.residual.mechanisms.join(', ')}`);
  }

  const signal = report.signals.find((item) => item.class === wanted);
  if (signal !== undefined) {
    printLine();
    printLine('residual probe:');
    printLine(`  ${signal.label}: ${describeSignal(signal)}`);
    printLine(`  basis:  ${signal.basis}`);
    printLine(`  detail: ${signal.detail}`);
  }

  const behaviour = behaviourGuidanceFor(wanted);
  if (behaviour !== undefined) {
    printLine();
    printLine(`guidance: ${behaviour.headline}`);
    printLine(`  ${behaviour.why}`);
  }

  const offers = report.match.offers.filter((offer) => offer.class === wanted);
  if (offers.length > 0) {
    printLine();
    printLine('offered:');
    for (const offer of offers) {
      printLine(`  ${String(offer.rank)}. ${offer.entry.name} \u2014 ${offer.entry.repository}`);
      for (const reason of offer.why) printLine(`     ${reason}`);
      for (const caveat of offer.caveats) printLine(`     \u26a0 ${caveat}`);
    }
  }

  const silence = report.match.silences.find((item) => item.class === wanted);
  if (silence !== undefined) {
    printLine();
    printLine(`not offered [${silence.code}]: ${silence.reason}`);
  }

  const refusals = report.match.refusals.filter((refusal) => refusal.class === wanted);
  for (const refusal of refusals) {
    printLine();
    printLine(`refused: ${refusal.entry.name} \u2014 ${refusal.entry.repository}`);
    printLine(`  ${refusal.reason}`);
  }
}

/**
 * The one place user input becomes a `WasteClass`.
 *
 * Validated here rather than trusted, because `taxonomyFor` throws on an unknown
 * class and a typo should produce a sentence, not a stack trace.
 */
function parseWasteClass(raw: string): WasteClass | undefined {
  const normalised = raw.trim().toUpperCase();
  return /^W(?:[1-9]|1[0-4])$/.test(normalised) ? (normalised as WasteClass) : undefined;
}

export function registerAdviseCommand(program: Command): void {
  program
    .command('advise')
    .description(
      'Name a vetted open-source tool for waste that survives TokenLens\u2019s own fix \u2014 ' +
        'and say plainly where there is nothing to name.',
    )
    .option('--json', 'print machine-readable JSON instead of a summary')
    .option('--explain <class>', 'why this finding did or did not produce a suggestion, e.g. W2')
    .option('--catalogue', 'every entry, its status, and when it was last verified')
    .action(async (options: AdviseOptions) => {
      const db = await openLedgerForReading();
      const report = buildAdviceReport(db, { inputs: await collectDetectInputs() });

      if (options.json) {
        printJson(report);
        return;
      }

      if (options.catalogue) {
        printCatalogue(report);
        return;
      }

      if (options.explain !== undefined) {
        const wanted = parseWasteClass(options.explain);
        if (wanted === undefined) {
          printLine(
            `"${options.explain}" is not a waste class. They are named W1 through W14 — run ` +
              '`tokenlens waste` to see which of them this corpus produced findings for.',
          );
          return;
        }
        printExplanation(report, wanted);
        return;
      }

      printHeading('TokenLens \u2014 prescriptive advice');
      printLine(
        `catalogue ${report.catalogueDigest} \u00b7 mode ${report.readiness.mode} \u00b7 ` +
          `${String(report.readiness.recommended)} entr${report.readiness.recommended === 1 ? 'y' : 'ies'} offerable`,
      );
      printLine();

      printOffers(report);
      printGuidance(report);
      printRefusals(report);
      printSilences(report);

      printLine();
      printLine(
        'Nothing here is installed, configured or measured for you. Run ' +
          '`tokenlens advise --explain W2` for the reasoning behind any one class, or ' +
          '`tokenlens advise --catalogue` for the dataset itself.',
      );
    });
}
