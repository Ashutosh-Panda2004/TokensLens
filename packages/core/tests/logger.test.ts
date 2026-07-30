import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/shared/logger.js';

describe('createLogger', () => {
  it('gates output by level: only messages at or above the configured level are emitted', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', color: false, sink: (line) => lines.push(line) });

    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(lines).toEqual([expect.stringContaining('w'), expect.stringContaining('e')]);
  });

  it('never writes ANSI escape codes when colour is disabled', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', color: false, sink: (line) => lines.push(line) });

    log.debug('d');
    log.info('i');
    log.success('s');
    log.warn('w');
    log.error('e');
    log.heading('Report');
    log.table([{ a: 1 }]);

    for (const line of lines) {
      // Deliberate control character: this is the actual ANSI escape byte
      // we are asserting was never emitted, not an accidental one.
      // eslint-disable-next-line no-control-regex
      expect(line).not.toMatch(/\u001b\[/);
    }
    expect(lines.length).toBeGreaterThan(0);
  });

  it('prefixes messages from a child logger with its scope', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', color: false, sink: (line) => lines.push(line) });
    const child = log.child('ingest');

    child.info('reading journal');

    expect(lines[0]).toContain('[ingest]');
    expect(lines[0]).toContain('reading journal');
  });

  it('nests scopes when a child logger itself creates a child', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', color: false, sink: (line) => lines.push(line) });
    const grandchild = log.child('ingest').child('journal');

    grandchild.info('parsed');

    expect(lines[0]).toContain('[ingest:journal]');
  });

  it('renders a table as a header line, a separator line, and one line per row', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', color: false, sink: (line) => lines.push(line) });

    log.table([
      { model: 'opus', credits: 97.7 },
      { model: 'haiku', credits: 1.8 },
    ]);

    expect(lines.length).toBe(4);
    expect(lines[0]).toContain('model');
    expect(lines[0]).toContain('credits');
    expect(lines[2]).toContain('opus');
    expect(lines[3]).toContain('haiku');
  });

  it('does nothing for an empty table', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', color: false, sink: (line) => lines.push(line) });
    log.table([]);
    expect(lines).toEqual([]);
  });

  it('defaults to the "info" level when TOKENLENS_LOG_LEVEL is unset', () => {
    const previous = process.env.TOKENLENS_LOG_LEVEL;
    delete process.env.TOKENLENS_LOG_LEVEL;
    try {
      expect(createLogger().level).toBe('info');
    } finally {
      if (previous !== undefined) process.env.TOKENLENS_LOG_LEVEL = previous;
    }
  });
});
