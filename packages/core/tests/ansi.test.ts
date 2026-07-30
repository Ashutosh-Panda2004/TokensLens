import { describe, it, expect } from 'vitest';
import { ansi, isColorSupported, stripAnsi } from '../src/shared/ansi.js';

describe('isColorSupported', () => {
  const ENV_KEYS = ['NO_COLOR', 'TOKENLENS_NO_COLOR', 'FORCE_COLOR'] as const;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  function clearRelevantEnv(): void {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      Reflect.deleteProperty(process.env, key);
    }
  }

  function restoreEnv(): void {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value !== undefined) process.env[key] = value;
      else Reflect.deleteProperty(process.env, key);
    }
  }

  it('is false when NO_COLOR is set, even on a TTY', () => {
    clearRelevantEnv();
    try {
      process.env.NO_COLOR = '1';
      expect(isColorSupported({ isTTY: true })).toBe(false);
    } finally {
      restoreEnv();
    }
  });

  it('is false when TOKENLENS_NO_COLOR is set, even on a TTY', () => {
    clearRelevantEnv();
    try {
      process.env.TOKENLENS_NO_COLOR = '1';
      expect(isColorSupported({ isTTY: true })).toBe(false);
    } finally {
      restoreEnv();
    }
  });

  it('is true when FORCE_COLOR is set, even off a TTY', () => {
    clearRelevantEnv();
    try {
      process.env.FORCE_COLOR = '1';
      expect(isColorSupported({ isTTY: false })).toBe(true);
    } finally {
      restoreEnv();
    }
  });

  it('falls back to TTY detection when no override variable is set', () => {
    clearRelevantEnv();
    try {
      expect(isColorSupported({ isTTY: true })).toBe(true);
      expect(isColorSupported({ isTTY: false })).toBe(false);
    } finally {
      restoreEnv();
    }
  });

  it('NO_COLOR takes precedence over FORCE_COLOR', () => {
    clearRelevantEnv();
    try {
      process.env.NO_COLOR = '1';
      process.env.FORCE_COLOR = '1';
      expect(isColorSupported({ isTTY: true })).toBe(false);
    } finally {
      restoreEnv();
    }
  });
});

describe('ansi styling + stripAnsi', () => {
  it('wraps text in an SGR escape sequence and a reset', () => {
    expect(ansi.red('boom')).toBe('\u001b[31mboom\u001b[0m');
  });

  it('combines two SGR codes for boldCyan', () => {
    expect(ansi.boldCyan('heading')).toBe('\u001b[1;36mheading\u001b[0m');
  });

  it('stripAnsi removes exactly the escape codes, leaving the text intact', () => {
    const plain = 'plain text';
    expect(stripAnsi(ansi.bold(ansi.green(plain)))).toBe(plain);
  });

  it('stripAnsi is a no-op on text with no escape codes', () => {
    expect(stripAnsi('nothing to strip')).toBe('nothing to strip');
  });
});
