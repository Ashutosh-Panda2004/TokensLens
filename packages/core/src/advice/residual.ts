import { groupBy } from '../waste/scoring.js';
import { formatCount, formatPercent } from '../waste/format.js';
import { CLASS_TAXONOMY } from './taxonomy.js';
import type { ResidualProbeId } from './taxonomy.js';
import type { DetectContext } from '../waste/types.js';
import type { WasteClass } from '../waste/types.js';

/**
 * D11 — measuring the residual, so the gate is a number rather than a hope.
 *
 * ## Why this module exists at all
 *
 * The residual-gating rule says a tool is only ever offered against waste that
 * survives TokenLens's own lever. Stated as prose that rule is unfalsifiable:
 * every W2 finding would produce a W2 recommendation, including the corpus
 * whose entire W2 figure is exact repeat reads — which is exactly what the
 * tier-B dedupe guard already denies, for free, with no dependency.
 *
 * So each `residual-tool-fixable` class carries a **probe**: a small,
 * deterministic statistic over recorded fields that stands in for the part the
 * lever cannot reach. The probe is what decides whether an offer is made.
 *
 * ## Three properties every probe here has, deliberately
 *
 * 1. **It is measured, not modelled.** Every probe reads fields the journal
 *    actually wrote — result sizes, line ranges, tool names. Nothing here is a
 *    counterfactual, so nothing here needs a `Modelled<T>` wrapper or an
 *    assumption list to be honest.
 * 2. **It varies with the evidence.** A probe returning a constant would be a
 *    defect of the same shape as audit defect D-03, and
 *    `advice.residual.test.ts` fails the build for it.
 * 3. **It refuses on a thin sample.** Below its minimum, a probe reports
 *    `sufficientSample: false` and the engine stays silent. A share computed
 *    over eleven reads is noise wearing a percentage sign.
 *
 * See D11-PRESCRIPTIVE-ADVICE.md §2.3.
 */

/** Tools whose results are file content, and whose line range is therefore meaningful. */
const READ_TOOLS = new Set(['read_file', 'get_errors']);

/**
 * The tier-B payload cap, mirrored from `w3-oversized-payloads.ts`.
 *
 * Mirrored rather than imported because the two numbers mean different things
 * and must be free to diverge: there it is the threshold *at which the guard
 * fires*, here it is the ceiling *below which the guard is absent*. If the
 * lever's cap is retuned, this constant should be reviewed rather than silently
 * dragged along.
 */
const TIER_B_CAP_CHARS = 16_000;

/**
 * How many times its own tool's median a sub-cap result must reach to count as
 * oversized.
 *
 * Three, where the W3 detector uses twenty. That is not an inconsistency, it is
 * the point: the detector is pricing outliers severe enough to be worth
 * charging for, while this probe is looking for the *ordinary* result that is
 * merely bigger than the question required. A residual is by construction
 * milder than the finding it survives.
 */
const SUB_CAP_OUTLIER_MULTIPLE = 3;

export interface ResidualSignal {
  readonly class: WasteClass;
  readonly probe: ResidualProbeId;
  /** Short human label for the quantity, used as a table heading. */
  readonly label: string;
  readonly unit: 'share' | 'count';
  readonly value: number;
  /** Above this, a residual is present and an offer may be made. */
  readonly threshold: number;
  readonly sampleSize: number;
  readonly minimumSample: number;
  readonly sufficientSample: boolean;
  /** `true` only when the sample is sufficient **and** the value clears the threshold. */
  readonly exceeded: boolean;
  /** Which recorded fields produced the number. One line, checkable. */
  readonly basis: string;
  /** What the number means for this corpus, in plain language. */
  readonly detail: string;
}

function formatValue(value: number, unit: ResidualSignal['unit']): string {
  return unit === 'share' ? formatPercent(value) : formatCount(value);
}

function signal(
  parts: Omit<ResidualSignal, 'sufficientSample' | 'exceeded' | 'detail'> & { detail: string },
): ResidualSignal {
  const sufficientSample = parts.sampleSize >= parts.minimumSample;
  return {
    ...parts,
    sufficientSample,
    exceeded: sufficientSample && parts.value > parts.threshold,
  };
}

/**
 * **W2 residual** — how often the *first* read of a file took the whole file.
 *
 * The dedupe guard denies a re-read of a range already returned. It has nothing
 * to say about the first read, because a first read is not a repeat of
 * anything. So the residual is the opening request itself being unscoped: the
 * agent asking for nine hundred lines when it needed one function.
 *
 * The denominator is *distinct file-within-session pairs*, not raw read calls.
 * Counting raw calls would let a single heavily re-read file dominate the
 * share, and re-reads are the lever's territory, not this probe's.
 */
