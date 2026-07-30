import { describe, it, expect, vi, afterEach } from 'vitest';
import { printLine, printHeading, printTable, printJson } from '../src/cli/output.js';

describe('cli output (stdout)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function captureStdout(): string[] {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    return lines;
  }

  it('printLine writes exactly the given text plus one newline', () => {
    const lines = captureStdout();
    printLine('hello');
    expect(lines).toEqual(['hello\n']);
  });

  it('printLine with no argument writes a blank line', () => {
    const lines = captureStdout();
    printLine();
    expect(lines).toEqual(['\n']);
  });

  it('printHeading writes a blank line, the heading, and an underline of matching length', () => {
    const lines = captureStdout();
    printHeading('Report');
    expect(lines).toEqual([
      '\n',
      expect.stringContaining('Report'),
      expect.stringContaining('──────'),
    ]);
  });

  it('printTable renders a header, separator, and one line per row', () => {
    const lines = captureStdout();
    printTable([
      { model: 'opus', credits: 10 },
      { model: 'haiku', credits: 1 },
    ]);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('model');
    expect(lines[2]).toContain('opus');
    expect(lines[3]).toContain('haiku');
  });

  it('printTable does nothing for an empty array', () => {
    const lines = captureStdout();
    printTable([]);
    expect(lines).toEqual([]);
  });

  it('printJson pretty-prints the given value', () => {
    const lines = captureStdout();
    printJson({ a: 1 });
    expect(lines[0]).toBe(`${JSON.stringify({ a: 1 }, null, 2)}\n`);
  });
});
