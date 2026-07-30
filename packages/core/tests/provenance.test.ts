import { describe, it, expect } from 'vitest';
import { measured, modelled, isMeasured, isModelled, render } from '../src/model/provenance.js';
import { ProvenanceError } from '../src/shared/errors.js';

describe('measured / modelled constructors', () => {
  it('constructs a measured value with source and optional byte offset', () => {
    const v = measured(97.7, 'sessions/abc.json', 1234);
    expect(v.value).toBe(97.7);
    expect(v.provenance).toEqual({ kind: 'measured', source: 'sessions/abc.json', offset: 1234 });
    expect(isMeasured(v)).toBe(true);
    expect(isModelled(v)).toBe(false);
  });

  it('constructs a measured value with no offset when one is not given', () => {
    const v = measured(44.5, 'ledger.sqlite');
    expect(v.provenance).toEqual({ kind: 'measured', source: 'ledger.sqlite' });
  });

  it('constructs a modelled value with basis and assumptions', () => {
    const v = modelled(738211, 'realisation-rate sensitivity, r=0.20', ['linear extrapolation']);
    expect(isModelled(v)).toBe(true);
    expect(isMeasured(v)).toBe(false);
    expect(v.provenance).toEqual({
      kind: 'modelled',
      basis: 'realisation-rate sensitivity, r=0.20',
      assumptions: ['linear extrapolation'],
    });
  });

  it('defaults modelled assumptions to an empty array', () => {
    const v = modelled(1, 'basis');
    expect(v.provenance).toMatchObject({ assumptions: [] });
  });
});

describe('render', () => {
  it('always includes a provenance footnote by default for measured values', () => {
    const text = render(measured(44.5, 'ledger.sqlite', 42));
    expect(text).toContain('44.5');
    expect(text).toContain('measured');
    expect(text).toContain('ledger.sqlite');
    expect(text).toContain('42');
  });

  it('always includes a provenance footnote by default for modelled values', () => {
    const text = render(modelled(2750431, 'sensitivity band r=0.90', ['46.2% reduction']));
    expect(text).toContain('2750431');
    expect(text).toContain('modelled');
    expect(text).toContain('sensitivity band r=0.90');
    expect(text).toContain('46.2% reduction');
  });

  it('refuses to render a Modelled value without its footnote', () => {
    const v = modelled(2750431, 'sensitivity band r=0.90', ['46.2% reduction']);
    expect(() => render(v, { footnote: false })).toThrow(ProvenanceError);
  });

  it('allows a footnote-free render only for Measured values', () => {
    const v = measured(44.5, 'ledger.sqlite', 42);
    expect(render(v, { footnote: false })).toBe('44.5');
  });

  it('applies a custom numeric formatter', () => {
    const v = measured(44.5, 'ledger.sqlite');
    expect(render(v, { format: (n) => `$${n.toFixed(2)}` })).toContain('$44.50');
  });
});
