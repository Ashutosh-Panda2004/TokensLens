import { hashIdentifier } from '../privacy/identifiers.js';

/**
 * **D9.1 — managed OTel ingest, which supersedes the bespoke collector.**
 *
 * ## Why this replaces D1's journal reader at fleet scale
 *
 * D1 reads VS Code's chat journal off the local disk. That works
 * beautifully for one machine and not at all for a thousand: it needs
 * something installed everywhere, it breaks whenever the journal schema
 * moves, and it asks a security team to trust a third-party binary reading
 * a directory full of conversations.
 *
 * `chat.agentHost.otel.*` is a first-party alternative with one property
 * that matters more than all of its others: **`captureContent` defaults to
 * false and an administrator can lock it**. That converts "we promise not
 * to exfiltrate your code" from a claim about TokenLens into a control the
 * organisation enforces itself, in a setting it already manages. No amount
 * of careful redaction in this repository is worth as much as that.
 *
 * ## Why content is dropped again here anyway
 *
 * `captureContent` might be on. Somebody enabled it to debug something in
 * March and nobody turned it off. So the parser drops every content-bearing
 * attribute at the boundary and **counts** what it dropped, because a
 * silent drop is indistinguishable from an empty payload — and the count is
 * what tells an operator their fleet is emitting more than they think.
 */
export const CONTENT_ATTRIBUTES: readonly string[] = [
  'gen_ai.prompt',
  'gen_ai.completion',
  'gen_ai.content',
  'gen_ai.request.messages',
  'gen_ai.response.messages',
  'chat.prompt',
  'chat.response',
  'chat.request.content',
  'chat.tool.arguments',
  'chat.tool.result',
  'code.filepath',
  'file.path',
];

export interface OtelSpan {
  readonly name: string;
  readonly startTimeUnixNano?: string | number;
  readonly attributes?: readonly OtelAttribute[];
}

export interface OtelAttribute {
  readonly key: string;
  readonly value?: {
    readonly stringValue?: string;
    readonly intValue?: string | number;
    readonly doubleValue?: number;
    readonly boolValue?: boolean;
  };
}

export interface OtelPayload {
  readonly resourceSpans?: readonly {
    readonly resource?: { readonly attributes?: readonly OtelAttribute[] };
    readonly scopeSpans?: readonly { readonly spans?: readonly OtelSpan[] }[];
  }[];
}

export interface OtelTurn {
  readonly ts: number;
  readonly model: string;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly credits: number | undefined;
  /** Hashed. The raw value never reaches a field of this object. */
  readonly sessionId: string;
}

export interface OtelIngestResult {
  readonly turns: readonly OtelTurn[];
  readonly spansSeen: number;
  readonly spansSkipped: number;
  /** How many content-bearing attributes were dropped at the boundary. */
  readonly contentAttributesDropped: number;
  readonly detail: string;
}

/**
 * Parses an OTLP/JSON export.
 *
 * Malformed spans are skipped and counted rather than thrown on, because a
 * fleet export is a concatenation of a thousand machines' output and one
 * bad span must not discard the other 999. The count is surfaced, so
 * "skipped" never quietly becomes "fine" — that is the same S5 bargain the
 * journal reader makes.
 */
export function ingestOtel(payload: OtelPayload, salt: string): OtelIngestResult {
  const turns: OtelTurn[] = [];
  let seen = 0;
  let skipped = 0;
  let dropped = 0;

  for (const resource of payload.resourceSpans ?? []) {
    for (const scope of resource.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        seen += 1;
        const attributes = new Map<string, OtelAttribute['value']>();

        for (const attribute of span.attributes ?? []) {
          if (CONTENT_ATTRIBUTES.includes(attribute.key)) {
            dropped += 1;
            continue;
          }
          attributes.set(attribute.key, attribute.value);
        }

        const model =
          stringOf(attributes, 'gen_ai.request.model') ?? stringOf(attributes, 'chat.model');
        const ts = timestampOf(span);
        if (model === undefined || ts === undefined) {
          skipped += 1;
          continue;
        }

        const rawSession =
          stringOf(attributes, 'chat.session.id') ??
          stringOf(attributes, 'session.id') ??
          'unknown';

        turns.push({
          ts,
          model,
          promptTokens: numberOf(attributes, 'gen_ai.usage.input_tokens') ?? 0,
          outputTokens: numberOf(attributes, 'gen_ai.usage.output_tokens') ?? 0,
          credits: numberOf(attributes, 'chat.request.credits'),
          sessionId: hashIdentifier(rawSession, salt),
        });
      }
    }
  }

  return {
    turns,
    spansSeen: seen,
    spansSkipped: skipped,
    contentAttributesDropped: dropped,
    detail:
      dropped === 0
        ? `${String(turns.length)} turn(s) from ${String(seen)} span(s); ${String(skipped)} skipped for missing model or timestamp. ` +
          'No content-bearing attributes were present, which is what `captureContent: false` looks like.'
        : `${String(turns.length)} turn(s) from ${String(seen)} span(s); ${String(skipped)} skipped. ` +
          `⚠ ${String(dropped)} content-bearing attribute(s) were present and were dropped here. ` +
          'They should not have been emitted at all: `chat.agentHost.otel.captureContent` is on somewhere in ' +
          'this fleet, and an administrator can lock it off.',
  };
}

function stringOf(
  attributes: ReadonlyMap<string, OtelAttribute['value']>,
  key: string,
): string | undefined {
  const value = attributes.get(key);
  return typeof value?.stringValue === 'string' ? value.stringValue : undefined;
}

function numberOf(
  attributes: ReadonlyMap<string, OtelAttribute['value']>,
  key: string,
): number | undefined {
  const value = attributes.get(key);
  if (value === undefined) return undefined;
  if (typeof value.doubleValue === 'number') return value.doubleValue;
  if (typeof value.intValue === 'number') return value.intValue;
  if (typeof value.intValue === 'string') {
    const parsed = Number.parseInt(value.intValue, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function timestampOf(span: OtelSpan): number | undefined {
  const raw = span.startTimeUnixNano;
  if (raw === undefined) return undefined;
  // Nanoseconds since epoch, sent as a string because it overflows a double.
  const nanos = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  if (!Number.isFinite(nanos) || nanos <= 0) return undefined;
  return Math.floor(nanos / 1e6);
}

export interface OtelAvailability {
  readonly available: false;
  readonly reason: string;
  readonly unblockedBy: string;
}

/**
 * What managed OTel still cannot do, stated where an operator will read it
 * rather than discovered when a report comes out empty.
 */
export const OTEL_LIMITATIONS: readonly OtelAvailability[] = [
  {
    available: false,
    reason:
      'Tool-definition token counts are not on the OTel span. The tool-surface tax (W1), the largest ' +
      'single lever in the simulation, cannot be computed from OTel alone.',
    unblockedBy:
      'A `chat.tools.definition_tokens` attribute, or the journal reader running alongside on a sample of machines.',
  },
  {
    available: false,
    reason:
      'Cost-centre attribution needs the prompt breakdown, which is content-adjacent and therefore ' +
      'absent whenever `captureContent` is false — which is to say, correctly, almost always.',
    unblockedBy:
      'Aggregate token counts per cost centre emitted as numeric attributes, carrying no text.',
  },
];
