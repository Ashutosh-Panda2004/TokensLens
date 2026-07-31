import { describe, it, expect } from 'vitest';
import { measureResultChars, estimateTokensFromChars } from '../src/ingest/tool-results.js';
import { extractToolCallTarget } from '../src/ingest/tool-target.js';
import { hashPath } from '../src/ingest/redact.js';

const SALT = 'test-salt';

describe('measureResultChars', () => {
  it('measures a plain string payload', () => {
    expect(measureResultChars({ content: [{ value: 'hello world' }] })).toBe(11);
  });

  it('measures a prompt-element tree, where the text lives in nested string leaves', () => {
    // This is the shape `read_file` and `grep_search` results actually take.
    // A naive String(value).length sees ~2 characters here, which is why the
    // walk exists at all.
    const tree = {
      content: [
        {
          value: {
            node: {
              ctorName: 'YLe',
              children: [
                { ctorName: 'yn', children: ['abcde'] },
                { ctorName: 'yn', children: ['fghij', 'klm'] },
              ],
            },
          },
        },
      ],
    };
    expect(measureResultChars(tree)).toBe(13);
  });

  it('ignores structural bookkeeping keys', () => {
    // `ctorName` is a minified class name on every node — counting it would
    // inflate a deep tree by thousands of characters that were never billed.
    const withStructure = {
      $mid: 21,
      type: 1,
      ctor: 2,
      ctorName: 'VeryLongClassName',
      value: 'ab',
    };
    expect(measureResultChars(withStructure)).toBe(2);
  });

  it('returns 0 for a missing result rather than throwing', () => {
    // A tool that errored, or a journal truncated mid-write, is a legitimate
    // state — not a malformed one.
    expect(measureResultChars(undefined)).toBe(0);
    expect(measureResultChars(null)).toBe(0);
  });

  it('does not count numbers or booleans as text', () => {
    expect(measureResultChars({ a: 12345, b: true })).toBe(0);
  });

  it('terminates on a self-referential structure instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { value: 'abc' };
    cyclic.self = cyclic;
    expect(() => measureResultChars(cyclic)).not.toThrow();
  });

  it('sums across arrays', () => {
    expect(measureResultChars(['ab', 'cde', ['f']])).toBe(6);
  });
});

describe('estimateTokensFromChars', () => {
  it('converts a measured character count into an estimated token count', () => {
    expect(estimateTokensFromChars(4000)).toBe(1000);
  });

  it('varies with input — it is a conversion, not a constant', () => {
    expect(estimateTokensFromChars(8000)).not.toBe(estimateTokensFromChars(4000));
  });
});

describe('extractToolCallTarget', () => {
  it('extracts and hashes the file path from a read_file call', () => {
    const target = extractToolCallTarget(
      JSON.stringify({ filePath: 'C:/repo/src/index.ts', startLine: 1, endLine: 40 }),
      SALT,
    );
    expect(target?.fileHash).toBe(hashPath('C:/repo/src/index.ts', SALT));
    expect(target?.startLine).toBe(1);
    expect(target?.endLine).toBe(40);
  });

  it('NEVER returns the raw path — only its hash', () => {
    // The redaction contract. If this ever regresses, real file paths leak
    // into the database.
    const raw = 'C:/secret-project/src/credentials.ts';
    const target = extractToolCallTarget(JSON.stringify({ filePath: raw }), SALT);

    expect(target).toBeDefined();
    expect(JSON.stringify(target)).not.toContain(raw);
    expect(JSON.stringify(target)).not.toContain('secret-project');
    expect(JSON.stringify(target)).not.toContain('credentials');
  });

  it('discards every argument that is not the path', () => {
    // Arguments carry prompts, file content, commands and queries. Only one
    // path is lifted out; everything else must be dropped on the floor.
    const target = extractToolCallTarget(
      JSON.stringify({
        filePath: 'C:/repo/a.ts',
        content: 'const apiKey = "sk-do-not-store-me";',
        query: 'how do I authenticate',
        command: 'rm -rf /',
      }),
      SALT,
    );

    const serialised = JSON.stringify(target);
    expect(serialised).not.toContain('sk-do-not-store-me');
    expect(serialised).not.toContain('authenticate');
    expect(serialised).not.toContain('rm -rf');
    expect(Object.keys(target ?? {}).sort()).toEqual(['fileHash']);
  });

  it('handles the snake_case and bare "path" variants seen on real tools', () => {
    expect(extractToolCallTarget(JSON.stringify({ path: '/tmp/x' }), SALT)?.fileHash).toBe(
      hashPath('/tmp/x', SALT),
    );
    expect(extractToolCallTarget(JSON.stringify({ file_path: '/tmp/y' }), SALT)?.fileHash).toBe(
      hashPath('/tmp/y', SALT),
    );
  });

  it('returns undefined for tools whose arguments name no file', () => {
    // The correct degradation: a detector that cannot identify a file must
    // not be handed a fabricated one.
    expect(extractToolCallTarget(JSON.stringify({ query: 'search term' }), SALT)).toBeUndefined();
    expect(extractToolCallTarget(JSON.stringify({ command: 'ls' }), SALT)).toBeUndefined();
  });

  it('survives malformed or absent argument JSON', () => {
    expect(extractToolCallTarget('not json at all', SALT)).toBeUndefined();
    expect(extractToolCallTarget(undefined, SALT)).toBeUndefined();
    expect(extractToolCallTarget('[]', SALT)).toBeUndefined();
    expect(extractToolCallTarget('null', SALT)).toBeUndefined();
  });

  it('hashes the same path to the same value, and different paths differently', () => {
    // Stability within an install is what lets W2 say "this is the same file".
    const a = extractToolCallTarget(JSON.stringify({ filePath: '/a' }), SALT);
    const b = extractToolCallTarget(JSON.stringify({ filePath: '/a' }), SALT);
    const c = extractToolCallTarget(JSON.stringify({ filePath: '/b' }), SALT);

    expect(a?.fileHash).toBe(b?.fileHash);
    expect(a?.fileHash).not.toBe(c?.fileHash);
  });

  it('produces different hashes for the same path under different salts', () => {
    // Per-install salting is what stops an org rollup correlating a path
    // across two developers' machines.
    const one = extractToolCallTarget(JSON.stringify({ filePath: '/a' }), 'salt-one');
    const two = extractToolCallTarget(JSON.stringify({ filePath: '/a' }), 'salt-two');
    expect(one?.fileHash).not.toBe(two?.fileHash);
  });
});
