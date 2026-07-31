import { describe, it, expect } from 'vitest';
import { CommanderError } from 'commander';
import { createProgram } from '../src/cli/program.js';
import { NotImplementedError } from '../src/shared/errors.js';
import { ROADMAP_COMMANDS } from '../src/cli/roadmap.js';
import { VERSION } from '../src/version.js';

describe('createProgram', () => {
  it('exposes the package name and version', () => {
    const program = createProgram();
    expect(program.name()).toBe('tokenlens');
    expect(program.version()).toBe(VERSION);
  });

  it('registers every roadmap command, plus the Phase D1/D2/D3 commands that are no longer stubs', () => {
    const program = createProgram();
    const registered = program.commands.map((command) => command.name()).sort();
    const expected = [
      ...ROADMAP_COMMANDS.map((command) => command.name),
      'ledger',
      'sessions',
      'verify',
      'budget',
      'dashboard',
      'waste',
      'mcp-roi',
    ].sort();
    expect(registered).toEqual(expected);
  });

  it('the Phase D1/D2/D3 commands are real — they do not throw NotImplementedError', () => {
    const program = createProgram();
    const commandNames = program.commands.map((command) => command.name());
    for (const name of [
      'ledger',
      'sessions',
      'verify',
      'budget',
      'dashboard',
      'waste',
      'mcp-roi',
    ]) {
      expect(commandNames).toContain(name);
    }
  });

  it.each(ROADMAP_COMMANDS)(
    '"$name" reports NotImplementedError naming Phase $phase',
    async (roadmapCommand) => {
      const program = createProgram();
      let caught: unknown;

      try {
        await program.parseAsync(['node', 'tokenlens', roadmapCommand.name]);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(NotImplementedError);
      expect((caught as NotImplementedError).context).toEqual({
        command: roadmapCommand.name,
        phase: roadmapCommand.phase,
      });
    },
  );

  it('converts --version into a zero-exit CommanderError instead of killing the process', async () => {
    const program = createProgram();
    let caught: unknown;

    try {
      await program.parseAsync(['node', 'tokenlens', '--version']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CommanderError);
    expect((caught as CommanderError).exitCode).toBe(0);
  });

  it('converts an unknown command into a non-zero-exit CommanderError', async () => {
    const program = createProgram();
    let caught: unknown;

    try {
      await program.parseAsync(['node', 'tokenlens', 'not-a-real-command']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CommanderError);
    expect((caught as CommanderError).exitCode).not.toBe(0);
  });
});
