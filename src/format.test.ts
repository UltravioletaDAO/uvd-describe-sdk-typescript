import { describe, expect, it } from 'vitest';

import { formatScore, roundScore } from './format';

/**
 * R8 — the canonical display format.
 *
 * The witness case goes first on purpose: `83.0 -> "83"` is the ONE value that
 * tells the three candidate rules apart (`toFixed(2)` gives `"83.00"`,
 * `toFixed(1)` gives `"83.0"`, and only trimming gives `"83"`). A suite that
 * tested only `86.653045` would pass under two wrong rules.
 */
describe('formatScore — canonical display (R8)', () => {
  it('83.0 renders as "83" — the witness case', () => {
    expect(formatScore(83.0)).toBe('83');
  });

  it('is wrong under the two rules the witness case exists to reject', () => {
    // Mounting the bad state: these are what the discarded rules produce.
    expect((83.0).toFixed(2)).toBe('83.00');
    expect((83.0).toFixed(1)).toBe('83.0');
    expect(formatScore(83.0)).not.toBe('83.00');
    expect(formatScore(83.0)).not.toBe('83.0');
  });

  it.each([
    [86.653045, '86.65'],
    [84.7, '84.7'],
    [87, '87'],
    [82.0, '82'],
    [100.0, '100'],
    [52.5, '52.5'],
    [76.25, '76.25'],
  ])('formats %s as "%s"', (input, expected) => {
    expect(formatScore(input)).toBe(expected);
  });

  it('rounds half away from zero the same way toFixed does', () => {
    // Not a claim about correctness, a claim about SAMENESS: whatever the
    // rounding does, both languages must do it identically. Python's
    // f"{round(x,2):g}" and this must not disagree on a boundary.
    expect(formatScore(86.655)).toBe(String(parseFloat((86.655).toFixed(2))));
  });
});

describe('formatScore — absence (R1)', () => {
  it('null in, null out — never "0"', () => {
    expect(formatScore(null)).toBeNull();
    expect(formatScore(undefined)).toBeNull();
  });

  it('never returns a placeholder string', () => {
    // Choosing what absence looks like is the surface's job. Returning "0",
    // "—" or "N/A" here would publish this package's taste — and "0" in
    // particular would say "worst possible reputation" for "not yet rated".
    for (const absent of [null, undefined]) {
      expect(formatScore(absent)).not.toBe('0');
      expect(formatScore(absent)).not.toBe('');
    }
  });

  it('a real zero is still a zero — absence is not the same as a 0 score', () => {
    expect(formatScore(0)).toBe('0');
  });

  it('rejects NaN and Infinity: a number we cannot name gets no attribution', () => {
    expect(formatScore(Number.NaN)).toBeNull();
    expect(formatScore(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('roundScore', () => {
  it('keeps a number and trims the same way', () => {
    expect(roundScore(83.0)).toBe(83);
    expect(roundScore(86.653045)).toBe(86.65);
    expect(roundScore(null)).toBeNull();
    expect(roundScore(Number.NaN)).toBeNull();
  });
});
