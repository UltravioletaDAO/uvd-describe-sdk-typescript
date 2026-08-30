import { describe, expect, it, vi } from 'vitest';

import {
  CHALLENGE_402,
  HEALTH,
  LEADERBOARD,
  LEADERBOARD_TAKES_NO_PARAMS_422,
  NOT_AN_ADDRESS_422,
  WALLET_BREAKDOWN,
  WALLET_UNRATED,
  WALLET_WITH_SCORE,
} from './__fixtures__/live';
import { mockServer, type Route } from './__fixtures__/server';
import { DescribeClient, type DescribeFailure } from './client';
import { TREASURY_EVM } from './config';
import { DescribeError, DescribePaymentRefused, DescribePaymentRequired } from './errors';

const KNOWN = '0x97cd97cfe21799bacbf39d0a53469e5f82f30996';
const UNRATED = '0xdead00000000000000000000000000000000beef';

// ---------------------------------------------------------------------------
// R1 — null is never 0, and the absence of data is not the absence of an answer
// ---------------------------------------------------------------------------

describe('R1 — null never 0', () => {
  it('an unrated wallet answers with an object whose globalScore is null', async () => {
    const server = mockServer({ [`/wallets/${UNRATED}/chains`]: { body: WALLET_UNRATED } });
    const client = new DescribeClient({ fetchImpl: server.fetch });

    const rep = await client.wallet(UNRATED);

    // The object exists — "no evidence" is an ANSWER, not a missing result.
    expect(rep).not.toBeNull();
    expect(rep!.globalScore).toBeNull();
    expect(rep!.distinctRaters).toBeNull();
    expect(rep!.chains).toEqual([]);
    // And it still carries its seal: policy_version travels with every answer.
    expect(rep!.policyVersion).toBe('equal-weight-per-chain@2');
  });

  it('MOUNTS THE BAD STATE: a 0 would be indistinguishable from a real 0 score', async () => {
    // This is the discriminant half. If the parser ever coalesces null to 0,
    // an unrated wallet becomes byte-identical to a wallet the ecosystem rated
    // at zero — and no later assertion could tell them apart.
    const server = mockServer({
      [`/wallets/${UNRATED}/chains`]: { body: WALLET_UNRATED },
      '/wallets/0xrated0/chains': { body: { ...WALLET_UNRATED, global_score: 0 } },
    });
    const client = new DescribeClient({ fetchImpl: server.fetch });

    const unrated = await client.wallet(UNRATED);
    const scoredZero = await client.wallet('0xrated0');

    expect(unrated!.globalScore).toBeNull();
    expect(scoredZero!.globalScore).toBe(0);
    expect(unrated!.globalScore).not.toBe(scoredZero!.globalScore);
  });

  it('a per-chain final_score of null survives too', async () => {
    const server = mockServer({
      [`/wallets/${KNOWN}/chains`]: {
        body: {
          ...WALLET_WITH_SCORE,
          chains: [{ ...WALLET_WITH_SCORE.chains[0], final_score: null }],
        },
      },
    });
    const client = new DescribeClient({ fetchImpl: server.fetch });
    const rep = await client.wallet(KNOWN);
    expect(rep!.chains[0].finalScore).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R4 — an exception only for transport or protocol, never for "no data"
// ---------------------------------------------------------------------------

describe('R4 — no exception for absence', () => {
  it('a 404 does NOT throw — it is absence, not a failure', async () => {
    const server = mockServer({ '/wallets/0xnope/chains': { status: 404, body: { detail: 'nope' } } });
    const seen: DescribeFailure[] = [];
    const client = new DescribeClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

    const rep = await client.wallet('0xnope');

    expect(rep).toBeNull();
    // Not an outage, and it says so: `not_found`, non-transient. It IS
    // announced, because a mistyped baseUrl 404s every route and a silent null
    // forever would read as "nobody in this index has any reputation".
    expect(seen).toEqual([
      expect.objectContaining({ kind: 'not_found', transient: false, path: '/wallets/0xnope/chains' }),
    ]);
  });

  it('a 404 does not throw with failOpen OFF either — a different axis', async () => {
    // failOpen is about THEIR outage. A 404 is about absence. Making the
    // second depend on the first would put "there is no such agent" behind a
    // switch whose name says nothing about it.
    const server = mockServer({ '/reputation/agent/base/999999': { status: 404, body: {} } });
    const client = new DescribeClient({ fetchImpl: server.fetch, failOpen: false });

    await expect(client.agent('base', 999999)).resolves.toBeNull();
  });

  it('MOUNTS THE BAD STATE: a 404 must not be lumped in with the other 4xx', async () => {
    // If 404 fell through to DescribeHTTPError like 422 does, this would
    // throw — which is the behaviour R4 exists to forbid ("nunca por «no hay
    // datos»"). The two live side by side so the difference is visible.
    const server = mockServer({
      '/wallets/0xnope/chains': { status: 404, body: {} },
      '/wallets/notawallet/chains': { status: 422, body: NOT_AN_ADDRESS_422 },
    });
    const client = new DescribeClient({ fetchImpl: server.fetch, failOpen: false });

    await expect(client.wallet('0xnope')).resolves.toBeNull();
    await expect(client.wallet('notawallet')).rejects.toMatchObject({ kind: 'http_4xx' });
  });

  it('an unrated wallet never throws, with failOpen either way', async () => {
    for (const failOpen of [true, false]) {
      const server = mockServer({ [`/wallets/${UNRATED}/chains`]: { body: WALLET_UNRATED } });
      const client = new DescribeClient({ fetchImpl: server.fetch, failOpen });
      await expect(client.wallet(UNRATED)).resolves.not.toBeNull();
    }
  });

  it('a 422 DOES throw even with failOpen on — a caller bug must not vanish', async () => {
    const server = mockServer({
      '/wallets/notawallet/chains': { status: 422, body: NOT_AN_ADDRESS_422 },
    });
    const onFailure = vi.fn();
    const client = new DescribeClient({ fetchImpl: server.fetch, failOpen: true, onFailure });

    // failOpen protects against THEIR outage, never against YOUR bug.
    // Swallowing this would say "this wallet has no reputation" forever about
    // a string that is not a wallet.
    await expect(client.wallet('notawallet')).rejects.toThrow(DescribeError);
    await expect(client.wallet('notawallet')).rejects.toMatchObject({
      kind: 'http_4xx',
      status: 422,
      transient: false,
    });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('invalid JSON is a protocol failure and is typed as unparseable', async () => {
    const server = mockServer({ '/health': { notJson: '<html>502 Bad Gateway</html>' } });
    const client = new DescribeClient({ fetchImpl: server.fetch, failOpen: false });
    await expect(client.health()).rejects.toMatchObject({ kind: 'unparseable', transient: false });
  });
});

// ---------------------------------------------------------------------------
// R5 — fail-open, and observable
// ---------------------------------------------------------------------------

describe('R5 — failOpen is observable', () => {
  it('a 500 returns null AND announces the reason', async () => {
    const server = mockServer({ [`/wallets/${KNOWN}/chains`]: { status: 500, body: {} } });
    const seen: DescribeFailure[] = [];
    const client = new DescribeClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

    const rep = await client.wallet(KNOWN);

    expect(rep).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      path: `/wallets/${KNOWN}/chains`,
      kind: 'http_5xx',
      transient: true,
    });
  });

  it('a transport failure returns null and announces `unreachable`', async () => {
    const server = mockServer({ '/health': { throws: new TypeError('fetch failed') } });
    const seen: DescribeFailure[] = [];
    const client = new DescribeClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

    expect(await client.health()).toBeNull();
    expect(seen[0].kind).toBe('unreachable');
    expect(seen[0].transient).toBe(true);
  });

  it('a timeout is the client\'s own clock, and it announces `timeout`', async () => {
    const server = mockServer({ '/health': { hang: true } });
    const seen: DescribeFailure[] = [];
    const client = new DescribeClient({
      fetchImpl: server.fetch,
      timeoutMs: 20,
      onFailure: (f) => seen.push(f),
    });

    expect(await client.health()).toBeNull();
    expect(seen[0].kind).toBe('timeout');
    expect(seen[0].transient).toBe(true);
  });

  it('MOUNTS THE BAD STATE: a silent fail-open is what this test forbids', async () => {
    // If `onFailure` were ever moved after the `return null`, or dropped,
    // "describe is down" would be indistinguishable from "no reputation" for
    // the caller — the exact confusion R1 exists to prevent, arriving through
    // the back door. So we assert the announcement happens for EVERY covered
    // failure, not just for a convenient one.
    const covered: Array<[string, Route]> = [
      ['http_5xx', { status: 503, body: {} }],
      ['unreachable', { throws: new Error('ECONNRESET') }],
      ['unparseable', { notJson: 'not json at all' }],
    ];

    for (const [kind, route] of covered) {
      const server = mockServer({ '/health': route });
      const seen: DescribeFailure[] = [];
      const client = new DescribeClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

      const result = await client.health();

      expect(result).toBeNull();
      expect(seen, `${kind} returned null without announcing it`).toHaveLength(1);
      expect(seen[0].kind).toBe(kind);
    }
  });

  it('failOpen: false rethrows the same typed error instead of nulling', async () => {
    const server = mockServer({ '/health': { status: 503, body: {} } });
    const onFailure = vi.fn();
    const client = new DescribeClient({ fetchImpl: server.fetch, failOpen: false, onFailure });

    await expect(client.health()).rejects.toMatchObject({ kind: 'http_5xx' });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('429 (the shared rate limit) is covered by failOpen and marked transient', async () => {
    const server = mockServer({ '/health': { status: 429, body: {} } });
    const seen: DescribeFailure[] = [];
    const client = new DescribeClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

    expect(await client.health()).toBeNull();
    expect(seen[0]).toMatchObject({ kind: 'http_4xx', transient: true });
  });
});

// ---------------------------------------------------------------------------
// Free routes
// ---------------------------------------------------------------------------

describe('free routes', () => {
  it('parses a wallet with reputation', async () => {
    const server = mockServer({ [`/wallets/${KNOWN}/chains`]: { body: WALLET_WITH_SCORE } });
    const client = new DescribeClient({ fetchImpl: server.fetch });

    const rep = await client.wallet(KNOWN);

    expect(rep!.globalScore).toBe(100);
    expect(rep!.distinctRaters).toBe(7548);
    expect(rep!.chains[0].network).toBe('monad');
    expect(rep!.caveatScope).toBe('public-data-subset');
    // The passthrough rule: the exact payload is still there.
    expect(rep!.raw).toEqual(WALLET_WITH_SCORE);
  });

  it('the wallet goes through verbatim — Solana base58 is case-SENSITIVE', async () => {
    const solana = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy';
    const server = mockServer({
      [`/wallets/${solana}/chains`]: { body: { ...WALLET_UNRATED, wallet: solana } },
    });
    const client = new DescribeClient({ fetchImpl: server.fetch });

    await client.wallet(solana);

    // Lower-casing here would silently ask about a DIFFERENT wallet.
    expect(server.calls[0].path).toBe(`/wallets/${solana}/chains`);
  });

  it('leaderboard is a bare array and is sent with no parameters', async () => {
    const server = mockServer({ '/leaderboard': { body: LEADERBOARD } });
    const client = new DescribeClient({ fetchImpl: server.fetch });

    const rows = await client.leaderboard();

    expect(server.calls[0].path).toBe('/leaderboard');
    expect(rows).toHaveLength(2);
    expect(rows![0].shrunkScore).toBe(99.982977);
    // Ordered by shrunk_score, not final_score — row 2 has the lower shrunk.
    expect(rows![0].shrunkScore!).toBeGreaterThan(rows![1].shrunkScore!);
  });

  it('a parameter on /leaderboard is the server\'s 422, surfaced as a caller error', async () => {
    const server = mockServer({
      '/leaderboard': { status: 422, body: LEADERBOARD_TAKES_NO_PARAMS_422 },
    });
    const client = new DescribeClient({ fetchImpl: server.fetch });
    await expect(client.leaderboard()).rejects.toMatchObject({ kind: 'http_4xx', status: 422 });
  });

  it('health carries the live calibrable values so nobody re-types them', async () => {
    const server = mockServer({ '/health': { body: HEALTH } });
    const client = new DescribeClient({ fetchImpl: server.fetch });

    const health = await client.health();

    expect(health!.readingPolicy.min_raters).toBe(3);
    expect(health!.confidenceThresholds.high).toBe(6);
    expect(health!.buildSha).toBe('737bc1e2964599f533415a6a1910aa5ddbbc29cd');
    expect(health!.chains[0].nextSyncAt).toBe('2026-08-30T21:48:38.100848Z');
  });

  it('sends an attributable User-Agent', async () => {
    const server = mockServer({ '/health': { body: HEALTH } });
    const client = new DescribeClient({ fetchImpl: server.fetch, product: 'meshrelay' });

    await client.health();

    expect(server.calls[0].headers['User-Agent']).toMatch(/^uvd-describe-sdk-ts\/\d+\.\d+\.\d+ \(\+meshrelay\)$/);
  });

  it('badgeUrl and profileUrl open no socket', async () => {
    const server = mockServer({});
    const client = new DescribeClient({ fetchImpl: server.fetch });

    expect(client.badgeUrl(KNOWN)).toBe(`https://api.describe.net/badge/${KNOWN}.svg`);
    expect(client.profileUrl(KNOWN)).toBe(`https://describe.net/agent.html?wallet=${KNOWN}`);
    expect(server.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R6 — the 402 flow: we never sign, and we check WHO before paying
// ---------------------------------------------------------------------------

describe('metered routes', () => {
  const PATH = `/reputation/wallet/${KNOWN}`;

  it('402 with no payer throws, and hands over the challenge unpaid', async () => {
    const server = mockServer({ [PATH]: { status: 402, body: CHALLENGE_402 } });
    const client = new DescribeClient({ fetchImpl: server.fetch });

    const err = await client.walletBreakdown(KNOWN).catch((e) => e);

    expect(err).toBeInstanceOf(DescribePaymentRequired);
    // Asking is free and is the intended first move: you can read the price
    // without paying it.
    expect(err.challenge.amount).toBe('0.01');
    expect(err.challenge.accepts).toHaveLength(2);
    // It is NOT swallowed by failOpen — nothing is broken, you just did not pay.
    expect(err.serviceFault).toBe(false);
  });

  it('pays, replays the identical request, and surfaces the receipt', async () => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: {
        body: WALLET_BREAKDOWN,
        headers: { 'X-Payment-Receipt': 'rcpt_abc123', 'X-Payment-Reused': 'false' },
      },
    });
    const pay = vi.fn(async () => 'BASE64-X-PAYMENT');
    const client = new DescribeClient({ fetchImpl: server.fetch, payer: { pay } });

    const result = await client.walletBreakdown(KNOWN);

    expect(pay).toHaveBeenCalledOnce();
    expect(pay.mock.calls[0][0]).toMatchObject({ amount: '0.01' });
    // The replay carries the header, on the SAME path — a receipt only unlocks
    // the byte-identical resource.
    expect(server.calls[1].path).toBe(PATH);
    expect(server.calls[1].headers['X-PAYMENT']).toBe('BASE64-X-PAYMENT');
    // The two headers the paywall has been emitting since 2026-08-25 and that
    // no client read until now.
    expect(result!.payment).toEqual({ receipt: 'rcpt_abc123', reused: false });
    expect(result!.finalScore).toBe(83.0);
    expect(result!.caveats[0].code).toBe('top-client-share');
    expect(result!.caveatScope).toBe('full');
  });

  it('reads the challenge from the base64 header, which is where sellers put it', async () => {
    const encoded = Buffer.from(JSON.stringify(CHALLENGE_402), 'utf8').toString('base64');
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: { free: 'preview' }, headers: { 'Payment-Required': encoded } },
      [`${PATH}#2`]: { body: WALLET_BREAKDOWN },
    });
    const client = new DescribeClient({
      fetchImpl: server.fetch,
      payer: { pay: async (c) => `paid-${c.amount}` },
    });

    await client.walletBreakdown(KNOWN);

    expect(server.calls[1].headers['X-PAYMENT']).toBe('paid-0.01');
  });

  it('DO_NOT_PAY: a stranger in accepts[] refuses the whole challenge, unsigned', async () => {
    const STRANGER = '0x000000000000000000000000000000000000dEaD';
    const poisoned = {
      ...CHALLENGE_402,
      // Right treasury on top, stranger in the second chain option. The
      // caller's chain selection would decide who gets paid.
      accepts: [CHALLENGE_402.accepts[0], { ...CHALLENGE_402.accepts[1], payTo: STRANGER }],
    };
    const server = mockServer({ [PATH]: { status: 402, body: poisoned } });
    const pay = vi.fn(async () => 'SHOULD-NEVER-BE-CALLED');
    const client = new DescribeClient({ fetchImpl: server.fetch, payer: { pay } });

    const err = await client.walletBreakdown(KNOWN).catch((e) => e);

    expect(err).toBeInstanceOf(DescribePaymentRefused);
    expect(err.offered).toBe(STRANGER);
    expect(err.expected).toBe(TREASURY_EVM);
    // Nothing was signed, and only ONE request was ever made.
    expect(pay).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(1);
  });

  it('DO_NOT_PAY is never swallowed by failOpen', async () => {
    const server = mockServer({
      [PATH]: { status: 402, body: { ...CHALLENGE_402, recipient: '0xdeadbeef', recipients: {}, accepts: [] } },
    });
    const onFailure = vi.fn();
    const client = new DescribeClient({
      fetchImpl: server.fetch,
      failOpen: true,
      onFailure,
      payer: { pay: async () => 'x' },
    });

    // The one failure where continuing quietly costs real USDC to a stranger.
    await expect(client.walletBreakdown(KNOWN)).rejects.toBeInstanceOf(DescribePaymentRefused);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('matches the treasury case-insensitively — challenges use checksum case', async () => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: { ...CHALLENGE_402, recipient: TREASURY_EVM.toLowerCase() } },
      [`${PATH}#2`]: { body: WALLET_BREAKDOWN },
    });
    const client = new DescribeClient({ fetchImpl: server.fetch, payer: { pay: async () => 'ok' } });
    await expect(client.walletBreakdown(KNOWN)).resolves.not.toBeNull();
  });

  it('a metered route that answers 200 straight away reports no payment', async () => {
    const server = mockServer({ [PATH]: { body: WALLET_BREAKDOWN } });
    const client = new DescribeClient({ fetchImpl: server.fetch });

    const result = await client.walletBreakdown(KNOWN);

    expect(result!.payment).toBeNull();
  });

  it('a failure AFTER paying keeps the status so you know what you bought', async () => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { status: 500, body: {} },
    });
    const seen: DescribeFailure[] = [];
    const client = new DescribeClient({
      fetchImpl: server.fetch,
      payer: { pay: async () => 'paid' },
      onFailure: (f) => seen.push(f),
    });

    expect(await client.walletBreakdown(KNOWN)).toBeNull();
    // 5xx after settlement: their query broke, not our payment. A caller has to
    // be able to tell that from a 4xx refusal.
    expect(seen[0]).toMatchObject({ kind: 'http_5xx', transient: true });
  });
});

describe('constructor', () => {
  it('refuses to build without a usable fetch, instead of dying at the first call', () => {
    // Failing here names the problem ("no fetch"); failing at the first call
    // surfaces as `unreachable`, which reads as "describe.net is down".
    expect(() => new DescribeClient({ fetchImpl: 'not a function' as never })).toThrow(TypeError);
  });

  it('trims a trailing slash off baseUrl so paths never double up', async () => {
    const server = mockServer({ '/health': { body: HEALTH } });
    const client = new DescribeClient({ baseUrl: 'https://api.describe.net/', fetchImpl: server.fetch });

    await client.health();

    expect(server.calls[0].path).toBe('/health');
  });
});
