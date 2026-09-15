import { describe, expect, it } from 'vitest';

import {
  AGENT_WITH_AUTHOR_CLASSES,
  WALLET_BREAKDOWN,
  WALLET_DECLARES_NOT_COMPUTED,
  WALLET_UNRATED_DECLARES_NOT_COMPUTED,
  WALLET_WITH_SCORE,
} from './__fixtures__/live';
import { mockServer } from './__fixtures__/server';
import {
  AUTHOR_CLASSES,
  CAVEAT_CODES,
  CaveatsNotComputedError,
  hasCaveat,
  isKnownAuthorClass,
  isKnownCaveatCode,
  requireFullCaveats,
  type Caveat,
} from './caveats';
import { DescribeClient } from './client';
import { DescribeError, failedAfterPaying, failOpenCovers } from './errors';
import { parseAgentReputation, parseWalletBreakdown, parseWalletReputation } from './parse';
import type { WalletReputation } from './types';

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

  it('knows every code it ships with', () => {
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
    // ⚠️ Since 0.4.0 the free route also says WHICH cuts the emptiness skipped:
    // `caveatsNotComputed`, below — and THAT one does not collapse its absence.
    expect(parseWalletBreakdown({ wallet: '0x1' }, null).caveats).toEqual([]);
    expect(parseWalletBreakdown({ wallet: '0x1', caveats: [] }, null).caveats).toEqual([]);
    expect(parseWalletBreakdown({ wallet: '0x1' }, null).caveatScope).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// 0.4.0 — what describe.net shipped on 2026-09-14
// ---------------------------------------------------------------------------

/** The seven names the free route declared on 2026-09-15, sorted as served. */
const LIVE_NOT_COMPUTED = [
  'campaign-per-rater',
  'concentration-degraded',
  'few-raters',
  'no-score',
  'self-rated',
  'single-rater',
  'top-client-share',
];

/**
 * Run the gate and hand back its refusal, so the fields can be asserted.
 *
 * `toThrow()` alone would pass on ANY throw — including the `TypeError` of a gate
 * that broke on a missing field — and a test of a fail-closed gate that cannot
 * tell "refused" from "crashed" is not testing the gate.
 */
function refusal(run: () => unknown): CaveatsNotComputedError {
  try {
    run();
  } catch (e) {
    if (e instanceof CaveatsNotComputedError) return e;
    throw e;
  }
  throw new Error('expected requireFullCaveats() to refuse, and it passed');
}

describe('caveatsNotComputed — the free answer names the cuts it did not run', () => {
  it('parses the live declaration verbatim (captured 2026-09-15)', () => {
    const rep = parseWalletReputation(WALLET_DECLARES_NOT_COMPUTED);
    expect(rep.caveatsNotComputed).toEqual(LIVE_NOT_COMPUTED);
    // Every name served is one this SDK can branch on.
    for (const code of rep.caveatsNotComputed ?? []) expect(isKnownCaveatCode(code)).toBe(true);
  });

  it('the declaration is about the route, not the subject', () => {
    const unrated = parseWalletReputation(WALLET_UNRATED_DECLARES_NOT_COMPUTED);
    expect(unrated.globalScore).toBeNull();
    expect(unrated.caveatsNotComputed).toEqual(LIVE_NOT_COMPUTED);
  });

  it('🔴 MOUNTS THE BAD STATE: an answer from before 2026-09-14 is null, NOT []', () => {
    // `WALLET_WITH_SCORE` was captured live on 2026-08-30, before the field
    // existed. Mutation that turns this red: `strArray(...) ?? []` in
    // `parse.ts` — which is also the mutation that makes the gate below pass an
    // undeclared answer green.
    expect('caveats_not_computed' in WALLET_WITH_SCORE).toBe(false);
    expect(parseWalletReputation(WALLET_WITH_SCORE).caveatsNotComputed).toBeNull();

    // ...and a declared empty list stays a declared empty list.
    const empty = parseWalletReputation({ ...WALLET_WITH_SCORE, caveats_not_computed: [] });
    expect(empty.caveatsNotComputed).toEqual([]);
    expect(empty.caveatsNotComputed).not.toBeNull();
  });

  it('a declaration that cannot be read WHOLE is null — never a pass, never a shorter list', () => {
    // Mutation that turns this red: `continue` instead of `return null` on a bad
    // entry in `parseNotComputed` — a filtered list, where `[null]` becomes the
    // `[]` that opens the gate. Same shapes as the Python twin's parser.
    const unreadable: unknown[] = [
      7, // the bare count floated on 2026-08-31 and rejected upstream for a list
      'few-raters',
      [null],
      [7],
      ['few-raters', ''],
      ['few-raters', 42],
    ];
    for (const value of unreadable) {
      const rep = parseWalletReputation({ ...WALLET_WITH_SCORE, caveats_not_computed: value });
      expect(rep.caveatsNotComputed, JSON.stringify(value)).toBeNull();
    }
  });
});

describe('requireFullCaveats — a gate that can fail someone', () => {
  it('🔴 MOUNTS THE BAD STATE: the gate karma-hello found passes a wallet it knows nothing about', () => {
    const rep = parseWalletReputation(WALLET_DECLARES_NOT_COMPUTED);

    // The honest gate a consumer writes on the free route: no bad caveat fired,
    // so the wallet passes. It passes EVERY wallet — the cuts never ran.
    const naiveGate = (r: { caveats: Caveat[] }) =>
      !hasCaveat(r, 'single-rater') && !hasCaveat(r, 'few-raters');
    expect(rep.caveats).toEqual([]);
    expect(naiveGate(rep)).toBe(true);

    // The gate that reads the declaration refuses, naming what was never run.
    const e = refusal(() => requireFullCaveats(rep));
    expect(e.notComputed).toEqual(LIVE_NOT_COMPUTED);
    expect(e.wallet).toBe(WALLET_DECLARES_NOT_COMPUTED.wallet);
    expect(e.message).toContain('single-rater');
  });

  it('🔴 MOUNTS THE BAD STATE: the refusal is NOT a DescribeError — a fail-open catch cannot swallow it', () => {
    // The wrapper consumers really write around this SDK: a DescribeError is
    // "describe.net is down", so they answer `null` and carry on — and a gate
    // that tolerates outages lets the subject through. If the refusal were a
    // DescribeError (this package's first draft), it would vanish right here.
    // Mutation that turns this red: `extends DescribeUnparseable` on the class.
    const failOpen = <T>(run: () => T): T | null => {
      try {
        return run();
      } catch (e) {
        if (e instanceof DescribeError) return null;
        throw e;
      }
    };
    const rep = parseWalletReputation(WALLET_DECLARES_NOT_COMPUTED);
    expect(() => failOpen(() => requireFullCaveats(rep))).toThrow(CaveatsNotComputedError);

    const e = refusal(() => requireFullCaveats(rep));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(DescribeError);
    expect(e.name).toBe('CaveatsNotComputedError');
    expect(failOpenCovers(e)).toBe(false);
    expect(failedAfterPaying(e)).toBe(false);
  });

  it('its recovery is one frozen literal — never the wallet, never the codes', () => {
    // Mutation that turns this red: appending the wallet to the instance's
    // recovery. The specifics belong in `message`; `recovery` is the string that
    // gets pasted into tickets, so it interpolates nothing (invariant 11).
    const declared = refusal(() => requireFullCaveats(parseWalletReputation(WALLET_DECLARES_NOT_COMPUTED)));
    const undeclared = refusal(() => requireFullCaveats(parseWalletReputation(WALLET_WITH_SCORE)));
    for (const e of [declared, undeclared]) {
      expect(e.recovery).toBe(CaveatsNotComputedError.recovery);
      expect(e.recovery).not.toContain(e.wallet);
      expect(e.recovery).not.toContain('single-rater');
      expect(e.message).toContain(e.wallet);
    }
    expect(CaveatsNotComputedError.recovery).toContain('GET /reputation/wallet/{wallet}');
    expect(CaveatsNotComputedError.recovery.length).toBeGreaterThan(120);
  });

  it('🔴 null is not []: an undeclared answer THROWS, and says it does not know which', () => {
    // Mutation that turns this red: `return result` on the undeclared branch —
    // "no declaration, nothing to refuse". Every payload cached before
    // 2026-09-14 would then walk through green.
    const e = refusal(() => requireFullCaveats(parseWalletReputation(WALLET_WITH_SCORE)));
    expect(e.notComputed).toBeNull();
    expect(e.wallet).toBe(WALLET_WITH_SCORE.wallet);
  });

  it('a result stored by 0.3.0 — no such key at all — is undeclared, not a wrong argument', () => {
    const { caveatsNotComputed: _dropped, ...stored } = parseWalletReputation(WALLET_DECLARES_NOT_COMPUTED);
    const e = refusal(() => requireFullCaveats(stored as unknown as WalletReputation));
    expect(e.notComputed).toBeNull();
  });

  it('a declared [] passes, and hands back the same object', () => {
    // Mutation that turns this red: dropping the `length === 0` early return.
    const complete = parseWalletReputation({ ...WALLET_DECLARES_NOT_COMPUTED, caveats_not_computed: [] });
    expect(requireFullCaveats(complete)).toBe(complete);
  });

  it('🔴 it takes a WalletReputation and nothing else — a TypeError, never a pass, never the refusal', () => {
    // Mutation that turns this red: removing the shape check. A breakdown would
    // then be refused as "undeclared" (the wrong message for a wrong argument),
    // and a null would die on a property read with a message nobody wrote.
    const wrong: Array<[string, unknown]> = [
      ['a metered WalletBreakdown', parseWalletBreakdown(WALLET_BREAKDOWN, null)],
      ['a metered AgentReputation', parseAgentReputation(AGENT_WITH_AUTHOR_CLASSES, null)],
      ['null (describe.net did not answer)', null],
      ['the raw wire payload, never parsed', WALLET_DECLARES_NOT_COMPUTED],
    ];
    for (const [label, value] of wrong) {
      let thrown: unknown;
      try {
        requireFullCaveats(value as WalletReputation);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, label).toBeInstanceOf(TypeError);
      expect((thrown as Error).message, label).toContain('requireFullCaveats() takes the WalletReputation');
    }
  });

  it('end to end: the free call answers, nothing is announced, and the gate refuses it', async () => {
    const wallet = WALLET_DECLARES_NOT_COMPUTED.wallet;
    const server = mockServer({ [`/wallets/${wallet}/chains`]: { body: WALLET_DECLARES_NOT_COMPUTED } });
    const announced: unknown[] = [];
    const client = new DescribeClient({
      jitterMs: 0,
      fetchImpl: server.fetch,
      onFailure: (f) => announced.push(f),
    });

    const rep = await client.wallet(wallet);
    if (rep === null) throw new Error('the mocked free route should have answered');
    expect(rep.caveatsNotComputed).toEqual(LIVE_NOT_COMPUTED);
    expect(() => requireFullCaveats(rep)).toThrow(CaveatsNotComputedError);
    // An honest answer is not a failure of the client: `onFailure` stays quiet.
    expect(announced).toEqual([]);
  });
});

describe('authorClass — who signed the row', () => {
  it('parses both known classes, and leaves the rest of the row alone', () => {
    const agent = parseAgentReputation(AGENT_WITH_AUTHOR_CLASSES, null);
    expect(agent.ratings.map((r) => r.authorClass)).toEqual(['facilitator-authored', 'rater-authored']);
    for (const r of agent.ratings) expect(r.malformedHashes).toEqual([]);
  });

  it('absent is null — NOT rater-authored, which the index says proves nothing', () => {
    const { author_class: _dropped, ...row } = AGENT_WITH_AUTHOR_CLASSES.ratings[1];
    const [parsed] = parseAgentReputation({ ...AGENT_WITH_AUTHOR_CLASSES, ratings: [row] }, null).ratings;
    expect(parsed.authorClass).toBeNull();
  });

  it('🔴 an unknown class is tolerated verbatim — never thrown, never nulled', () => {
    // Mutations that turn this red: a closed check in `parseRatings`, either
    // throwing on a class outside `AUTHOR_CLASSES` or mapping it to `null`.
    const row = { ...AGENT_WITH_AUTHOR_CLASSES.ratings[1], author_class: 'bridge-authored' };
    const payload = { ...AGENT_WITH_AUTHOR_CLASSES, ratings: [row] };

    expect(() => parseAgentReputation(payload, null)).not.toThrow();
    const [parsed] = parseAgentReputation(payload, null).ratings;
    expect(parsed.authorClass).toBe('bridge-authored');
    expect(isKnownAuthorClass('bridge-authored')).toBe(false);
    expect(parsed.txHash).toBe(row.tx_hash);
    expect(parsed.malformedHashes).toEqual([]);
  });

  it('a class that is not a string, or is empty, is null — there is nothing to keep', () => {
    for (const value of [1, '', true, { class: 'rater-authored' }]) {
      const row = { ...AGENT_WITH_AUTHOR_CLASSES.ratings[1], author_class: value };
      const [parsed] = parseAgentReputation({ ...AGENT_WITH_AUTHOR_CLASSES, ratings: [row] }, null).ratings;
      expect(parsed.authorClass, JSON.stringify(value)).toBeNull();
    }
  });

  it('knows the two it ships with, and a missing class is not one of them', () => {
    for (const c of AUTHOR_CLASSES) expect(isKnownAuthorClass(c)).toBe(true);
    // `null` is a row served before 2026-09-14: not invalid, not known either.
    expect(isKnownAuthorClass(null)).toBe(false);
    expect(isKnownAuthorClass(undefined)).toBe(false);
  });

  it('the facilitator-authored caveat is a known code, and it points at rows the READER counts', () => {
    expect(isKnownCaveatCode('facilitator-authored')).toBe(true);
    const agent = parseAgentReputation(AGENT_WITH_AUTHOR_CLASSES, null);
    expect(hasCaveat(agent, 'facilitator-authored')).toBe(true);
    // No count by author class ships in the answer or in this SDK (cancelled
    // upstream on 2026-08-29); filtering the rows you bought is yours to do.
    expect(agent.ratings.filter((r) => r.authorClass === 'facilitator-authored')).toHaveLength(1);
  });
});
