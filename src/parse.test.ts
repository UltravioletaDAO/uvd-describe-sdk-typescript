/**
 * Rule 5 of `parse.ts` — a payload from the wrong door fails LOUD.
 *
 * From mesh's migration review (meshrelay, 2026-08-31; spec in
 * `meshrelayserv/describenet.js@04f2ecf`). Every wrong input in this file used
 * to parse "successfully" into an object full of nulls, because `wallet` is a
 * string in every shape the API serves AND in every shape this SDK returns —
 * the essential-shape check alone could not tell any of them apart. The other
 * parsers stay tested through `client.test.ts`; these tests exist because the
 * guards are reachable without HTTP (the parsers are exported for consumers
 * who hold a stored payload), and a stored payload is exactly where the wrong
 * shape comes from.
 */

import { describe, expect, it } from 'vitest';

import { WALLET_BREAKDOWN, WALLET_UNRATED, WALLET_WITH_SCORE } from './__fixtures__/live';
import { DescribeUnparseable } from './errors';
import { parseWalletBreakdown, parseWalletReputation } from './parse';

describe('rule 5 — the FREE route payload does not parse as a breakdown', () => {
  it("MOUNTS THE BAD STATE: the free route's body throws, naming the right parser", () => {
    // Before 2026-08-31 this returned { finalScore: null, weightedScore: null,
    // perChain: {} } for a wallet the free route just scored 100 — the "object
    // full of zeros" rule 3 of parse.ts declares impossible, reading as "paid
    // and got nothing" about a payload that cost nothing and said plenty.
    expect(() => parseWalletBreakdown(WALLET_WITH_SCORE, null)).toThrow(DescribeUnparseable);
    // The message has to hand the caller the door they wanted: the route it
    // recognised and the parser that owns it.
    expect(() => parseWalletBreakdown(WALLET_WITH_SCORE, null)).toThrow(/wallets\/\{wallet\}\/chains/);
    expect(() => parseWalletBreakdown(WALLET_WITH_SCORE, null)).toThrow(/parseWalletReputation/);
  });

  it('the unrated free payload (global_score: null) is caught too — the KEY decides, not the value', () => {
    // `global_score: null` is the R1 witness: the key is present, the value is
    // absent. A guard reading the VALUE would let this one through into the
    // exact all-nulls object the guard exists to forbid.
    expect(() => parseWalletBreakdown(WALLET_UNRATED, null)).toThrow(DescribeUnparseable);
  });

  it('the real breakdown payload still parses — the guard keys cannot both appear on the metered wire', () => {
    const parsed = parseWalletBreakdown(WALLET_BREAKDOWN, null);
    expect(parsed.finalScore).toBe(83.0);
    expect(parsed.weightedScore).toBe(81.412);
  });

  it('and the free payload still parses at ITS door', () => {
    expect(parseWalletReputation(WALLET_WITH_SCORE).globalScore).toBe(100);
    expect(parseWalletReputation(WALLET_UNRATED).globalScore).toBeNull();
  });
});

describe('rule 5, the inverse door — the METERED payload does not parse as the free shape', () => {
  // Added 2026-08-31 by the symmetry review against the Python twin: its
  // `models.py::parse_wallet_reputation` guards this direction, this file's
  // block above guarded only the other one, and both trees claimed mirror.
  it("MOUNTS THE BAD STATE: the metered route's body throws, naming the right parser", () => {
    // Before the guard this returned { globalScore: null, chains: [] } — in
    // silence — about a wallet the metered route just scored 83 and someone
    // just PAID to read: the unrated-vs-failure confusion (R1), manufactured
    // client-side out of the most expensive payload this SDK handles.
    expect(() => parseWalletReputation(WALLET_BREAKDOWN)).toThrow(DescribeUnparseable);
    // The message has to hand the caller the door they wanted: the route it
    // recognised and the parser that owns it.
    expect(() => parseWalletReputation(WALLET_BREAKDOWN)).toThrow(/reputation\/wallet\/\{wallet\}/);
    expect(() => parseWalletReputation(WALLET_BREAKDOWN)).toThrow(/parseWalletBreakdown/);
  });

  it('a breakdown with final_score: null is caught too — the KEY decides, not the value', () => {
    // Same discriminant as the free-door block: a guard reading the VALUE
    // would wave this one through into the exact all-nulls object it forbids.
    expect(() => parseWalletReputation({ ...WALLET_BREAKDOWN, final_score: null })).toThrow(
      DescribeUnparseable,
    );
  });
});

describe('rule 5 — output does not go back in (no re-parsing)', () => {
  it('MOUNTS THE BAD STATE: re-parsing a parsed WalletReputation throws instead of nulling everything', () => {
    const parsed = parseWalletReputation(WALLET_WITH_SCORE);
    // Before 2026-08-31: every snake_case lookup missed on the camelCase
    // object, so a wallet scored 100 with 7548 raters came back globalScore:
    // null, distinctRaters: null — silently, which is the R1 confusion
    // (unrated vs. failure) manufactured client-side out of good data.
    expect(() => parseWalletReputation(parsed)).toThrow(DescribeUnparseable);
    expect(() => parseWalletReputation(parsed)).toThrow(/already parsed/);
    // The recipe is in the message: the wire payload never left the result.
    expect(() => parseWalletReputation(parsed)).toThrow(/\.raw/);
    expect(parsed.raw).toEqual(WALLET_WITH_SCORE); // ...and it really is there
  });

  it('MOUNTS THE BAD STATE: re-parsing a parsed WalletBreakdown throws on either camelCase score key', () => {
    const parsed = parseWalletBreakdown(WALLET_BREAKDOWN, null);
    expect(() => parseWalletBreakdown(parsed, null)).toThrow(DescribeUnparseable);
    expect(() => parseWalletBreakdown(parsed, null)).toThrow(/already parsed/);
    // Both keys guard, separately: a consumer who trimmed one off their stored
    // copy is still caught by the other.
    expect(() => parseWalletBreakdown({ wallet: '0xw', finalScore: 83 }, null)).toThrow(
      DescribeUnparseable,
    );
    expect(() => parseWalletBreakdown({ wallet: '0xw', weightedScore: 81 }, null)).toThrow(
      DescribeUnparseable,
    );
  });

  it('a wire payload re-read out of `.raw` parses fine — that is the documented recipe', () => {
    const once = parseWalletReputation(WALLET_WITH_SCORE);
    const again = parseWalletReputation(once.raw);
    expect(again.globalScore).toBe(100);
  });

  it("MOUNTS THE BAD STATE: a parsed object crossing to the OTHER parser's door throws too", () => {
    // Caught by the 2026-08-31 symmetry re-check: a parsed WalletBreakdown fed
    // to parseWalletReputation carried no snake_case marker and no
    // `globalScore`, so it slipped past both guards and nulled out in silence.
    const breakdown = parseWalletBreakdown(WALLET_BREAKDOWN, null);
    expect(() => parseWalletReputation(breakdown)).toThrow(DescribeUnparseable);
    expect(() => parseWalletReputation(breakdown)).toThrow(/already parsed/);
    const reputation = parseWalletReputation(WALLET_WITH_SCORE);
    expect(() => parseWalletBreakdown(reputation, null)).toThrow(DescribeUnparseable);
    expect(() => parseWalletBreakdown(reputation, null)).toThrow(/already parsed/);
  });
});
