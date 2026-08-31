import { describe, expect, it } from 'vitest';

import { resolveDistinctRaters } from './raters';

/**
 * Aporte ② — MeshRelay's distinct-rater helper, and the two reconstructions
 * that are both wrong.
 *
 * The headline vector is live. `0xcc28cee3a1433493de119efe8cd218ff7c0e4821`,
 * read from `GET /wallets/{w}/chains` on 2026-08-30: global **129**, base
 * **113**, ethereum **21**. It is the fixture worth having because the two
 * wrong answers land on OPPOSITE sides of the right one — the maximum is 16
 * short, the sum is 5 over — so no accident produces 129.
 */

/** The live vector. Global 129; max would say 113; sum would say 134. */
const LIVE = {
  distinctRaters: 129,
  chains: [
    { network: 'base', distinctRaters: 113 },
    { network: 'ethereum', distinctRaters: 21 },
  ],
};

describe('the global figure is the answer, and neither reconstruction is', () => {
  it('returns the index\'s own count, not the max and not the sum', () => {
    const answer = resolveDistinctRaters(LIVE);

    expect(answer).toBe(129);
    // Spelled out rather than implied: these are the two numbers a consumer
    // would have computed by hand, and both are wrong on live data.
    const max = Math.max(...LIVE.chains.map((c) => c.distinctRaters));
    const sum = LIVE.chains.reduce((t, c) => t + c.distinctRaters, 0);
    expect(max).toBe(113);
    expect(sum).toBe(134);
    expect(answer).not.toBe(max);
    expect(answer).not.toBe(sum);
  });

  it('MOUNTS THE BAD STATE: preferring the per-chain maximum understates it', () => {
    // This is the discriminant. Flip the first branch of `resolveDistinctRaters`
    // to compute the maximum first — which is what the helper's original name
    // invited — and this goes red at 113 while the shape of the answer stays
    // perfectly plausible. 16 counterparties would have quietly disappeared.
    const asIfMaxWon = Math.max(...LIVE.chains.map((c) => c.distinctRaters));
    expect(resolveDistinctRaters(LIVE)).not.toBe(asIfMaxWon);
    expect(resolveDistinctRaters(LIVE)).toBe(129);
  });

  it('MeshRelay\'s measured double-count: karma-hello reads 9, the chains add to 11', () => {
    const karmaHello = {
      distinctRaters: 9,
      chains: [
        { network: 'base', distinctRaters: 6 },
        { network: 'avalanche', distinctRaters: 5 },
      ],
    };
    expect(karmaHello.chains.reduce((t, c) => t + c.distinctRaters, 0)).toBe(11);
    expect(resolveDistinctRaters(karmaHello)).toBe(9);
  });
});

describe('the fallback is a LOWER BOUND and the docstring says so', () => {
  it('MeshRelay\'s measured underestimate: 3 on base + 4 different on avalanche', () => {
    // No global figure — a cached response from before describe.net started
    // serving one (b753c9c). The honest answer here is 4, and 4 is WRONG as a
    // count: the real number of distinct counterparties is 7. That is why the
    // function is not named after this branch.
    const stale = {
      distinctRaters: null,
      chains: [
        { network: 'base', distinctRaters: 3 },
        { network: 'avalanche', distinctRaters: 4 },
      ],
    };
    expect(resolveDistinctRaters(stale)).toBe(4);
    expect(resolveDistinctRaters(stale)).toBeLessThan(7);
  });

  it('never sums, even when summing would look more generous', () => {
    const stale = {
      distinctRaters: null,
      chains: [
        { network: 'base', distinctRaters: 3 },
        { network: 'avalanche', distinctRaters: 4 },
      ],
    };
    expect(resolveDistinctRaters(stale)).not.toBe(7);
  });
});

describe('R1 — every absence is null, and none of them is 0', () => {
  it('MOUNTS THE BAD STATE: an unrated wallet is null, never 0 and never -Infinity', () => {
    // `Math.max(...[])` is `-Infinity` in JavaScript. A helper written the
    // obvious way returns it here, and `-Infinity` renders, compares and
    // serialises as a number — it would reach a UI. `0` is the other wrong
    // answer and the more dangerous one: it asserts "we counted, and the count
    // was zero" about a wallet nobody has ever rated.
    const unrated = { distinctRaters: null, chains: [] };

    expect(Math.max(...[])).toBe(-Infinity); // the bug this branch avoids
    expect(resolveDistinctRaters(unrated)).toBeNull();
    expect(resolveDistinctRaters(unrated)).not.toBe(0);
    expect(resolveDistinctRaters(unrated)).not.toBe(-Infinity);
  });

  it('a null input — the fail-open value of wallet() — is null, not zero', () => {
    // "We could not ask describe.net" and "nobody rated this wallet" are
    // different facts, and neither of them is "zero people rated it".
    expect(resolveDistinctRaters(null)).toBeNull();
    expect(resolveDistinctRaters(undefined)).toBeNull();
  });

  it('a REAL zero survives as 0 — the distinction runs in both directions', () => {
    expect(resolveDistinctRaters({ distinctRaters: 0, chains: [] })).toBe(0);
  });

  it('chains that carry nothing countable fall through to null', () => {
    const junk = {
      distinctRaters: null,
      chains: [{ distinctRaters: Number.NaN }, { distinctRaters: undefined as unknown as number }],
    };
    expect(resolveDistinctRaters(junk)).toBeNull();
  });
});
