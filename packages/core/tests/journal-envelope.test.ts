import { describe, it, expect } from 'vitest';
import {
  parseEnvelope,
  applyEnvelope,
  replayEnvelopes,
  isEnvelopeShaped,
} from '../src/ingest/journal-envelope.js';

describe('isEnvelopeShaped', () => {
  it('accepts any object with a kind property', () => {
    expect(isEnvelopeShaped({ kind: 0 })).toBe(true);
    expect(isEnvelopeShaped({ kind: 'anything' })).toBe(true);
  });

  it('rejects non-objects and objects without kind', () => {
    expect(isEnvelopeShaped(null)).toBe(false);
    expect(isEnvelopeShaped('x')).toBe(false);
    expect(isEnvelopeShaped({})).toBe(false);
  });
});

describe('parseEnvelope', () => {
  it('parses a snapshot (kind 0) regardless of v', () => {
    expect(parseEnvelope({ kind: 0, v: { a: 1 } })).toEqual({ kind: 0, v: { a: 1 } });
  });

  it('parses a set (kind 1) with a valid path', () => {
    expect(parseEnvelope({ kind: 1, k: ['requests', 0, 'x'], v: 42 })).toEqual({
      kind: 1,
      k: ['requests', 0, 'x'],
      v: 42,
    });
  });

  it('parses an append (kind 2) with a valid path and array value', () => {
    expect(parseEnvelope({ kind: 2, k: ['requests'], v: [1, 2] })).toEqual({
      kind: 2,
      k: ['requests'],
      v: [1, 2],
    });
  });

  it('rejects an unknown kind', () => {
    expect(parseEnvelope({ kind: 99, k: [], v: 1 })).toBeUndefined();
  });

  it('rejects kind 1 with a non-array k', () => {
    expect(parseEnvelope({ kind: 1, k: 'not-an-array', v: 1 })).toBeUndefined();
  });

  it('rejects kind 2 with a non-array v', () => {
    expect(parseEnvelope({ kind: 2, k: ['requests'], v: 'not-an-array' })).toBeUndefined();
  });

  it('rejects a path containing a non-string, non-number segment', () => {
    expect(parseEnvelope({ kind: 1, k: ['requests', {}], v: 1 })).toBeUndefined();
  });
});

describe('applyEnvelope', () => {
  it('kind 0 replaces the document outright', () => {
    const result = applyEnvelope({ old: true }, { kind: 0, v: { fresh: true } });
    expect(result).toEqual({ doc: { fresh: true }, recognised: true });
  });

  it('kind 1 sets a value at an existing path', () => {
    const doc = { requests: [{ x: 1 }] };
    const result = applyEnvelope(doc, { kind: 1, k: ['requests', 0, 'x'], v: 99 });
    expect(result.recognised).toBe(true);
    expect(doc).toEqual({ requests: [{ x: 99 }] });
  });

  it('kind 1 auto-vivifies missing intermediate objects and arrays', () => {
    const doc: Record<string, unknown> = {};
    applyEnvelope(doc, {
      kind: 1,
      k: ['requests', 0, 'result', 'metadata', 'promptTokens'],
      v: 100,
    });
    expect(doc).toEqual({ requests: [{ result: { metadata: { promptTokens: 100 } } }] });
  });

  it('kind 2 appends onto an existing array', () => {
    const doc = { requests: [1, 2] };
    applyEnvelope(doc, { kind: 2, k: ['requests'], v: [3, 4] });
    expect(doc).toEqual({ requests: [1, 2, 3, 4] });
  });

  it('kind 2 creates the array if it does not exist yet', () => {
    const doc: Record<string, unknown> = {};
    applyEnvelope(doc, { kind: 2, k: ['requests'], v: [1] });
    expect(doc).toEqual({ requests: [1] });
  });
});

describe('replayEnvelopes', () => {
  it('replays a realistic sequence: snapshot, set, append', () => {
    const { doc, unrecognisedCount } = replayEnvelopes([
      { kind: 0, v: { sessionId: 's1', requests: [] } },
      { kind: 2, k: ['requests'], v: [{ requestId: 'r1' }] },
      { kind: 1, k: ['requests', 0, 'copilotCredits'], v: 12.5 },
    ]);

    expect(unrecognisedCount).toBe(0);
    expect(doc).toEqual({
      sessionId: 's1',
      requests: [{ requestId: 'r1', copilotCredits: 12.5 }],
    });
  });

  it('counts unrecognised envelopes without throwing, and still applies the recognised ones', () => {
    const { doc, unrecognisedCount } = replayEnvelopes([
      { kind: 0, v: { requests: [] } },
      { kind: 7 }, // unknown kind
      { kind: 2, k: ['requests'], v: [1] },
    ]);

    expect(unrecognisedCount).toBe(1);
    expect(doc).toEqual({ requests: [1] });
  });

  it('produces an undefined document when given no envelopes', () => {
    const { doc, unrecognisedCount } = replayEnvelopes([]);
    expect(doc).toBeUndefined();
    expect(unrecognisedCount).toBe(0);
  });
});
