import { describe, expect, it } from 'vitest';

import { CAVEAT_CODES, hasCaveat, isKnownCaveatCode, type Caveat } from './caveats';
import { parseWalletBreakdown } from './parse';

describe('R3 — branch on code, never on text', () => {
  it('finds a caveat by its code', () => {
    const subject = {
      caveats: [
        { code: 'few-raters', text: 'Sólo 2 calificadores distintos sostienen este score.' },
      ] as Caveat[],
    };
    expect(hasCaveat(subject, 'few-raters')).toBe(true);
    expect(hasCaveat(subject, 'burn-address')).toBe(false);
  });

  it('MOUNTS THE BAD STATE: matching on text breaks when the text is reworded', () => {
    // This is the bug the `{code, text}` shape was introduced to close on
    // 2026-08-28. The thin-evidence text moved on 2026-08-25 and every
    // consumer matching on prose broke silently that day — the comparison kept
    // returning false and nobody was told.
    const before: Caveat = { code: 'few-raters', text: 'Poca evidencia: 2 calificadores.' };
    const after: Caveat = { code: 'few-raters', text: 'Sólo 2 calificadores distintos. Evidencia fina.' };

    const byText = (c: Caveat) => c.text.includes('Poca evidencia');
    expect(byText(before)).toBe(true);
    expect(byText(after)).toBe(false); // the silent break

    // Same rewording, same answer, because the code did not move.
    expect(hasCaveat({ caveats: [before] }, 'few-raters')).toBe(true);
    expect(hasCaveat({ caveats: [after] }, 'few-raters')).toBe(true);
  });

  it('tolerates a null subject — a wallet that failed open has no caveats to read', () => {
    expect(hasCaveat(null, 'no-score')).toBe(false);
    expect(hasCaveat(undefined, 'no-score')).toBe(false);
  });
});

describe('the code union is open, not closed', () => {
  it('accepts a code the server invents tomorrow', () => {
    // A closed union would make a NEW server-side code a type error in code
    // that is already deployed and working. The passthrough rule applied to
    // the type system: type what is known, CONSERVE what is not.
    const future: Caveat = { code: 'a-code-from-the-future', text: 'nuevo' };
    expect(hasCaveat({ caveats: [future] }, 'a-code-from-the-future')).toBe(true);
    expect(isKnownCaveatCode('a-code-from-the-future')).toBe(false);
    // ...and "we have not heard of it" is NOT "it is invalid": it survives.
    const parsed = parseWalletBreakdown({ wallet: '0x1', caveats: [future] }, null);
    expect(parsed.caveats).toEqual([future]);
  });

  it('knows the eight it shipped with', () => {
    for (const code of CAVEAT_CODES) expect(isKnownCaveatCode(code)).toBe(true);
  });
});

describe('parsing caveats', () => {
  it('keeps both halves — an SDK has to give a UI something to print', () => {
    // EM's Python reference keeps only the code, so nobody can render volatile
    // prose. Right for a reconciler, wrong here: dropping `text` makes every
    // consumer re-type the eight strings by hand.
    const parsed = parseWalletBreakdown(
      { wallet: '0x1', caveats: [{ code: 'self-rated', text: 'Se calificó a sí misma.' }] },
      null,
    );
    expect(parsed.caveats).toEqual([{ code: 'self-rated', text: 'Se calificó a sí misma.' }]);
  });

  it('drops an entry with no code — a caveat nobody can branch on is worse than none', () => {
    const parsed = parseWalletBreakdown(
      { wallet: '0x1', caveats: ['a bare legacy string', { text: 'no code' }, { code: 'no-score' }] },
      null,
    );
    expect(parsed.caveats).toEqual([{ code: 'no-score', text: '' }]);
  });

  it('an absent caveats field is [] and a present-but-empty one is also [] — see the scope', () => {
    // The two are genuinely different upstream ("they looked" vs "they did not
    // say"), and this SDK collapses them to [] on purpose: the distinction that
    // survives is `caveatScope`, which says WHAT the emptiness ranges over.
    // A free-route [] means "no public-data caveat", never "clean".
    expect(parseWalletBreakdown({ wallet: '0x1' }, null).caveats).toEqual([]);
    expect(parseWalletBreakdown({ wallet: '0x1', caveats: [] }, null).caveats).toEqual([]);
    expect(parseWalletBreakdown({ wallet: '0x1' }, null).caveatScope).toBe('full');
  });
});