function probeWholeFileFirstReads(ctx: DetectContext): ResidualSignal {
  const reads = ctx.toolCalls.filter(
    (call) => READ_TOOLS.has(call.name) && call.targetFileHash !== null,
  );

  let firstReads = 0;
  let wholeFileFirstReads = 0;
  let wholeFileChars = 0;

  for (const [, calls] of groupBy(reads, (call) => call.sessionId)) {
    const seen = new Set<string>();
    for (const call of calls) {
      const fileHash = call.targetFileHash;
      if (fileHash === null || seen.has(fileHash)) continue;
      seen.add(fileHash);
      firstReads += 1;

      // No start and no end line means the whole file was requested. A read
      // that named a range asked a narrower question, whatever it got back.
      if (call.targetStartLine === null && call.targetEndLine === null) {
        wholeFileFirstReads += 1;
        wholeFileChars += call.resultChars ?? 0;
      }
    }
  }

  const value = firstReads === 0 ? 0 : wholeFileFirstReads / firstReads;

  return signal({
    class: 'W2',
    probe: 'w2-whole-file-first-reads',
    label: 'first reads that fetched a whole file',
    unit: 'share',
    value,
    threshold: 0.35,
    sampleSize: firstReads,
    minimumSample: 30,
    basis:
      'recorded target line range on the first read of each file within each session — ' +
      'a read with neither a start nor an end line requested the entire file',
    detail:
      firstReads === 0
        ? 'no file reads were recorded, so there is nothing to scope more tightly'
        : `${formatCount(wholeFileFirstReads)} of ${formatCount(firstReads)} first reads ` +
          `took the whole file (${formatPercent(value)}), carrying ` +
          `${formatCount(wholeFileChars)} characters the dedupe guard never sees`,
  });
}

/**
 * **W3 residual** — results the cap is too high to catch.
 *
 * A cap at ~16k characters bounds the worst case and does nothing about the
 * ordinary one. This counts results that sit *below* that cap yet still exceed
 * three times their own tool's median: the eight-thousand-character answer to a
 * question that needed two hundred.
 *
 * Judging each tool against its own median matters as much here as it does in
 * the detector — 8,000 characters is routine for a web fetch and pathological
 * for a string replacement — and the median is used rather than a percentile
 * for the same reason: a handful of extreme values must not be able to raise
 * the bar above themselves.
 */
function probeSubCapOversize(ctx: DetectContext): ResidualSignal {
  const measured = ctx.toolCalls.filter((call) => call.resultChars !== null);

  let oversized = 0;
  let excessChars = 0;

  for (const [, calls] of groupBy(measured, (call) => call.name)) {
    if (calls.length < 10) continue;

    const sizes = calls.map((call) => call.resultChars ?? 0).sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
    if (median <= 0) continue;
    const threshold = median * SUB_CAP_OUTLIER_MULTIPLE;

    for (const call of calls) {
      const chars = call.resultChars ?? 0;
      if (chars > threshold && chars <= TIER_B_CAP_CHARS) {
        oversized += 1;
        excessChars += chars - threshold;
      }
    }
  }

  const value = measured.length === 0 ? 0 : oversized / measured.length;

  return signal({
    class: 'W3',
    probe: 'w3-sub-cap-oversize',
    label: 'results over their tool norm but under the cap',
    unit: 'share',
    value,
    threshold: 0.1,
    sampleSize: measured.length,
    minimumSample: 50,
    basis:
      `measured result length against ${String(SUB_CAP_OUTLIER_MULTIPLE)}\u00d7 each tool's own ` +
      `median, counting only results at or below the ${formatCount(TIER_B_CAP_CHARS)}-character ` +
      'tier-B cap — above it the guard already truncates',
    detail:
      measured.length === 0
        ? 'no tool result sizes were recorded, so payload size cannot be assessed'
        : `${formatCount(oversized)} of ${formatCount(measured.length)} measured results ` +
          `(${formatPercent(value)}) were oversized for their tool yet small enough to pass the ` +
          `cap untouched, carrying ${formatCount(excessChars)} excess characters`,
  });
}

/**
 * **W8 residual** — how much of the fleet's spend re-answers a question.
 *
 * The only probe here that reads something other than the journal: cross-
 * developer duplication is invisible from one machine, so the reading comes
 * from the D9 rollup when it has been synced and is absent otherwise. Absent is
 * the ordinary case, and it reports as an insufficient sample rather than as a
 * zero — "nobody else asked this" and "we cannot see anybody else" are not the
 * same statement.
 *
 * There is no lever to subtract. TokenLens cannot deduplicate a question five
 * people asked, so the residual is the whole class, and the probe's only job is
 * to establish that the class is actually present at a size worth a dependency.
 */
