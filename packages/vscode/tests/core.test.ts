import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { invocationFor } from '../src/core.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Windows core invocation', () => {
  it('runs an npm command shim through its Node target', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tokenlens-vscode-core-'));
    temporaryDirectories.push(directory);
    const script = join(
      directory,
      'node_modules',
      '@tokenslens',
      'core',
      'dist',
      'cli',
      'index.js',
    );
    mkdirSync(join(script, '..'), { recursive: true });
    writeFileSync(script, '');

    const node = join(directory, 'node.exe');
    writeFileSync(node, '');
    const shim = join(directory, 'tokenlens.cmd');
    writeFileSync(
      shim,
      '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@tokenslens\\core\\dist\\cli\\index.js" %*\r\n',
    );
    const workspace = join(directory, 'workspace with spaces');

    expect(invocationFor(shim, ['hud', '--json', '--at', workspace], 'win32')).toEqual({
      file: node,
      argv: [script, 'hud', '--json', '--at', workspace],
      shell: false,
    });
  });

  it('keeps the allowlisted shell fallback for other batch files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tokenlens-vscode-core-'));
    temporaryDirectories.push(directory);
    const shim = join(directory, 'custom.cmd');
    writeFileSync(shim, '@ECHO off\r\necho custom\r\n');

    expect(invocationFor(shim, ['hud', '--json'], 'win32')).toEqual({
      file: `"${shim}" "hud" "--json"`,
      argv: [],
      shell: true,
    });
  });
});
