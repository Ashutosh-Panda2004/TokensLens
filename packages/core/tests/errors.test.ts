import { describe, it, expect } from 'vitest';
import {
  TokenLensError,
  SchemaDriftError,
  CoverageError,
  PolicyChannelError,
  ProvenanceError,
  UnsafePathError,
  UnsafeRefError,
  ConfigError,
  NotImplementedError,
} from '../src/shared/errors.js';

describe('TokenLensError', () => {
  it('refuses direct instantiation, even bypassing the type system', () => {
    expect(() => {
      // @ts-expect-error — TokenLensError is abstract; this line exists to
      // prove the runtime guard closes the gap TypeScript's compile-time
      // check leaves open for plain-JS consumers of the compiled package.
      new TokenLensError('message', {});
    }).toThrow(TypeError);
  });
});

describe('TokenLensError subclasses', () => {
  // Return types are omitted throughout this fixture table on purpose —
  // annotating eight one-line test fixtures would add noise, not safety;
  // the rule exists to guard public API surfaces, which this is not.
  /* eslint-disable @typescript-eslint/explicit-function-return-type */
  const cases = [
    {
      code: 'SCHEMA_DRIFT',
      build: () =>
        new SchemaDriftError('m', { field: 'f', expected: 'e', actual: 1, sourceFile: 's' }),
    },
    {
      code: 'COVERAGE',
      build: () =>
        new CoverageError('m', {
          field: 'f',
          observedRate: 0.1,
          minimumRate: 0.5,
          sampleSize: 10,
        }),
    },
    {
      code: 'POLICY_CHANNEL',
      build: () => new PolicyChannelError('m', { targetChannel: 'file', activeChannel: 'mdm' }),
    },
    { code: 'PROVENANCE', build: () => new ProvenanceError('m', { kind: 'modelled' }) },
    {
      code: 'UNSAFE_PATH',
      build: () => new UnsafePathError('m', { candidate: '/x', root: '/y' }),
    },
    { code: 'UNSAFE_REF', build: () => new UnsafeRefError('m', { candidate: '..' }) },
    { code: 'CONFIG', build: () => new ConfigError('m', { reason: 'malformed-json' }) },
    { code: 'NOT_IMPLEMENTED', build: () => new NotImplementedError('ledger', 'D1') },
  ] as const;
  /* eslint-enable @typescript-eslint/explicit-function-return-type */

  it.each(cases)('$code carries its discriminant, name, and context', ({ build, code }) => {
    const error = build();
    expect(error).toBeInstanceOf(TokenLensError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.name).toBe(error.constructor.name);
    expect(error.context).toBeDefined();
  });

  it('preserves the original error as `cause` when provided', () => {
    const original = new Error('root cause');
    const wrapped = new ConfigError('wrapped', { reason: 'malformed-json' }, { cause: original });
    expect(wrapped.cause).toBe(original);
  });

  it('leaves `cause` undefined when none is provided', () => {
    const error = new NotImplementedError('ledger', 'D1');
    expect(error.cause).toBeUndefined();
  });
});
