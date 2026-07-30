import { describe, it, expect } from 'vitest';
import { splitBufferIntoLines, parseJournalBuffer } from '../src/ingest/reader.js';

describe('splitBufferIntoLines', () => {
  it('reports the byte offset of each line, not the character offset', () => {
    // "café\n" — "é" is 2 bytes in UTF-8, so the second line does not
    // start at character-offset 5, it starts at byte-offset 6.
    const buffer = Buffer.from('café\nx\n', 'utf8');
    const lines = splitBufferIntoLines(buffer);

    expect(lines).toEqual([
      { text: 'café', offset: 0 },
      { text: 'x', offset: 6 },
    ]);
  });

  it('strips a trailing \\r for CRLF-terminated lines', () => {
    const buffer = Buffer.from('a\r\nb\r\n', 'utf8');
    const lines = splitBufferIntoLines(buffer);
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('yields a trailing line with no terminating newline', () => {
    const buffer = Buffer.from('a\nb', 'utf8');
    const lines = splitBufferIntoLines(buffer);
    expect(lines).toEqual([
      { text: 'a', offset: 0 },
      { text: 'b', offset: 2 },
    ]);
  });

  it('skips blank lines', () => {
    const buffer = Buffer.from('a\n\n\nb\n', 'utf8');
    const lines = splitBufferIntoLines(buffer);
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('returns an empty array for an empty buffer', () => {
    expect(splitBufferIntoLines(Buffer.alloc(0))).toEqual([]);
  });
});

describe('parseJournalBuffer', () => {
  it('replays a minimal snapshot + append and reports zero malformed/unrecognised', () => {
    const snapshotLine = '{"kind":0,"v":{"sessionId":"s1","requests":[]}}';
    const appendLine = '{"kind":2,"k":["requests"],"v":[{"requestId":"r1"}]}';
    const content = `${snapshotLine}\n${appendLine}\n`;
    const parsed = parseJournalBuffer(Buffer.from(content, 'utf8'), 'test.jsonl');

    expect(parsed.stats).toEqual({ totalLines: 2, malformedLines: 0, unrecognisedEnvelopes: 0 });
    expect(parsed.doc).toEqual({ sessionId: 's1', requests: [{ requestId: 'r1' }] });
    expect(parsed.requestOffsets.get(0)).toBe(Buffer.byteLength(`${snapshotLine}\n`, 'utf8'));
  });

  it('counts malformed lines without throwing', () => {
    const content = '{"kind":0,"v":{}}\nnot json\n';
    const parsed = parseJournalBuffer(Buffer.from(content, 'utf8'), 'test.jsonl');
    expect(parsed.stats.malformedLines).toBe(1);
  });

  it('tracks the latest offset that touched a given request index across several patches', () => {
    const snapshotLine = '{"kind":0,"v":{"requests":[]}}';
    const appendLine = '{"kind":2,"k":["requests"],"v":[{"requestId":"r1"}]}';
    const creditsLine = '{"kind":1,"k":["requests",0,"copilotCredits"],"v":1}';
    const content = `${snapshotLine}\n${appendLine}\n${creditsLine}\n`;
    const parsed = parseJournalBuffer(Buffer.from(content, 'utf8'), 'test.jsonl');

    const expectedOffset = Buffer.byteLength(`${snapshotLine}\n${appendLine}\n`, 'utf8');
    expect(parsed.requestOffsets.get(0)).toBe(expectedOffset);
  });
});