function probeCrossDeveloperRepeats(ctx: DetectContext): ResidualSignal {
  const org = ctx.org;
  const sampleSize = org?.questionsSeen ?? 0;
  const value = org?.redundantShare ?? 0;

  return signal({
    class: 'W8',
    probe: 'w8-cross-developer-repeats',
    label: 'fleet spend re-answering a known question',
    unit: 'share',
    value,
    threshold: 0.05,
    sampleSize,
    minimumSample: 200,
    basis:
      'redundant share reported by the organisation rollup \u2014 every occurrence after the first ' +
      'of a question hash seen from more than one developer, matched verbatim and never ' +
      'semantically, so the figure is a floor',
    detail:
      org === undefined
        ? 'no organisation rollup is available on this machine, so cross-developer duplication ' +
          'cannot be seen at all \u2014 which is not the same as it being absent'
        : `${formatPercent(value)} of ${formatCount(org.questionsSeen)} question(s) seen across ` +
          `${formatCount(org.developersSeen)} developer(s) were spent re-answering something the ` +
          'fleet had already answered',
  });
}

/**
 * **W11 residual** — how much of what the model is shown it never opens.
 *
 * A capped reference list would bound this; nothing caps it today, so the whole
 * class is residual. The probe exists to separate two very different corpora
 * that produce the same finding: retrieval that shows twelve files and uses ten
 * is working, and swapping it for a dependency would buy nothing. Retrieval that
 * shows twelve and uses two is guessing.
 */
function probeUnopenedReferences(ctx: DetectContext): ResidualSignal {
  const sessionOf = new Map(ctx.requests.map((request) => [request.requestId, request.sessionId]));

  const openedBySession = new Map<string, Set<string>>();
  for (const call of ctx.toolCalls) {
    if (!READ_TOOLS.has(call.name) || call.targetFileHash === null) continue;
    const opened = openedBySession.get(call.sessionId) ?? new Set<string>();
    opened.add(call.targetFileHash);
    openedBySession.set(call.sessionId, opened);
  }

  let judged = 0;
  let unopened = 0;
  for (const reference of ctx.contentReferences) {
    const sessionId = sessionOf.get(reference.requestId);
    if (sessionId === undefined) continue;
    judged += 1;
    if (!(openedBySession.get(sessionId)?.has(reference.fileHash) ?? false)) unopened += 1;
  }

  const value = judged === 0 ? 0 : unopened / judged;

  return signal({
    class: 'W11',
    probe: 'w11-unopened-references',
    label: 'files shown to the model and never opened',
    unit: 'share',
    value,
    threshold: 0.4,
    sampleSize: judged,
    minimumSample: 50,
    basis:
      'recorded content references against the files any read tool opened anywhere in the same ' +
      'session \u2014 a reference used two turns later counts as used',
    detail:
      judged === 0
        ? 'no file references were recorded, so retrieval breadth cannot be assessed'
        : `${formatCount(unopened)} of ${formatCount(judged)} references (${formatPercent(value)}) ` +
          'were paid for and never read',
  });
}

const PROBES: Readonly<Record<ResidualProbeId, (ctx: DetectContext) => ResidualSignal>> = {
  'w2-whole-file-first-reads': probeWholeFileFirstReads,
  'w3-sub-cap-oversize': probeSubCapOversize,
  'w8-cross-developer-repeats': probeCrossDeveloperRepeats,
  'w11-unopened-references': probeUnopenedReferences,
};

/** Runs one probe. Pure: the same context always yields the same signal. */
export function measureResidual(probe: ResidualProbeId, ctx: DetectContext): ResidualSignal {
  return PROBES[probe](ctx);
}

/**
 * Runs every probe the taxonomy declares, in class order.
 *
 * Driven off `CLASS_TAXONOMY` rather than off {@link PROBES} so that the set of
 * signals is decided by the classification, not by which probes happen to have
 * been written. A `residual-tool-fixable` class whose probe is missing is a
 * compile error at the taxonomy, not a silent absence at match time.
 */
export function measureResiduals(ctx: DetectContext): readonly ResidualSignal[] {
  const signals: ResidualSignal[] = [];
  for (const entry of CLASS_TAXONOMY) {
    if (entry.residual === undefined) continue;
    signals.push(measureResidual(entry.residual.probe, ctx));
  }
  return signals;
}

/** One-line summary of a signal, used by the CLI and by `--explain`. */
export function describeSignal(signalToDescribe: ResidualSignal): string {
  if (!signalToDescribe.sufficientSample) {
    return (
      `sample too small to judge (${formatCount(signalToDescribe.sampleSize)} of ` +
      `${formatCount(signalToDescribe.minimumSample)} needed)`
    );
  }
  const verdict = signalToDescribe.exceeded ? 'above' : 'at or below';
  return (
    `${formatValue(signalToDescribe.value, signalToDescribe.unit)} \u2014 ${verdict} the ` +
    `${formatValue(signalToDescribe.threshold, signalToDescribe.unit)} threshold`
  );
}
