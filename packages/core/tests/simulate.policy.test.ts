import { describe, it, expect } from 'vitest';
import {
  NULL_POLICY,
  parsePolicy,
  parsePolicyBuffer,
  stringifyPolicy,
} from '../src/simulate/policy.js';
import { PolicySyntaxError } from '../src/shared/errors.js';

describe('policy DSL', () => {
  it('parses the documented example', () => {
    const { policy } = parsePolicy(`
version: 1
model:
  default: gpt-4.1
  route:
    - when: { complexity: low }
      to: gpt-4.1-mini
tools:
  allow_mcp: [aws, github]
  deny: ["legacy_*"]
payload:
  max_result_tokens: 4000
session:
  max_rounds: 25
  nudge_after_turns: 20
retrieval:
  dedupe_reads: true
`);

    expect(policy).toEqual({
      version: 1,
      model: { default: 'gpt-4.1', route: [{ when: { complexity: 'low' }, to: 'gpt-4.1-mini' }] },
      tools: { allowMcp: ['aws', 'github'], deny: ['legacy_*'] },
      payload: { maxResultTokens: 4000 },
      session: { maxRounds: 25, nudgeAfterTurns: 20 },
      retrieval: { dedupeReads: true },
    });
  });

  it('treats an empty document as the null policy rather than an error', () => {
    expect(parsePolicy('').policy).toEqual(NULL_POLICY);
    expect(parsePolicy('# only a comment\n').policy).toEqual(NULL_POLICY);
  });

  /**
   * The defect this prevents is subtle and expensive: a mistyped key that
   * parses cleanly, is ignored, and produces a simulation reporting zero
   * saving for a lever the user believes they configured. They conclude the
   * lever does not work. Refusing to run is the only outcome that cannot be
   * read as an answer.
   */
  it('refuses an unknown key instead of ignoring it, and suggests the correction', () => {
    let thrown: unknown;
    try {
      parsePolicy('version: 1\npayload:\n  max_results_tokens: 4000\n');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PolicySyntaxError);
    const error = thrown as PolicySyntaxError;
    expect(error.code).toBe('POLICY_SYNTAX');
    expect(error.context.at).toBe('payload.max_results_tokens');
    expect(error.message).toContain('Did you mean `max_result_tokens`');
  });

  it('names the file and the exact path when a value has the wrong type', () => {
    const attempt = (): unknown =>
      parsePolicy('version: 1\npayload:\n  max_result_tokens: "4000"\n', {
        filePath: '.tokenlens/policy.yml',
      });

    expect(attempt).toThrow(/payload\.max_result_tokens/);
    expect(attempt).toThrow(/\.tokenlens\/policy\.yml/);
    // A quoted number is not silently coerced: a policy is a financial
    // instruction, and leniency here hides the next mis-parse.
    expect(attempt).toThrow(/Expected a positive whole number/);
  });

  it('requires an explicit version so a policy written today survives a DSL change', () => {
    expect(() => parsePolicy('model:\n  default: x\n')).toThrow(/version/);
    expect(() => parsePolicy('version: 2\n')).toThrow(/version/);
  });

  it('rejects a routing rule with no condition, pointing at `model.default` instead', () => {
    expect(() =>
      parsePolicy('version: 1\nmodel:\n  route:\n    - when: {}\n      to: cheap\n'),
    ).toThrow(/model\.default/);
  });

  it('rejects a complexity band that is not one of the three', () => {
    expect(() =>
      parsePolicy(
        'version: 1\nmodel:\n  route:\n    - when: { complexity: trivial }\n      to: cheap\n',
      ),
    ).toThrow(/low, medium, high/);
  });

  it('reports malformed YAML as a policy error rather than letting the parser escape', () => {
    expect(() => parsePolicy('version: 1\n  bad:\n indentation\n')).toThrow(PolicySyntaxError);
  });

  /**
   * `retrieval.exclude` is a real policy line that this phase genuinely
   * cannot cost, because P7 hashes retrieval paths at ingest. Accepting it
   * and stating the omission is the only option that neither blocks the
   * user from writing a complete policy nor implies the line was priced.
   */
  it('accepts recognised keys it cannot cost, and records why', () => {
    const { policy, notSimulated } = parsePolicy(`
version: 1
retrieval:
  exclude: ["**/dist/**"]
  dedupe_reads: true
payload:
  compress_terminal_output: true
  max_result_tokens: 4000
`);

    expect(policy.retrieval).toEqual({ dedupeReads: true });
    expect(notSimulated.map((entry) => entry.at).sort()).toEqual([
      'payload.compress_terminal_output',
      'retrieval.exclude',
    ]);

    const exclude = notSimulated.find((entry) => entry.at === 'retrieval.exclude');
    expect(exclude?.reason).toMatch(/hashed/);
    expect(exclude?.unblockedBy).toBeTruthy();
  });

  it('round-trips through YAML unchanged', () => {
    const source = `
version: 1
model:
  route:
    - when: { complexity: low, max_rounds: 4 }
      to: cheap
tools:
  deny: [a, b]
payload:
  max_result_tokens: 4000
session:
  max_rounds: 25
  nudge_after_turns: 8
retrieval:
  dedupe_reads: true
`;
    const first = parsePolicy(source).policy;
    expect(parsePolicy(stringifyPolicy(first)).policy).toEqual(first);
  });

  /**
   * Piping `--emit-policy` to a file in Windows PowerShell 5.1 produces
   * UTF-16LE, because that is `>`'s default there. Read back as UTF-8 it is
   * a string of interleaved NULs, and the user is told the policy file the
   * tool just generated is malformed. Being strict about content is the
   * point; being strict about the shell's encoding defaults is not.
   */
  it('reads a policy file whatever byte-order mark the shell wrote', () => {
    const yaml = 'version: 1\npayload:\n  max_result_tokens: 4000\n';
    const expected = { version: 1, payload: { maxResultTokens: 4000 } };

    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(yaml, 'utf16le')]);
    const utf16be = Buffer.from(utf16le);
    utf16be.subarray(2).swap16();
    utf16be[0] = 0xfe;
    utf16be[1] = 0xff;
    const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(yaml, 'utf8')]);

    expect(parsePolicyBuffer(Buffer.from(yaml, 'utf8')).policy).toEqual(expected);
    expect(parsePolicyBuffer(utf8Bom).policy).toEqual(expected);
    expect(parsePolicyBuffer(utf16le).policy).toEqual(expected);
    expect(parsePolicyBuffer(utf16be).policy).toEqual(expected);
  });

  it('does not reprint the whole file when the top level is the wrong type', () => {
    const long = `"${'x'.repeat(5_000)}"`;
    let message = '';
    try {
      parsePolicy(long);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('…');
    expect(message.length).toBeLessThan(300);
  });
});
