import { describe, it, expect } from 'vitest';
import { ROADMAP_COMMANDS } from '../src/cli/roadmap.js';

describe('ROADMAP_COMMANDS', () => {
  it('has unique, lower-kebab-case command names', () => {
    const names = ROADMAP_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z-]*$/);
    }
  });

  it('gives every command a real, non-trivial summary', () => {
    for (const command of ROADMAP_COMMANDS) {
      expect(command.summary.length).toBeGreaterThan(10);
      expect(command.summary.trim().endsWith('.')).toBe(true);
    }
  });

  it('tags every command with a valid development phase', () => {
    for (const command of ROADMAP_COMMANDS) {
      expect(command.phase).toMatch(/^D[1-6]$/);
    }
  });
});
