import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { type MockServer, mockServer, type Route } from './__fixtures__/server';
import { DescribeClient, type DescribeClientConfig, type DescribeFailure, type X402Payer } from './client';
import { AUTHORIZATION_EXPIRY_MARGIN_SECONDS, MAX_RETRY_AFTER_SECONDS, TREASURY_EVM } from './config';
import {
  DescribeError,
  DescribeHTTPError,
  DescribeMalformedHash,
  DescribeNotFound,
  DescribePaymentRefused,
  DescribePaymentRequired,
  failedAfterPaying,
  failOpenCovers,
  type PaymentResend,
  type X402Challenge,
} from './errors';
import type { AgentReputation, WalletBreakdown } from './types';

const KNOWN = '0x97cd97cfe21799bacbf39d0a53469e5f82f30996';
const UNRATED = '0xdead00000000000000000000000000000000beef';

/**
 * A settlement receipt SHAPED like one — `0x` + 64 hex.
 *
 * ⚠️ Changed 2026-08-30, and the old values are worth naming: this file used to
 * stamp `'rcpt_abc123'`, `'0xsettlementhash'` and `'0xabc'` into
 * `X-Payment-Receipt`. None of the three can come off that header — it carries a
 * settlement transaction hash or the literal `pending` — so three tests about
 * proof of payment were asserting on values that prove nothing. They went red
 * the moment the receipt got its shape check (KarmaKadabra, 2026-08-30), which
 * is the check working: a fixture nobody could have served was hiding inside a
 * green suite. The house rule that catches this earlier is already written in
 * `__fixtures__/live.ts` — a fixture a developer invents tests the developer.
 */
const SETTLEMENT_TX = `0x${'ab'.repeat(32)}`;

/**
 * Every client in this file is built with the jitter OFF — and this is the same
 * line a consumer should write in their own suite.
 *
 * The jitter ships ON (400 ms max, KarmaKadabra's measurement, see
 * `config.ts::DEFAULT_JITTER_MS`), which is right against a rate limit shared
 * with the rest of the ecosystem and pointless against a `fetchImpl` that
 * answers instantly. Leaving it on would cost this suite ~200 ms per mocked
 * call and turn a sub-second loop into tens of seconds — and a suite that sleeps
 * for a behaviour it is not testing teaches people to stop running it.
 *
 * `jitterMs` comes FIRST so any test can override it, which is what the jitter's
 * own tests below do: they go through this helper with a real value, so nothing
 * about the sleep is mocked away.
 */
const testClient = (config: DescribeClientConfig = {}) =>
  new DescribeClient({ jitterMs: 0, ...config });

// ---------------------------------------------------------------------------
// R1 — null is never 0, and the absence of data is not the absence of an answer
// ---------------------------------------------------------------------------

describe('R1 — null never 0', () => {
  it('an unrated wallet answers with an object whose globalScore is null', async () => {
    const server = mockServer({ [`/wallets/${UNRATED}/chains`]: { body: WALLET_UNRATED } });
    const client = testClient({ fetchImpl: server.fetch });

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
    const client = testClient({ fetchImpl: server.fetch });

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
    const client = testClient({ fetchImpl: server.fetch });
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
    const client = testClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

    const rep = await client.wallet('0xnope');

    expect(rep).toBeNull();
    // Not an outage, and it says so: `not_found`, non-transient. It IS
    // announced, because a mistyped baseUrl 404s every route and a silent null
    // forever would read as "nobody in this index has any reputation".
    expect(seen).toEqual([
      expect.objectContaining({ kind: 'not_found', transient: false, path: '/wallets/0xnope/chains' }),
    ]);
  });

  it('a 404 on a FREE route does not throw with failOpen OFF either — a different axis', async () => {
    // failOpen is about THEIR outage. A 404 is about absence. Making the
    // second depend on the first would put "there is no such wallet" behind a
    // switch whose name says nothing about it.
    const server = mockServer({ '/wallets/0xnope/chains': { status: 404, body: {} } });
    const client = testClient({ fetchImpl: server.fetch, failOpen: false });

    await expect(client.wallet('0xnope')).resolves.toBeNull();
  });

  it('a 404 on a PAID route throws instead — there is no null left to return', async () => {
    // ⚠️ Corrected 2026-08-30. This case used to assert
    // `client.agent('base', 999999)` RESOLVES to null, and it did, because the
    // metered methods were `| null`. They no longer are (money rule), so
    // absence changed clothes here: same `not_found`, same non-transient,
    // non-serviceFault classification — and, the part that matters, no
    // `payment`, because a 404 is read before the challenge is. Nothing was
    // signed, nothing was spent to learn there is no such agent.
    const server = mockServer({ '/reputation/agent/base/999999': { status: 404, body: {} } });
    const client = testClient({ fetchImpl: server.fetch, failOpen: false });

    const err = await client.agent('base', 999999).catch((e) => e);

    expect(err).toBeInstanceOf(DescribeNotFound);
    expect(err).toMatchObject({ kind: 'not_found', transient: false, serviceFault: false });
    expect(failedAfterPaying(err)).toBe(false);
  });

  it('MOUNTS THE BAD STATE: a 404 must not be lumped in with the other 4xx', async () => {
    // If 404 fell through to DescribeHTTPError like 422 does, this would
    // throw — which is the behaviour R4 exists to forbid ("nunca por «no hay
    // datos»"). The two live side by side so the difference is visible.
    const server = mockServer({
      '/wallets/0xnope/chains': { status: 404, body: {} },
      '/wallets/notawallet/chains': { status: 422, body: NOT_AN_ADDRESS_422 },
    });
    const client = testClient({ fetchImpl: server.fetch, failOpen: false });

    await expect(client.wallet('0xnope')).resolves.toBeNull();
    await expect(client.wallet('notawallet')).rejects.toMatchObject({ kind: 'http_4xx' });
  });

  it('an unrated wallet never throws, with failOpen either way', async () => {
    for (const failOpen of [true, false]) {
      const server = mockServer({ [`/wallets/${UNRATED}/chains`]: { body: WALLET_UNRATED } });
      const client = testClient({ fetchImpl: server.fetch, failOpen });
      await expect(client.wallet(UNRATED)).resolves.not.toBeNull();
    }
  });

  it('a 422 DOES throw even with failOpen on — a caller bug must not vanish', async () => {
    const server = mockServer({
      '/wallets/notawallet/chains': { status: 422, body: NOT_AN_ADDRESS_422 },
    });
    const onFailure = vi.fn();
    const client = testClient({ fetchImpl: server.fetch, failOpen: true, onFailure });

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
    const client = testClient({ fetchImpl: server.fetch, failOpen: false });
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
    const client = testClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

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
    const client = testClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

    expect(await client.health()).toBeNull();
    expect(seen[0].kind).toBe('unreachable');
    expect(seen[0].transient).toBe(true);
  });

  it('a timeout is the client\'s own clock, and it announces `timeout`', async () => {
    const server = mockServer({ '/health': { hang: true } });
    const seen: DescribeFailure[] = [];
    const client = testClient({
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
      const client = testClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

      const result = await client.health();

      expect(result).toBeNull();
      expect(seen, `${kind} returned null without announcing it`).toHaveLength(1);
      expect(seen[0].kind).toBe(kind);
    }
  });

  it('failOpen: false rethrows the same typed error instead of nulling', async () => {
    const server = mockServer({ '/health': { status: 503, body: {} } });
    const onFailure = vi.fn();
    const client = testClient({ fetchImpl: server.fetch, failOpen: false, onFailure });

    await expect(client.health()).rejects.toMatchObject({ kind: 'http_5xx' });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('429 (the shared rate limit) is covered by failOpen and marked transient', async () => {
    const server = mockServer({ '/health': { status: 429, body: {} } });
    const seen: DescribeFailure[] = [];
    const client = testClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

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
    const client = testClient({ fetchImpl: server.fetch });

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
    const client = testClient({ fetchImpl: server.fetch });

    await client.wallet(solana);

    // Lower-casing here would silently ask about a DIFFERENT wallet.
    expect(server.calls[0].path).toBe(`/wallets/${solana}/chains`);
  });

  it('leaderboard is a bare array and is sent with no parameters', async () => {
    const server = mockServer({ '/leaderboard': { body: LEADERBOARD } });
    const client = testClient({ fetchImpl: server.fetch });

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
    const client = testClient({ fetchImpl: server.fetch });
    await expect(client.leaderboard()).rejects.toMatchObject({ kind: 'http_4xx', status: 422 });
  });

  it('health carries the live calibrable values so nobody re-types them', async () => {
    const server = mockServer({ '/health': { body: HEALTH } });
    const client = testClient({ fetchImpl: server.fetch });

    const health = await client.health();

    expect(health!.readingPolicy.min_raters).toBe(3);
    expect(health!.confidenceThresholds.high).toBe(6);
    expect(health!.buildSha).toBe('737bc1e2964599f533415a6a1910aa5ddbbc29cd');
    expect(health!.chains[0].nextSyncAt).toBe('2026-08-30T21:48:38.100848Z');
  });

  it('sends an attributable User-Agent', async () => {
    const server = mockServer({ '/health': { body: HEALTH } });
    const client = testClient({ fetchImpl: server.fetch, product: 'meshrelay' });

    await client.health();

    expect(server.calls[0].headers['User-Agent']).toMatch(/^uvd-describe-sdk-ts\/\d+\.\d+\.\d+ \(\+meshrelay\)$/);
  });

  it('badgeUrl and profileUrl open no socket', async () => {
    const server = mockServer({});
    const client = testClient({ fetchImpl: server.fetch });

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
    const client = testClient({ fetchImpl: server.fetch });

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
        headers: { 'X-Payment-Receipt': SETTLEMENT_TX, 'X-Payment-Reused': 'false' },
      },
    });
    // The declared parameter is what makes `pay.mock.calls[0][0]` type-check:
    // a bare `vi.fn(async () => …)` infers a zero-length argument tuple.
    const pay = vi.fn(async (_challenge: X402Challenge) => 'BASE64-X-PAYMENT');
    const client = testClient({ fetchImpl: server.fetch, payer: { pay } });

    const result = await client.walletBreakdown(KNOWN);

    expect(pay).toHaveBeenCalledOnce();
    expect(pay.mock.calls[0][0]).toMatchObject({ amount: '0.01' });
    // The replay carries the header, on the SAME path — a receipt only unlocks
    // the byte-identical resource.
    expect(server.calls[1].path).toBe(PATH);
    expect(server.calls[1].headers['X-PAYMENT']).toBe('BASE64-X-PAYMENT');
    // The two headers the paywall has been emitting since 2026-08-25 and that
    // no client read until now.
    expect(result.payment).toEqual({
      receipt: SETTLEMENT_TX,
      settlementPending: false,
      reused: false,
      malformedHashes: [],
    });
    expect(result.finalScore).toBe(83.0);
    expect(result.caveats[0].code).toBe('top-client-share');
    expect(result.caveatScope).toBe('full');
  });

  it('the return type is NOT nullable — the compiler is half of this rule', async () => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { body: WALLET_BREAKDOWN },
      '/reputation/agent/base/1#1': { status: 402, body: CHALLENGE_402 },
      '/reputation/agent/base/1#2': { body: { network: 'base', agent_id: 1 } },
    });
    const client = testClient({ fetchImpl: server.fetch, payer: { pay: async () => 'ok' } });

    // No `!`, no `?.`, no narrowing: if either signature goes back to
    // `| null` these two lines stop compiling. `npm run typecheck` excludes
    // test files, so the gate is `npx tsc --noEmit -p tsconfig.eslint.json`,
    // which includes them — run it if you touch these signatures.
    const breakdown: WalletBreakdown = await client.walletBreakdown(KNOWN);
    const agent: AgentReputation = await client.agent('base', 1);

    expect(breakdown.finalScore).toBe(83.0);
    expect(agent.agentId).toBe('1');
  });

  it('reads the challenge from the base64 header, which is where sellers put it', async () => {
    const encoded = Buffer.from(JSON.stringify(CHALLENGE_402), 'utf8').toString('base64');
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: { free: 'preview' }, headers: { 'Payment-Required': encoded } },
      [`${PATH}#2`]: { body: WALLET_BREAKDOWN },
    });
    const client = testClient({
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
    const client = testClient({ fetchImpl: server.fetch, payer: { pay } });

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
    const client = testClient({
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
    const client = testClient({ fetchImpl: server.fetch, payer: { pay: async () => 'ok' } });
    await expect(client.walletBreakdown(KNOWN)).resolves.toMatchObject({ finalScore: 83.0 });
  });

  it('a metered route that answers 200 straight away reports no payment', async () => {
    const server = mockServer({ [PATH]: { body: WALLET_BREAKDOWN } });
    const client = testClient({ fetchImpl: server.fetch });

    const result = await client.walletBreakdown(KNOWN);

    expect(result.payment).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// R5 corrected (2026-08-30) — the PAID routes never fail open
//
// The rule the two SDKs now share: `failOpen` covers a service failure on the
// FREE routes and nothing else. `walletBreakdown()` and `agent()` throw on
// everything, because between signing a payment and reading the answer the USDC
// may already have moved, and a `null` there hides a spend from the caller.
// ---------------------------------------------------------------------------

describe('R5 — the paid routes never fail open', () => {
  const PATH = `/reputation/wallet/${KNOWN}`;
  const AFTER_PAYING: Array<[string, Route]> = [
    ['http_5xx', { status: 500, body: {} }],
    ['unreachable', { throws: new TypeError('fetch failed') }],
    ['unparseable', { notJson: '<html>502 Bad Gateway</html>' }],
  ];

  it('MOUNTS THE BAD STATE: every service failure after paying THROWS with failOpen ON', async () => {
    // This is the discriminant test of the whole correction. Put these two
    // methods back through `guard()` — one line — and every iteration below
    // resolves to `null` instead of throwing, which is the shipped bug: the
    // USDC moved (the paywall settles BEFORE running the query) and the caller
    // is handed the same `null` that means "there was nothing to fetch".
    for (const [kind, route] of AFTER_PAYING) {
      const server = mockServer({
        [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
        [`${PATH}#2`]: route,
      });
      const onFailure = vi.fn();
      const client = testClient({
        fetchImpl: server.fetch,
        failOpen: true, // ← explicitly ON, and it still must not swallow this
        onFailure,
        payer: { pay: async () => 'SIGNED-ENVELOPE' },
      });

      const err = await client.walletBreakdown(KNOWN).catch((e) => e);

      expect(err, `${kind} did not throw — a spend was swallowed`).toBeInstanceOf(DescribeError);
      expect(err.kind).toBe(kind);
      // A flag about availability cannot buy the right to eat a receipt: the
      // error is `serviceFault` (failOpen WOULD have covered it) and it still
      // came out as a throw.
      expect(err.serviceFault).toBe(true);
      // And it is not announced through onFailure either: that callback means
      // "a null was returned instead of an answer", and no null was returned.
      expect(onFailure).not.toHaveBeenCalled();
    }
  });

  it('the same three failures on a FREE route still return null — the line is money, not the method count', async () => {
    // The other half of the discriminant: if someone "fixes" this by making
    // everything throw, this goes red. `leaderboard()` and `health()` are free,
    // and there a loud failure just forces every consumer to write the
    // try/except this package exists to delete.
    for (const [kind, route] of AFTER_PAYING) {
      const server = mockServer({ '/health': route, '/leaderboard': route });
      const seen: DescribeFailure[] = [];
      const client = testClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

      expect(await client.health(), `free health/${kind} should degrade`).toBeNull();
      expect(await client.leaderboard(), `free leaderboard/${kind} should degrade`).toBeNull();
      expect(seen.map((f) => f.kind)).toEqual([kind, kind]);
    }
  });

  it('agent() obeys the same rule as walletBreakdown() — one policy, both metered routes', async () => {
    const path = '/reputation/agent/base/42';
    const server = mockServer({
      [`${path}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${path}#2`]: { status: 503, body: {} },
    });
    const client = testClient({
      fetchImpl: server.fetch,
      failOpen: true,
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    await expect(client.agent('base', 42)).rejects.toMatchObject({ kind: 'http_5xx' });
  });
});

// ---------------------------------------------------------------------------
// The other half: a loud failure is only useful if it says WHICH side of the
// payment it happened on.
// ---------------------------------------------------------------------------

describe('post-settlement evidence', () => {
  const PATH = `/reputation/wallet/${KNOWN}`;

  it('a receipt on the failing response is PROOF the money moved', async () => {
    // The paywall settles inside `authorize()` and stamps the receipt headers
    // on whatever response comes back — read 2026-08-30 in
    // describe-net/describenet/paywall.py:1031-1065. So a 500 carrying
    // X-Payment-Receipt is a settlement stated by the seller, not a guess.
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: {
        status: 500,
        body: {},
        headers: { 'X-Payment-Receipt': SETTLEMENT_TX, 'X-Payment-Reused': 'false' },
      },
    });
    const client = testClient({
      fetchImpl: server.fetch,
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    const err = await client.walletBreakdown(KNOWN).catch((e) => e);

    expect(failedAfterPaying(err)).toBe(true);
    expect(err.payment).toMatchObject({
      settlement: 'settled',
      receipt: SETTLEMENT_TX,
      settlementPending: false, // a real hash: nothing is pending about it
      reused: false,
      status: 500,
      amount: '0.01',
      token: 'USDC',
    });
    // The message says it too, because the first thing anyone reads is the
    // message and not the properties.
    expect(err.message).toContain('settlement: settled');
  });

  it("a `pending` receipt on the failing response is 'settled' too — flag set, hash field EMPTY", async () => {
    // The seller's OpenAPI declares `pending` legitimate: charged, settlement
    // not yet reported. The design keeps calling that 'settled' — what changed
    // on 2026-08-31 (EM's INC-2026-08-26) is WHERE the state travels: never in
    // the field meant for the hash, where a placeholder gets archived as
    // proof, but in `settlementPending`, so no consumer string-compares.
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: {
        status: 500,
        body: {},
        headers: { 'X-Payment-Receipt': 'pending', 'X-Payment-Reused': 'false' },
      },
    });
    const client = testClient({
      fetchImpl: server.fetch,
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    const err = await client.walletBreakdown(KNOWN).catch((e) => e);

    expect(failedAfterPaying(err)).toBe(true);
    expect(err.payment).toMatchObject({
      settlement: 'settled', // the seller stated it — that half is unchanged
      receipt: null, // the placeholder never rides in the hash field
      settlementPending: true,
    });
  });

  it('no receipt is `unknown`, never "nothing happened"', async () => {
    // An unhandled 500 is rendered ABOVE the paywall middleware, so the header
    // line never runs while the settlement already did. Claiming "not settled"
    // from a missing header would be inventing a fact.
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { status: 500, body: {} },
    });
    const client = testClient({
      fetchImpl: server.fetch,
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    const err = await client.walletBreakdown(KNOWN).catch((e) => e);

    expect(err.payment).toMatchObject({
      settlement: 'unknown',
      receipt: null,
      settlementPending: false, // no header at all: nothing was STATED pending
      reused: null,
    });
  });

  it('a timeout with the envelope in flight is the case that CANNOT be narrowed', async () => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { hang: true },
    });
    const client = testClient({
      fetchImpl: server.fetch,
      timeoutMs: 20,
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    const err = await client.walletBreakdown(KNOWN).catch((e) => e);

    expect(err.kind).toBe('timeout');
    // No status: no answer ever arrived. `fetch` rejects the same way whether
    // the request bytes were written or not, so `unknown` is the honest word.
    expect(err.payment).toEqual({
      settlement: 'unknown',
      receipt: null,
      settlementPending: false,
      reused: null,
      amount: '0.01',
      token: 'USDC',
      payTo: TREASURY_EVM,
      // Added 2026-11-16 (F-A2). No answer, so nothing the server said; and
      // 'SIGNED-ENVELOPE' is not an x402 envelope, so no `validBefore` either.
      // What is NOT here, and the `toEqual` is what proves it: the header.
      resend: 'same-header',
      serverError: null,
      retryable: null,
      retryAfterSeconds: null,
      nextAction: null,
      validBefore: null,
      nonce: null,
      network: null,
    });
  });

  it('a 200 with an unreadable body is the worst case, and it settled', async () => {
    // Easiest one to forget: they charged, answered 200, and the bytes are
    // garbage. The old code returned `null` here.
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { notJson: '<html>gateway</html>', headers: { 'X-Payment-Receipt': SETTLEMENT_TX } },
    });
    const client = testClient({
      fetchImpl: server.fetch,
      failOpen: true,
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    const err = await client.walletBreakdown(KNOWN).catch((e) => e);

    expect(err.kind).toBe('unparseable');
    expect(err.payment).toMatchObject({
      settlement: 'settled',
      receipt: SETTLEMENT_TX,
      settlementPending: false,
      status: 200,
    });
  });

  it('MOUNTS THE BAD STATE: a failure BEFORE the envelope leaves carries no payment at all', async () => {
    // The absence of `error.payment` is itself the statement "nothing was
    // transmitted, so nothing could have settled". If it were stamped
    // unconditionally, every 402-with-no-payer would read as a possible spend
    // and the field would mean nothing.
    const before: Array<[string, () => Promise<unknown>]> = [];

    const noPayer = mockServer({ [PATH]: { status: 402, body: CHALLENGE_402 } });
    before.push([
      'payment_required',
      () => testClient({ fetchImpl: noPayer.fetch }).walletBreakdown(KNOWN),
    ]);

    const stranger = mockServer({
      [PATH]: { status: 402, body: { ...CHALLENGE_402, recipient: '0xstranger', recipients: {}, accepts: [] } },
    });
    before.push([
      'payment_refused',
      () =>
        testClient({
          fetchImpl: stranger.fetch,
          payer: { pay: async () => 'never' },
        }).walletBreakdown(KNOWN),
    ]);

    const down = mockServer({ [PATH]: { status: 503, body: {} } });
    before.push([
      'http_5xx on the FIRST ask',
      () =>
        testClient({
          fetchImpl: down.fetch,
          payer: { pay: async () => 'never' },
        }).walletBreakdown(KNOWN),
    ]);

    const declined = mockServer({ [PATH]: { status: 402, body: CHALLENGE_402 } });
    before.push([
      'the payer itself declined',
      () =>
        testClient({
          fetchImpl: declined.fetch,
          payer: {
            pay: async () => {
              throw new Error('user declined');
            },
          },
        }).walletBreakdown(KNOWN),
    ]);

    for (const [label, run] of before) {
      const err = await run().catch((e) => e);
      expect(err, `${label} did not throw`).toBeInstanceOf(Error);
      expect(failedAfterPaying(err), `${label} was marked as a possible spend`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// tras pagar — F-A2, 2026-11-16. After the authorization leaves, calling the
// method again re-sends the SAME one; a new one is signed only where
// describe.net says nothing moved. Until today a retry on `transient` signed a
// second authorization (measured with a spy payer: two signatures, one read).
// Run just this block: `npx vitest run src/client.test.ts -t "tras pagar"`.
// ---------------------------------------------------------------------------

describe('tras pagar — the authorization is re-sent, never signed twice (F-A2)', () => {
  const PATH = `/reputation/wallet/${KNOWN}`;
  const OTHER = '0x1111111111111111111111111111111111111111';
  /** A whole second, so an HTTP-date built from it round-trips exactly. */
  const T0_MS = 1_800_000_000_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * An `X-PAYMENT` with the SHAPE `uvd-x402-sdk` 2.75.0 builds on EVM
   * (`encodeEVMPaymentHeader`: `base64(JSON)`, the EIP-3009 authorization at
   * `payload.authorization`) and nothing real inside it: the signature is
   * zeros, the `from` is made up, and no key exists anywhere in this file. The
   * nonce is the call number, so two envelopes are never equal — "the same
   * header" in an assertion below can only mean "the same signature".
   */
  const envelope = (n: number, validBefore: number): string =>
    btoa(
      JSON.stringify({
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:8453',
        payload: {
          signature: `0x${'00'.repeat(65)}`,
          authorization: {
            from: `0x${'11'.repeat(20)}`,
            to: TREASURY_EVM,
            value: '10000',
            validAfter: '0',
            validBefore: String(validBefore),
            nonce: `0x${n.toString(16).padStart(64, '0')}`,
          },
        },
      }),
    );

  /** The spy payer: a fresh envelope per call. 300 s is what the payment SDK stamps on Base. */
  const spyPayer = (validBefore = Math.floor(Date.now() / 1000) + 300) => {
    let n = 0;
    return vi.fn(async (_challenge: X402Challenge) => envelope(++n, validBefore));
  };

  const paidClient = (server: MockServer, pay: X402Payer['pay']) =>
    testClient({ fetchImpl: server.fetch, timeoutMs: 50, payer: { pay } });

  const DELIVERED: Route = {
    body: WALLET_BREAKDOWN,
    headers: { 'X-Payment-Receipt': SETTLEMENT_TX, 'X-Payment-Reused': 'true' },
  };

  // The bodies `describenet/paywall.py` (describe-net f68cc96) serves after a
  // payment, trimmed to the fields this SDK reads: `_unavailable`,
  // `_sin_confirmar` and `_conflict` for the 503s, `_conflict` and
  // `_autorizacion_usada` for the 409s, `_rejected` for the 402s. The texts
  // are theirs, in their language.
  const busy = (error: string, extra: Record<string, unknown> = {}): Route => ({
    status: 503,
    headers: { 'Retry-After': '5' },
    body: {
      error,
      retryable: true,
      retry_after_seconds: 5,
      next_action:
        'Reintentá esta misma request con el MISMO header de pago (X-PAYMENT o PAYMENT-SIGNATURE) ' +
        'después de 5 s. NO firmes una autorización nueva.',
      ...extra,
    },
  });
  const conflict = (error: string): Route => ({
    status: 409,
    body: {
      error,
      retryable: false,
      next_action:
        'NO firmes otra autorización para recuperar esta lectura: la que mandaste ya se usó.',
    },
  });
  const rejected = (error: string, reason: string, nextAction: string): Route => ({
    status: 402,
    body: { ...CHALLENGE_402, error, reason, retryable: false, next_action: nextAction },
  });
  const NADA_SE_GASTO =
    'El pago no verificó y NADA se gastó. Firmá una autorización nueva siguiendo `accepts` y ' +
    'reenviá la request.';

  /** Every answer after paying that must NOT license a second signature. */
  const AFTER_PAYING: Array<{ label: string; route: Route; resend: PaymentResend; transient: boolean }> = [
    { label: '503 facilitator_unavailable', route: busy('facilitator_unavailable'), resend: 'same-header', transient: true },
    {
      label: '503 settlement_unconfirmed',
      route: busy('settlement_unconfirmed', { transaction: SETTLEMENT_TX }),
      resend: 'same-header',
      transient: true,
    },
    { label: '503 authorization_in_flight', route: busy('authorization_in_flight'), resend: 'same-header', transient: true },
    { label: '503 settlement_in_progress', route: busy('settlement_in_progress'), resend: 'same-header', transient: true },
    { label: '503 payment_store_unavailable', route: busy('payment_store_unavailable'), resend: 'same-header', transient: true },
    { label: '409 authorization_spent', route: conflict('authorization_spent'), resend: 'reconcile', transient: false },
    {
      label: '409 authorization_already_settled',
      route: conflict('authorization_already_settled'),
      resend: 'reconcile',
      transient: false,
    },
    {
      // describe-net docs/BACKLOG.md:106 — a /verify that passed and a /settle
      // that refused, answered with the 402 that says "nothing was spent".
      label: '402 FACILITATOR_ERROR',
      route: rejected('FACILITATOR_ERROR', 'contract_call_failed', NADA_SE_GASTO),
      resend: 'reconcile',
      transient: false,
    },
    {
      label: '402 PAYMENT_SETTLEMENT_FAILED',
      route: rejected(
        'PAYMENT_SETTLEMENT_FAILED',
        'settlement_failed',
        'La liquidación falló DESPUÉS de aceptar la autorización: puede haberse consumido on-chain.',
      ),
      resend: 'reconcile',
      transient: false,
    },
    {
      label: '500 with X-Payment-Receipt',
      route: { status: 500, body: {}, headers: { 'X-Payment-Receipt': SETTLEMENT_TX } },
      resend: 'same-header',
      transient: true,
    },
    { label: '500 with no body at all', route: { status: 500, notJson: 'Internal Server Error' }, resend: 'same-header', transient: true },
    { label: '504 from the gateway', route: { status: 504, body: { message: 'Endpoint request timed out' } }, resend: 'same-header', transient: true },
    { label: 'timeout', route: { hang: true }, resend: 'same-header', transient: true },
    { label: 'dead socket', route: { throws: new TypeError('fetch failed') }, resend: 'same-header', transient: true },
    {
      label: '429 at the edge',
      route: { status: 429, headers: { 'Retry-After': '2' }, body: { message: 'Too Many Requests' } },
      resend: 'same-header',
      transient: true,
    },
  ];

  /** The whitelist — describe.net's two answers that mean nothing was settled. */
  const SIGN_AGAIN: Array<{ label: string; route: Route }> = [
    {
      label: '402 PAYMENT_VERIFICATION_FAILED',
      route: rejected('PAYMENT_VERIFICATION_FAILED', 'invalid_signature', NADA_SE_GASTO),
    },
    // A proxy that strips the header: describe.net saw no payment at all.
    { label: '402 payment_required on the first send', route: { status: 402, body: CHALLENGE_402 } },
  ];

  const caughtPaid = async (run: Promise<unknown>) => {
    const err = await run.then(
      () => {
        throw new Error('expected the call to throw');
      },
      (e: unknown) => e,
    );
    expect(failedAfterPaying(err)).toBe(true);
    return err as DescribeError & { payment: NonNullable<DescribeError['payment']> };
  };

  it('503 tras pagar: Retry-After 5 arrives as 5, the retry re-sends the SAME header, and the payer signs ONCE', async () => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: busy('facilitator_unavailable'),
      [`${PATH}#3`]: DELIVERED,
    });
    const validBefore = Math.floor(Date.now() / 1000) + 300;
    const pay = spyPayer(validBefore);
    const client = paidClient(server, pay);

    // The caller the README taught until today: retry while `transient`.
    const errors: DescribeError[] = [];
    let result: WalletBreakdown | undefined;
    for (let attempt = 0; attempt < 4 && result === undefined; attempt++) {
      try {
        result = await client.walletBreakdown(KNOWN);
      } catch (e) {
        if (!(e instanceof DescribeError)) throw e;
        errors.push(e);
        if (!e.transient) break;
      }
    }

    expect(errors).toHaveLength(1);
    const [err] = errors;
    expect(failedAfterPaying(err)).toBe(true);
    expect(err.transient).toBe(true);
    expect(err.payment).toMatchObject({
      resend: 'same-header',
      retryAfterSeconds: 5,
      serverError: 'facilitator_unavailable',
      retryable: true,
      validBefore,
      status: 503,
      // What ties a transfer on-chain to THIS authorization: public, read off the envelope.
      nonce: `0x${(1).toString(16).padStart(64, '0')}`,
      network: 'eip155:8453',
    });
    expect(err.payment!.nextAction).toContain('MISMO header');
    expect(err.message).toContain('re-sends the SAME');
    expect(err.message).toContain('after 5 s (Retry-After)');
    expect(err.message).not.toContain('unlocks');

    expect(result?.finalScore).toBe(83.0);
    expect(pay).toHaveBeenCalledTimes(1);
    // Every route of the mock was served — none of them is a double left unused.
    expect(server.calls).toHaveLength(3);
    expect(server.calls[2].path).toBe(PATH);
    expect(server.calls[2].headers['X-PAYMENT']).toBe(await pay.mock.results[0].value);
    expect(server.calls[2].headers['X-PAYMENT']).toBe(server.calls[1].headers['X-PAYMENT']);
  });

  it('every answer after paying outside the whitelist: calling again re-sends the SAME header, the payer signs ONCE', async () => {
    for (const c of AFTER_PAYING) {
      const server = mockServer({
        [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
        [`${PATH}#2`]: c.route,
        [`${PATH}#3`]: DELIVERED,
      });
      const pay = spyPayer();
      const client = paidClient(server, pay);

      const err = await caughtPaid(client.walletBreakdown(KNOWN));
      expect(err.payment.resend, c.label).toBe(c.resend);
      expect(err.transient, c.label).toBe(c.transient);
      // The Python twin's assertion, mirrored: outside the whitelist nothing
      // tells the caller to go and get a new challenge.
      expect(err.message, c.label).not.toMatch(/new challenge/i);
      expect(err.message, c.label).not.toContain('unlocks');
      expect(err.message, c.label).toContain('AFTER paying');

      // The bluntest retry there is: ignore every flag and call again.
      const again = await client.walletBreakdown(KNOWN);
      expect(again.finalScore, c.label).toBe(83.0);
      expect(pay, c.label).toHaveBeenCalledTimes(1);
      expect(server.calls, c.label).toHaveLength(3);
      expect(server.calls[2].headers['X-PAYMENT'], c.label).toBe(server.calls[1].headers['X-PAYMENT']);
    }
  });

  it('the whitelist, and only it, lets the authorization go: the next call asks for a new challenge and signs a new one', async () => {
    for (const c of SIGN_AGAIN) {
      const server = mockServer({
        [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
        [`${PATH}#2`]: c.route,
        [`${PATH}#3`]: { status: 402, body: CHALLENGE_402 },
        [`${PATH}#4`]: DELIVERED,
      });
      const pay = spyPayer();
      const client = paidClient(server, pay);

      const err = await caughtPaid(client.walletBreakdown(KNOWN));
      expect(err.payment.resend, c.label).toBe('new-challenge-ok');
      expect(err.transient, c.label).toBe(false);
      expect(err.message, c.label).toMatch(/new challenge/);

      const again = await client.walletBreakdown(KNOWN);
      expect(again.finalScore, c.label).toBe(83.0);
      expect(pay, c.label).toHaveBeenCalledTimes(2);
      expect(server.calls, c.label).toHaveLength(4);
      expect(server.calls[2].headers['X-PAYMENT'], c.label).toBeUndefined();
      expect(server.calls[3].headers['X-PAYMENT'], c.label).not.toBe(server.calls[1].headers['X-PAYMENT']);
    }
  });

  it('the closing criterion: a caller that follows the SDK reaches the payer ONCE after paying, except on the whitelist 402', async () => {
    // Two policies, both written the way the README now tells them. The server
    // keeps answering the same thing, so a policy that loops loops for real.
    const policies: Record<string, (e: DescribeError) => boolean> = {
      'retry while transient': (e) => e.transient,
      'follow payment.resend': (e) => e.payment !== undefined && e.payment.resend !== 'reconcile',
    };
    for (const [name, keepGoing] of Object.entries(policies)) {
      for (const c of [...AFTER_PAYING.map((a) => ({ ...a, whitelist: false })), ...SIGN_AGAIN.map((s) => ({ ...s, whitelist: true }))]) {
        const server = mockServer({ [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 }, [PATH]: c.route });
        const pay = spyPayer();
        const client = paidClient(server, pay);

        let calls = 0;
        for (; calls < 3; calls++) {
          const err = await client.walletBreakdown(KNOWN).catch((e: unknown) => e);
          if (!(err instanceof DescribeError) || !keepGoing(err)) break;
        }

        const label = `${name} / ${c.label}`;
        if (c.whitelist && name === 'follow payment.resend') {
          // The one door that may sign again — and it did, so this double is used.
          expect(pay.mock.calls.length, label).toBeGreaterThan(1);
        } else {
          expect(pay, label).toHaveBeenCalledTimes(1);
        }
      }
    }
  });

  it('🔴 the header is in NO serialization of the error — JSON, String, message, stack, inspect — on any answer', async () => {
    for (const c of [...AFTER_PAYING, ...SIGN_AGAIN]) {
      const server = mockServer({ [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 }, [`${PATH}#2`]: c.route });
      const pay = spyPayer();
      const err = await caughtPaid(paidClient(server, pay).walletBreakdown(KNOWN));
      const header = await pay.mock.results[0].value;

      expect(header.length, c.label).toBeGreaterThan(300); // a real-sized envelope, not a word
      expect(server.calls[1].headers['X-PAYMENT'], c.label).toBe(header); // it DID leave
      for (const shown of [
        JSON.stringify(err),
        String(err),
        err.message,
        String(err.stack),
        inspect(err, { depth: 10, showHidden: true }),
      ]) {
        expect(shown, c.label).not.toContain(header);
      }
      // Positive control: `payment` IS serialised, which is why the header may not live in it.
      expect(JSON.stringify(err), c.label).toContain('"resend"');
    }
  });

  it('🔴 nor in the client: JSON.stringify and util.inspect of it see no held header, and yet it is held', async () => {
    const header = envelope(7, Math.floor(Date.now() / 1000) + 300);
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: busy('facilitator_unavailable'),
      [`${PATH}#3`]: DELIVERED,
    });
    // A plain function, not a spy: `vi.fn` keeps every result it returned, and
    // inspecting it would find the header in the test double, not in the client.
    const client = testClient({ fetchImpl: server.fetch, payer: { pay: async () => header } });

    await caughtPaid(client.walletBreakdown(KNOWN));

    expect(JSON.stringify(client)).not.toContain(header);
    expect(inspect(client, { depth: 20, showHidden: true })).not.toContain(header);
    // ...and it is there, because calling again sends it.
    await client.walletBreakdown(KNOWN);
    expect(server.calls[2].headers['X-PAYMENT']).toBe(header);
  });

  it('🔴 a transport that quotes its own request in the exception does not put the header in message, String, stack, inspect or the cause chain', async () => {
    let sent = '';
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!headers['X-PAYMENT']) {
        return new Response(JSON.stringify(CHALLENGE_402), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        });
      }
      sent = headers['X-PAYMENT'];
      // The shape an HTTP client really throws: the request in the message,
      // a nested cause quoting it again, and the config on the object itself.
      const inner = Object.assign(new Error(`socket hang up while sending ${sent}`), { code: 'ECONNRESET' });
      throw Object.assign(
        new TypeError(`fetch failed: GET ${String(input)} ${JSON.stringify(headers)}`, { cause: inner }),
        { config: { headers } },
      );
    }) as typeof fetch;
    const client = testClient({ fetchImpl, payer: { pay: spyPayer() } });

    const err = await caughtPaid(client.walletBreakdown(KNOWN));

    expect(err.kind).toBe('unreachable');
    expect(sent.length).toBeGreaterThan(300);
    for (const shown of [
      err.message,
      String(err),
      String(err.stack),
      JSON.stringify(err),
      inspect(err, { depth: 10, showHidden: true }),
    ]) {
      expect(shown).not.toContain(sent);
    }
    // Positive controls: the echo WAS there and was cut, and the cause chain
    // still says what happened — name, code and the nested reason.
    expect(err.message).toContain('[x-payment-redacted]');
    const cause = err.cause as Error & { code?: string; cause?: Error & { code?: string } };
    expect(cause.name).toBe('TypeError');
    expect(cause.message).toContain('[x-payment-redacted]');
    expect(cause.cause?.code).toBe('ECONNRESET');
    expect(cause.cause?.message).toContain('socket hang up');
  });

  it('a transport error whose `message` is not a string still comes out as a paid failure, not as a raw TypeError', async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!headers['X-PAYMENT']) {
        return new Response(JSON.stringify(CHALLENGE_402), { status: 402, headers: { 'content-type': 'application/json' } });
      }
      const weird = new TypeError('placeholder');
      (weird as unknown as { message: unknown }).message = 42; // writable, and nobody promised a string
      throw weird;
    }) as typeof fetch;
    const err = await caughtPaid(testClient({ fetchImpl, payer: { pay: spyPayer() } }).walletBreakdown(KNOWN));
    expect(err.kind).toBe('unreachable');
    expect((err.cause as Error).message).toBe('42');
  });

  it('🔴 a timeout on the paid send carries a scrubbed cause too', async () => {
    let sent = '';
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!headers['X-PAYMENT']) {
        return new Response(JSON.stringify(CHALLENGE_402), { status: 402, headers: { 'content-type': 'application/json' } });
      }
      sent = headers['X-PAYMENT'];
      const abort = new Error(`aborted while sending ${sent}`);
      abort.name = 'AbortError';
      throw abort;
    }) as typeof fetch;
    const err = await caughtPaid(testClient({ fetchImpl, payer: { pay: spyPayer() } }).walletBreakdown(KNOWN));
    expect(err.kind).toBe('timeout');
    expect(inspect(err, { depth: 10, showHidden: true })).not.toContain(sent);
    expect((err.cause as Error).name).toBe('AbortError');
  });

  it('🔴 a body that echoes the header has it cut out of serverReason, serverError and nextAction — before the truncation', async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const header = ((init?.headers ?? {}) as Record<string, string>)['X-PAYMENT'];
      const json = { 'content-type': 'application/json' };
      if (!header) return new Response(JSON.stringify(CHALLENGE_402), { status: 402, headers: json });
      return new Response(
        JSON.stringify({
          // At the very start, so a cut at 120 / 300 / 600 chars taken BEFORE
          // the scrub would leave a prefix of it standing.
          error: header,
          message: `${encodeURIComponent(header)} was not accepted`,
          next_action: `${header} — re-send it`,
        }),
        { status: 503, headers: json },
      );
    }) as typeof fetch;
    const pay = spyPayer();
    const err = await caughtPaid(testClient({ fetchImpl, payer: { pay } }).walletBreakdown(KNOWN));
    const header = await pay.mock.results[0].value;
    const prefix = header.slice(0, 40);

    expect(err).toBeInstanceOf(DescribeHTTPError);
    const serverReason = (err as DescribeHTTPError).serverReason;
    expect(serverReason).toContain('[x-payment-redacted]');
    for (const shown of [JSON.stringify(err), err.message, String(serverReason)]) {
      expect(shown).not.toContain(prefix);
    }
    expect(err.payment.serverError).toBe('[x-payment-redacted]');
    expect(err.payment.nextAction).toContain('[x-payment-redacted]');
    expect(serverReason).not.toContain(encodeURIComponent(header).slice(0, 40));
    // And the classification read the RAW value, which is not a whitelist code.
    expect(err.payment.resend).toBe('same-header');
  });

  it('🔴 the scrub also catches the header percent-encoded and with escaped slashes — base64 carries `/`, `+` and `=`', async () => {
    // The spy's envelopes happen to encode to base64 with none of the three,
    // so this one is built to carry all of them.
    const header = `eyJ4NDAy${'Vm/lc+NpbW='.repeat(12)}`;
    const escaped = header.split('/').join('\\/');
    expect(encodeURIComponent(header)).not.toBe(header);
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const sent = ((init?.headers ?? {}) as Record<string, string>)['X-PAYMENT'];
      const json = { 'content-type': 'application/json' };
      if (!sent) return new Response(JSON.stringify(CHALLENGE_402), { status: 402, headers: json });
      return new Response(
        JSON.stringify({
          error: 'facilitator_unavailable',
          message: `rejected ${encodeURIComponent(sent)}`,
          next_action: `re-send ${escaped}`,
        }),
        { status: 503, headers: json },
      );
    }) as typeof fetch;
    const err = await caughtPaid(
      testClient({ fetchImpl, payer: { pay: async () => header } }).walletBreakdown(KNOWN),
    );
    const serverReason = String((err as DescribeHTTPError).serverReason);
    for (const shown of [serverReason, err.message, String(err.payment.nextAction), JSON.stringify(err)]) {
      expect(shown).not.toContain(encodeURIComponent(header).slice(0, 30));
      expect(shown).not.toContain(escaped.slice(0, 30));
    }
    expect(serverReason).toContain('[x-payment-redacted]');
    expect(err.payment.nextAction).toBe('re-send [x-payment-redacted]');
  });

  it('MOUNTS THE BAD STATE: no release by the clock — 76 s after a 500 WITH a receipt, on a 60 s authorization, the read is re-sent, not bought again', async () => {
    // The refuter's P1-2 of 2026-11-16, reproduced: `uvd-x402-sdk` stamps
    // `validBefore = now + 60` on five of its six chains, describe.net replays
    // a settled read from its receipt for 300-1800 s, and the first version of
    // this client let go at `validBefore + 15` and signed again.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0_MS);
    const validBefore = T0_MS / 1000 + 60;
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { status: 500, body: {}, headers: { 'X-Payment-Receipt': SETTLEMENT_TX } },
      [`${PATH}#3`]: DELIVERED, // describe.net's replay from the receipt
    });
    const pay = spyPayer(validBefore);
    const client = paidClient(server, pay);

    const err = await caughtPaid(client.walletBreakdown(KNOWN));
    expect(err.payment).toMatchObject({ settlement: 'settled', validBefore, resend: 'same-header' });

    vi.setSystemTime(T0_MS + 76_000);
    const result = await client.walletBreakdown(KNOWN);

    expect(result.finalScore).toBe(83.0);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(server.calls).toHaveLength(3);
    expect(server.calls[2].headers['X-PAYMENT']).toBe(server.calls[1].headers['X-PAYMENT']);
  });

  it('past validBefore the expired authorization is re-sent, and only describe.net releases it — PAYMENT_VERIFICATION_FAILED, then a new signature', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0_MS);
    const validBefore = T0_MS / 1000 + 300;
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { hang: true }, // a connect timeout: it may never have reached the paywall
      // An hour later the re-send reaches a paywall that never saw it: the
      // facilitator refuses an expired authorization BEFORE moving anything.
      [`${PATH}#3`]: rejected('PAYMENT_VERIFICATION_FAILED', 'expired', NADA_SE_GASTO),
      [`${PATH}#4`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#5`]: DELIVERED,
    });
    const pay = spyPayer(validBefore);
    const client = paidClient(server, pay);

    await caughtPaid(client.walletBreakdown(KNOWN));
    vi.setSystemTime(T0_MS + 3_600_000);
    const released = await caughtPaid(client.walletBreakdown(KNOWN));
    expect(released.payment.resend).toBe('new-challenge-ok');
    expect(server.calls[2].headers['X-PAYMENT']).toBe(server.calls[1].headers['X-PAYMENT']);
    expect(pay).toHaveBeenCalledTimes(1);

    await client.walletBreakdown(KNOWN);
    expect(pay).toHaveBeenCalledTimes(2);
    expect(server.calls).toHaveLength(5);
    expect(server.calls[3].headers['X-PAYMENT']).toBeUndefined();
  });

  it('forgetAuthorization(error) is the caller\'s way out of a 409 — and it drops only what that error was about', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0_MS);
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: conflict('authorization_spent'),
      [`${PATH}#3`]: conflict('authorization_spent'), // a day later: re-sent, still a 409
      [`${PATH}#4`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#5`]: DELIVERED,
    });
    const pay = spyPayer(T0_MS / 1000 + 300);
    const client = paidClient(server, pay);

    const first = await caughtPaid(client.walletBreakdown(KNOWN));
    expect(first.payment.resend).toBe('reconcile');
    expect(first.payment.retryable).toBe(false);
    expect(first.message).toContain('forgetAuthorization');
    // 300 s from expiring, it can still execute: refused, whatever the caller thinks.
    expect(client.forgetAuthorization(first)).toBe('may-still-execute');
    vi.setSystemTime(T0_MS + (300 + AUTHORIZATION_EXPIRY_MARGIN_SECONDS - 1) * 1000);
    expect(client.forgetAuthorization(first)).toBe('may-still-execute'); // inside the clock margin

    vi.setSystemTime(T0_MS + 86_400_000);
    const again = await caughtPaid(client.walletBreakdown(KNOWN));
    expect(pay).toHaveBeenCalledTimes(1); // the clock released nothing
    expect(server.calls[2].headers['X-PAYMENT']).toBe(server.calls[1].headers['X-PAYMENT']);

    // Somebody else's error, a non-error and a plain object drop nothing.
    expect(testClient().forgetAuthorization(again)).toBe('not-held');
    expect(client.forgetAuthorization(new Error('not ours'))).toBe('not-held');
    expect(client.forgetAuthorization(undefined)).toBe('not-held');
    expect(client.forgetAuthorization(structuredClone(again))).toBe('not-held');
    // The caller checked on-chain: past validBefore, no transfer. Now it
    // decides — through its own error layer, which wrapped ours.
    expect(client.forgetAuthorization(new Error('app layer', { cause: again }))).toBe('forgotten');
    expect(client.forgetAuthorization(first)).toBe('not-held'); // already gone

    await client.walletBreakdown(KNOWN);
    expect(pay).toHaveBeenCalledTimes(2);
    expect(server.calls).toHaveLength(5);
    expect(server.calls[3].headers['X-PAYMENT']).toBeUndefined();
    expect(server.calls[4].headers['X-PAYMENT']).not.toBe(server.calls[1].headers['X-PAYMENT']);
  });

  it('MOUNTS THE BAD STATE: a payer that returns no header is stopped BEFORE anything is held or sent', async () => {
    // Empty, blank, not a string, a CR/LF fetch would refuse to put on the
    // wire, and a character outside visible ASCII (an x402 envelope is base64).
    for (const bad of ['', '   ', undefined, 42, 'eyJhIjoxfQ==\r\nX-Injected: 1', 'eyJhIjoxfQ==é']) {
      const server = mockServer({
        [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
        [`${PATH}#2`]: { status: 402, body: CHALLENGE_402 },
        [PATH]: DELIVERED,
      });
      let calls = 0;
      const client = paidClient(server, async () => {
        calls += 1;
        return (calls === 1 ? bad : envelope(1, Math.floor(Date.now() / 1000) + 300)) as string;
      });

      const err = await client.walletBreakdown(KNOWN).catch((e: unknown) => e);
      expect(err, JSON.stringify(bad)).toBeInstanceOf(TypeError);
      expect(failedAfterPaying(err), JSON.stringify(bad)).toBe(false); // nothing transmitted
      expect(server.calls, JSON.stringify(bad)).toHaveLength(1); // the paid request never went out

      // And nothing is held: the next call starts over with a challenge.
      await client.walletBreakdown(KNOWN);
      expect(server.calls[1].headers['X-PAYMENT'], JSON.stringify(bad)).toBeUndefined();
      expect(calls, JSON.stringify(bad)).toBe(2);
    }
  });

  it('a validBefore stamped in milliseconds is unreadable, not a date in the year 58000', async () => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: busy('facilitator_unavailable'),
    });
    const err = await caughtPaid(paidClient(server, spyPayer(Date.now() + 300_000)).walletBreakdown(KNOWN));
    expect(err.payment.validBefore).toBeNull();
  });

  it('🔴 the paid send never follows a redirect — the X-PAYMENT is not handed to whatever host a Location names', async () => {
    const redirects: Array<[string | undefined, RequestRedirect | undefined]> = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const header = ((init?.headers ?? {}) as Record<string, string>)['X-PAYMENT'];
      redirects.push([header, init?.redirect]);
      const json = { 'content-type': 'application/json' };
      if (!header) return new Response(JSON.stringify(CHALLENGE_402), { status: 402, headers: json });
      return new Response(JSON.stringify(WALLET_BREAKDOWN), { status: 200, headers: json });
    }) as typeof fetch;

    await testClient({ fetchImpl, payer: { pay: spyPayer() } }).walletBreakdown(KNOWN);

    expect(redirects).toHaveLength(2);
    expect(redirects[0][1]).toBe('follow'); // the free ask carries nothing worth stealing
    expect(redirects[1][0]).toBeTruthy();
    // 'manual', not 'error': with 'error' undici rejects with `fetch failed`,
    // which reads as a dead socket and is re-sent forever (refuter, round 2).
    expect(redirects[1][1]).toBe('manual');
  });

  it('a redirect that answers the paid send is an ANSWER — reconcile, held, re-sent to the same URL, never followed', async () => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { status: 301, body: {}, headers: { Location: 'https://elsewhere.invalid/steal' } },
      [`${PATH}#3`]: DELIVERED,
    });
    const pay = spyPayer();
    const client = paidClient(server, pay);

    const err = await caughtPaid(client.walletBreakdown(KNOWN));
    expect(err.status).toBe(301);
    expect(err.payment.resend).toBe('reconcile');
    expect(err.transient).toBe(false);

    await client.walletBreakdown(KNOWN);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(server.calls.map((c) => c.path)).toEqual([PATH, PATH, PATH]);
    expect(server.calls[2].headers['X-PAYMENT']).toBe(server.calls[1].headers['X-PAYMENT']);
  });

  it('forgetAuthorization with an unreadable validBefore is refused unless forced', async () => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: conflict('authorization_spent'),
      [`${PATH}#3`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#4`]: DELIVERED,
    });
    let n = 0;
    const client = paidClient(server, async () => `OPAQUE-PAYER-ENVELOPE-000${++n}`);
    const err = await caughtPaid(client.walletBreakdown(KNOWN));
    expect(err.payment.validBefore).toBeNull();
    expect(client.forgetAuthorization(err)).toBe('may-still-execute');
    expect(client.forgetAuthorization(err, { force: true })).toBe('forgotten');
    await client.walletBreakdown(KNOWN);
    expect(n).toBe(2);
    expect(server.calls[3].headers['X-PAYMENT']).toBe('OPAQUE-PAYER-ENVELOPE-0002');
  });

  it('a header this client cannot date is held until the SERVER lets it go — a day later it is still re-sent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0_MS);
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: busy('facilitator_unavailable'),
      [`${PATH}#3`]: DELIVERED,
    });
    // Not base64 JSON: a payer of some other scheme, or of some other shape.
    const pay = vi.fn(async (_challenge: X402Challenge) => 'OPAQUE-PAYER-ENVELOPE-0001');
    const client = paidClient(server, pay);

    const err = await caughtPaid(client.walletBreakdown(KNOWN));
    expect(err.payment.validBefore).toBeNull();

    vi.setSystemTime(T0_MS + 86_400_000);
    await client.walletBreakdown(KNOWN);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(server.calls).toHaveLength(3);
    expect(server.calls[2].headers['X-PAYMENT']).toBe('OPAQUE-PAYER-ENVELOPE-0001');
  });

  it('retryAfterSeconds: the header, then the body, capped at 30 — and `5.5` is not a day in 2001', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0_MS);
    const in10s = new Date(T0_MS + 10_000).toUTCString(); // IMF-fixdate
    const table: Array<[string, Record<string, string>, Record<string, unknown>, number | null]> = [
      ['delay-seconds', { 'Retry-After': '5' }, {}, 5],
      ['zero is a wait too', { 'Retry-After': '0' }, {}, 0],
      ['above the ceiling', { 'Retry-After': '120' }, {}, MAX_RETRY_AFTER_SECONDS],
      ['the header wins over the body', { 'Retry-After': '3' }, { retry_after_seconds: 9 }, 3],
      ['no header: the body field', {}, { retry_after_seconds: 7 }, 7],
      ['the body is capped too', {}, { retry_after_seconds: 3600 }, MAX_RETRY_AFTER_SECONDS],
      ['an IMF-fixdate ten seconds ahead', { 'Retry-After': in10s }, {}, 10],
      ['MOUNTS THE BAD STATE: 5.5 is neither, so the body speaks', { 'Retry-After': '5.5' }, { retry_after_seconds: 4 }, 4],
      ['MOUNTS THE BAD STATE: 5.5 with no body field is no wait, not 0', { 'Retry-After': '5.5' }, {}, null],
      ['a negative number is not delay-seconds', { 'Retry-After': '-1' }, {}, null],
      ['nothing at all', {}, {}, null],
    ];
    for (const [label, headers, body, expected] of table) {
      const server = mockServer({
        [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
        [`${PATH}#2`]: { status: 503, headers, body: { error: 'facilitator_unavailable', ...body } },
      });
      const err = await caughtPaid(paidClient(server, spyPayer()).walletBreakdown(KNOWN));
      expect(err.payment.retryAfterSeconds, label).toBe(expected);
    }
  });

  it('MOUNTS THE BAD STATE: the whitelist is exact — a variant of the code, or payment_required on a RE-send, licenses nothing', async () => {
    for (const variant of [
      'payment_verification_failed',
      ' PAYMENT_VERIFICATION_FAILED',
      'PAYMENT_VERIFICATION_FAILED ',
      'Payment_Required',
    ]) {
      const server = mockServer({
        [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
        [`${PATH}#2`]: rejected(variant, 'invalid_signature', NADA_SE_GASTO),
        [`${PATH}#3`]: DELIVERED,
      });
      const pay = spyPayer();
      const client = paidClient(server, pay);

      const err = await caughtPaid(client.walletBreakdown(KNOWN));
      expect(err.payment.resend, JSON.stringify(variant)).toBe('reconcile');
      await client.walletBreakdown(KNOWN);
      expect(pay, JSON.stringify(variant)).toHaveBeenCalledTimes(1);
      expect(server.calls[2].headers['X-PAYMENT']).toBe(server.calls[1].headers['X-PAYMENT']);
    }

    // paybox.md: "`payment_required` speaks only for the request that got it:
    // if you presented that authorization earlier and got a `503`, that `503`
    // still rules."
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: busy('facilitator_unavailable'),
      [`${PATH}#3`]: { status: 402, body: CHALLENGE_402 }, // the re-send arrived with no header
      [`${PATH}#4`]: DELIVERED,
    });
    const pay = spyPayer();
    const client = paidClient(server, pay);
    await caughtPaid(client.walletBreakdown(KNOWN));
    const resent = await caughtPaid(client.walletBreakdown(KNOWN));
    expect(resent.payment.resend).toBe('same-header');
    await client.walletBreakdown(KNOWN);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(server.calls).toHaveLength(4);
    expect(server.calls[3].headers['X-PAYMENT']).toBe(server.calls[1].headers['X-PAYMENT']);
  });

  it('one authorization per resource: another wallet is its own purchase, and agent() holds its own', async () => {
    const OTHER_PATH = `/reputation/wallet/${OTHER}`;
    const AGENT_PATH = '/reputation/agent/base/42';
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: busy('facilitator_unavailable'),
      [`${OTHER_PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${OTHER_PATH}#2`]: { body: { ...WALLET_BREAKDOWN, wallet: OTHER } },
      [`${PATH}#3`]: DELIVERED,
      [`${AGENT_PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${AGENT_PATH}#2`]: busy('settlement_in_progress'),
      [`${AGENT_PATH}#3`]: { body: { network: 'base', agent_id: 42 } },
    });
    const pay = spyPayer();
    const client = paidClient(server, pay);
    const sentTo = (path: string) =>
      server.calls.filter((call) => call.path === path).map((call) => call.headers['X-PAYMENT']);

    await caughtPaid(client.walletBreakdown(KNOWN));
    await client.walletBreakdown(OTHER);
    await client.walletBreakdown(KNOWN);
    await caughtPaid(client.agent('base', 42));
    const agent = await client.agent('base', '42'); // same resource, spelled as a string

    expect(agent.agentId).toBe('42');
    expect(pay).toHaveBeenCalledTimes(3);
    expect(server.calls).toHaveLength(8);
    const [, mine, mineAgain] = sentTo(PATH);
    const [, other] = sentTo(OTHER_PATH);
    const [, agentFirst, agentAgain] = sentTo(AGENT_PATH);
    expect(mineAgain).toBe(mine);
    expect(other).not.toBe(mine);
    expect(agentAgain).toBe(agentFirst);
    expect(agentFirst).not.toBe(mine);
  });

  it('MOUNTS THE BAD STATE: once the read is delivered the authorization is let go — the next read is a new purchase', async () => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: busy('facilitator_unavailable'),
      [`${PATH}#3`]: DELIVERED,
      [`${PATH}#4`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#5`]: DELIVERED,
    });
    const pay = spyPayer();
    const client = paidClient(server, pay);

    await caughtPaid(client.walletBreakdown(KNOWN));
    await client.walletBreakdown(KNOWN); // the re-send, delivered
    await client.walletBreakdown(KNOWN); // a second read: one authorization pays one read

    expect(pay).toHaveBeenCalledTimes(2);
    expect(server.calls).toHaveLength(5);
    expect(server.calls[3].headers['X-PAYMENT']).toBeUndefined();
    expect(server.calls[4].headers['X-PAYMENT']).not.toBe(server.calls[2].headers['X-PAYMENT']);
  });

  it('MOUNTS THE BAD STATE: concurrency — calls share the authorization in flight, and a late answer never puts back, nor drops, the wrong one', async () => {
    // A fetch whose paid answers the test releases by hand, in the order it
    // chooses: the only way to put a slow request next to a fast one.
    const parked: Array<(response: Response) => void> = [];
    const sent: string[] = [];
    const json = { 'content-type': 'application/json' };
    const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: json });
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const header = ((init?.headers ?? {}) as Record<string, string>)['X-PAYMENT'];
      if (!header) return answer(402, CHALLENGE_402);
      sent.push(header);
      return new Promise<Response>((resolve) => parked.push(resolve));
    }) as typeof fetch;
    const pay = spyPayer();
    const client = testClient({ fetchImpl, payer: { pay } });
    const call = () => client.walletBreakdown(KNOWN).catch((e: unknown) => e);
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const last = () => sent[sent.length - 1];

    // 1. Two calls at once for one resource: ONE signature, sent by both.
    const a = call();
    await flush();
    const b = call();
    await flush();
    expect(pay).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
    const h1 = sent[0];
    expect(sent[1]).toBe(h1);

    // 2. `a` is delivered while `b` still has H1 out: H1 is NOT let go — `b`
    //    took it too. `b` answers late with a 503: the read H1 bought for `b`
    //    is now OWED to it.
    parked.shift()!(answer(200, WALLET_BREAKDOWN));
    await a;
    parked.shift()!(answer(503, { error: 'facilitator_unavailable' }));
    await b;

    // 3. So the next call — `b`'s retry, exactly as its error told it —
    //    re-sends H1 and signs nothing. Delivered with nobody else on it and
    //    nothing owed: NOW H1 is let go.
    //    ⚠️ Until c0der's round 1 (P1-1) steps 2-3 read *"`a` is delivered,
    //    which releases H1 … So the next read is a new purchase, H2"*. That was
    //    the double payment: `b` paid for its read with H1, was told to re-send
    //    H1, and its retry bought the read again with H2.
    const bRetry = call();
    await flush();
    expect(pay).toHaveBeenCalledTimes(1);
    expect(last()).toBe(h1);
    parked.shift()!(answer(200, WALLET_BREAKDOWN));
    await bRetry;

    // 4. The next read is a new purchase, H2 — and `d` shares it.
    const c = call();
    await flush();
    expect(pay).toHaveBeenCalledTimes(2);
    const h2 = last();
    expect(h2).not.toBe(h1);
    const d = call();
    await flush();
    expect(last()).toBe(h2);

    // 5. `d` gets a 503; THEN `c` — H2's first send — meets a 402
    //    `payment_required` (a proxy stripped the header). H2 was sent twice,
    //    so that 402 does not speak for `d`'s send: H2 stays held. (The
    //    opposite order — the FIRST send answered first — is the R3 test.)
    parked.pop()!(answer(503, { error: 'facilitator_unavailable' }));
    await d;
    parked.shift()!(answer(402, CHALLENGE_402));
    const cErr = await caughtPaid(c.then((v) => { if (v instanceof Error) throw v; return v; }));
    expect(cErr.payment.resend).toBe('same-header');

    // 6. A re-send of H2 is in flight: forgetting it is refused, force or not.
    const e = call();
    await flush();
    expect(last()).toBe(h2);
    expect(pay).toHaveBeenCalledTimes(2);
    expect(client.forgetAuthorization(cErr)).toBe('in-flight');
    expect(client.forgetAuthorization(cErr, { force: true })).toBe('in-flight');
    //    A second re-send of H2 meets PAYMENT_VERIFICATION_FAILED: H2 is let go
    //    while `e` is still out, and the next call signs H3.
    const x = call();
    await flush();
    expect(last()).toBe(h2);
    parked.pop()!(answer(402, { ...CHALLENGE_402, error: 'PAYMENT_VERIFICATION_FAILED' }));
    const xErr = await caughtPaid(x.then((v) => { if (v instanceof Error) throw v; return v; }));
    expect(xErr.payment.resend).toBe('new-challenge-ok');
    const f = call();
    await flush();
    expect(pay).toHaveBeenCalledTimes(3);
    const h3 = last();
    expect(h3).not.toBe(h2);
    // cErr was about H2; H3 is not it.
    expect(client.forgetAuthorization(cErr, { force: true })).toBe('not-held');

    // 7. `e`'s late 200 delivers H2 — and must not drop H3, which is not its own.
    parked.shift()!(answer(200, WALLET_BREAKDOWN));
    await e;
    parked.shift()!(answer(503, { error: 'facilitator_unavailable' }));
    await f;
    const g = call();
    await flush();
    expect(pay).toHaveBeenCalledTimes(3);
    expect(last()).toBe(h3);
    parked.shift()!(answer(200, WALLET_BREAKDOWN));
    await g;
    expect(parked).toHaveLength(0); // every parked request was answered
  });

  // -------------------------------------------------------------------------
  // c0der's round 1 (2026-11-16): calls that cross BEFORE the signature, the
  // read each of them is owed, and the two guards whose mutants survived.
  // -------------------------------------------------------------------------

  /** A Response shaped like describe.net's, for the fetches written by hand below. */
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const unconfirmed = () =>
    reply(
      503,
      { error: 'settlement_unconfirmed', transaction: SETTLEMENT_TX, retryable: true, retry_after_seconds: 5 },
      { 'Retry-After': '5' },
    );
  const delivered = () => reply(200, WALLET_BREAKDOWN, { 'X-Payment-Receipt': SETTLEMENT_TX });
  const flushTasks = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** A call caught with `.catch(e => e)`, thrown again so `caughtPaid` can read it. */
  const rethrown = (value: unknown) => {
    if (value instanceof Error) throw value;
    return value;
  };

  /**
   * A fetch whose free asks always get the 402 and whose paid sends get the
   * next scripted answer, in the order they LEAVE. It counts both, so a test
   * can say how many challenges were asked for and which header went out.
   */
  const scripted = (paid: Array<() => Response>) => {
    const sends: string[] = [];
    let freeAsks = 0;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const header = ((init?.headers ?? {}) as Record<string, string>)['X-PAYMENT'];
      if (!header) {
        freeAsks += 1;
        return reply(402, CHALLENGE_402);
      }
      sends.push(header);
      // Nothing scripted for this send: a 418 ends every retry loop below
      // (`reconcile`), and the count of sends shows it happened.
      return (paid.shift() ?? (() => reply(418, {})))();
    }) as typeof fetch;
    return { fetchImpl, sends, freeAsks: () => freeAsks };
  };

  /** A fetch whose paid sends wait until the test answers them, by index, in the order it chooses. */
  const parkedFetch = () => {
    const parked: Array<(response: Response) => void> = [];
    const sent: string[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const header = ((init?.headers ?? {}) as Record<string, string>)['X-PAYMENT'];
      if (!header) return reply(402, CHALLENGE_402);
      sent.push(header);
      return new Promise<Response>((resolve) => parked.push(resolve));
    }) as typeof fetch;
    return { fetchImpl, parked, sent };
  };

  /** A caller written the way the README tells it: follow `payment.resend` (and, in a test, never sleep). */
  const followSdk = async (client: DescribeClient): Promise<unknown> => {
    for (let i = 0; i < 4; i++) {
      try {
        return await client.walletBreakdown(KNOWN);
      } catch (e) {
        if (!(e instanceof DescribeError) || !e.payment || e.payment.resend === 'reconcile') return e;
      }
    }
    return new Error('still failing after 4 calls');
  };

  it("R1 — MOUNTS THE BAD STATE: two calls at once for one resource sign ONCE, and whichever is delivered, the other's retry re-sends that authorization — never a second", async () => {
    // c0der's round 1, P1-1, measured on b8768b99 with this scenario:
    // `Promise.all` of two reads of one wallet (two components, two backend
    // requests for one agent). Both found nothing held, both signed, the second
    // overwrote the first in `#held`, the delivery of one let go of what was
    // left, and the one that got the 503 — retrying exactly as its error told
    // it to — signed a THIRD: `R1 pay calls = 3 | sends = 3`.
    // Both orders, because each is its own guard: the buyer failing while the
    // call that waited is delivered is `owed` (a delivery may not let go of a
    // read another call is owed); the buyer delivered while the call that
    // waited is still out is `readers` (a delivery may not let go while
    // another call has it out — and a call that waited counts from the hold).
    const orders: Array<[string, Array<() => Response>]> = [
      ['the buyer gets the 503, the call that waited is delivered', [unconfirmed, delivered, delivered]],
      ['the buyer is delivered, the call that waited gets the 503', [delivered, unconfirmed, delivered]],
    ];
    for (const [label, script] of orders) {
      const server = scripted(script);
      const pay = spyPayer();
      const client = testClient({ fetchImpl: server.fetchImpl, payer: { pay } });

      const results = await Promise.all([followSdk(client), followSdk(client)]);

      for (const result of results) expect(result, label).toMatchObject({ finalScore: 83.0 });
      expect(pay, label).toHaveBeenCalledTimes(1);
      // Both asked — the free ask is never single-flight, it costs nothing —
      // and the second 402 found the first call buying.
      expect(server.freeAsks(), label).toBe(2);
      expect(server.sends, label).toHaveLength(3);
      expect(new Set(server.sends).size, label).toBe(1); // one authorization, sent three times
      expect(server.sends[0], label).toBe(await pay.mock.results[0].value);
    }
  });

  it('R1b — both calls get a 503: both retries re-send the ONE authorization, both reads are served from it, and only then is it let go', async () => {
    // Measured on b8768b99: `R1b pay calls = 2 | sends = 4 | A re-sent ever?
    // false | B re-sent times 2` — A's retry sent B's header, and A's own never
    // went out again.
    const server = scripted([unconfirmed, unconfirmed, delivered, delivered, delivered]);
    const pay = spyPayer();
    const client = testClient({ fetchImpl: server.fetchImpl, payer: { pay } });

    const results = await Promise.all([followSdk(client), followSdk(client)]);

    for (const result of results) expect(result).toMatchObject({ finalScore: 83.0 });
    expect(pay).toHaveBeenCalledTimes(1);
    expect(server.sends).toHaveLength(4);
    expect(new Set(server.sends).size).toBe(1);

    // Both owed reads were handed over: nothing is owed and nobody reads it,
    // so the NEXT read is a new purchase — the owed count went back to zero.
    await client.walletBreakdown(KNOWN);
    expect(pay).toHaveBeenCalledTimes(2);
    expect(server.freeAsks()).toBe(3); // the two at once, and this one
    expect(server.sends[4]).not.toBe(server.sends[0]);
  });

  it('R2 — a second call while the first is still inside payer.pay (a human approving it in PayBox) waits for THAT signature instead of asking for its own', async () => {
    // Measured on b8768b99: `R2 pay calls = 2 | sends = 2` — the second call
    // asked, was challenged and paid while the first one waited for approval.
    let approve: () => void = () => undefined;
    const approved = new Promise<void>((resolve) => {
      approve = resolve;
    });
    const validBefore = Math.floor(Date.now() / 1000) + 300;
    let signed = 0;
    const pay = vi.fn(async (_challenge: X402Challenge) => {
      await approved;
      return envelope(++signed, validBefore);
    });
    const server = scripted([delivered, delivered]);
    const client = testClient({ fetchImpl: server.fetchImpl, payer: { pay } });

    const a = client.walletBreakdown(KNOWN);
    await flushTasks();
    expect(pay).toHaveBeenCalledTimes(1); // `a` is inside the payer, waiting for a human
    const b = client.walletBreakdown(KNOWN);
    await flushTasks();
    // `b` had every chance to pay on its own while `a` waited: it asked (free),
    // got its 402, found `a` buying, and is waiting for that signature.
    expect(server.freeAsks()).toBe(2);
    expect(pay).toHaveBeenCalledTimes(1);

    approve();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.finalScore).toBe(83.0);
    expect(rb.finalScore).toBe(83.0);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(server.sends).toHaveLength(2);
    expect(server.sends[1]).toBe(server.sends[0]);
  });

  it('R2b — MOUNTS THE BAD STATE: when the call buying the signature ends without one (its payer declined), the calls waiting on it start over — and share ONE new signature', async () => {
    let decide: () => void = () => undefined;
    const decided = new Promise<void>((resolve) => {
      decide = resolve;
    });
    const validBefore = Math.floor(Date.now() / 1000) + 300;
    let calls = 0;
    const pay = vi.fn(async (_challenge: X402Challenge) => {
      calls += 1;
      if (calls === 1) {
        await decided;
        throw new Error('declined by the human in PayBox');
      }
      return envelope(calls, validBefore);
    });
    const server = scripted([delivered, delivered]);
    const client = testClient({ fetchImpl: server.fetchImpl, payer: { pay } });

    const a = client.walletBreakdown(KNOWN).catch((e: unknown) => e);
    await flushTasks();
    const b = client.walletBreakdown(KNOWN);
    const c = client.walletBreakdown(KNOWN);
    await flushTasks();
    expect(pay).toHaveBeenCalledTimes(1); // `b` and `c` wait on `a`'s signature

    decide();
    const declined = await a;
    expect(declined).toBeInstanceOf(Error);
    expect(failedAfterPaying(declined)).toBe(false); // the payer's own throw: nothing was sent
    const [rb, rc] = await Promise.all([b, c]);
    expect(rb.finalScore).toBe(83.0);
    expect(rc.finalScore).toBe(83.0);
    // One declined, one signed — not one per waiter, and nobody left hanging.
    expect(pay).toHaveBeenCalledTimes(2);
    // One free ask each: the waiter that bought next used the 402 it had.
    expect(server.freeAsks()).toBe(3);
    expect(server.sends).toHaveLength(2);
    expect(server.sends[1]).toBe(server.sends[0]);
  });

  it('R3 — MOUNTS THE BAD STATE: the FIRST send answered payment_required while a re-send of the same header is still out — it stays held, and the payer signs once', async () => {
    // c0der's round 1, P2-1: mutant MR14 (count `sent` when the answer
    // arrives instead of when the send leaves) survived this whole file,
    // because the only test of the rule (the concurrency one above, step 5)
    // answers the RE-send first. Here the first send answers first, while the
    // second one is still out and may be settling.
    const { fetchImpl, parked, sent } = parkedFetch();
    const pay = spyPayer();
    const client = testClient({ fetchImpl, payer: { pay } });

    const first = client.walletBreakdown(KNOWN).catch((e: unknown) => e);
    await flushTasks();
    const second = client.walletBreakdown(KNOWN).catch((e: unknown) => e);
    await flushTasks();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);

    // A proxy stripped the header from the FIRST send.
    parked[0](reply(402, CHALLENGE_402));
    const firstErr = await caughtPaid(first.then(rethrown));
    expect(firstErr.payment.resend).toBe('same-header');
    expect(firstErr.message).not.toMatch(/new challenge/);
    parked[1](reply(503, { error: 'settlement_in_progress' }));
    await caughtPaid(second.then(rethrown));

    // Both reads are owed; the next call re-sends the same authorization.
    const again = client.walletBreakdown(KNOWN);
    await flushTasks();
    parked[2](delivered());
    expect((await again).finalScore).toBe(83.0);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(sent[2]).toBe(sent[0]);
  });

  it("forgetAuthorization refuses until validBefore + 15 s, to the millisecond — describe.net's own MARGEN_FIRMA_MS (dn-pay.js:714)", async () => {
    // c0der's round 1, P2-2: mutant MR5 (15 -> 0) passed the whole suite,
    // because the only test that touched the margin computed its edge from
    // the imported constant. The literal 15 is the point of this test: it is
    // `MARGEN_FIRMA_MS = 15000` in `describe-net/site/dn-pay.js:714`
    // (origin/main 3b6753d, read 2026-11-16), and `config.test.ts` pins it too.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0_MS);
    const validBefore = T0_MS / 1000 + 60;
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: conflict('authorization_spent'),
    });
    const client = paidClient(server, spyPayer(validBefore));
    const err = await caughtPaid(client.walletBreakdown(KNOWN));

    vi.setSystemTime((validBefore + 14) * 1000);
    expect(client.forgetAuthorization(err)).toBe('may-still-execute');
    vi.setSystemTime((validBefore + 15) * 1000 - 1);
    expect(client.forgetAuthorization(err)).toBe('may-still-execute');
    vi.setSystemTime((validBefore + 15) * 1000);
    expect(client.forgetAuthorization(err)).toBe('forgotten');
  });

  it('a call that ended in a timeout, a dead socket or an unreadable 200 is OVER: forgetAuthorization recognises its error and never answers in-flight for it', async () => {
    // A P3 of c0der's round 1 (MR2, MR3), taken because this round rewrote
    // exactly that bookkeeping: an error that is not recognised ("not-held")
    // or a call that never stops counting ("in-flight" forever) both fail on
    // the safe side, but leave the documented way out untested.
    const endings: Array<[string, Route]> = [
      ['timeout', { hang: true }],
      ['dead socket', { throws: new TypeError('fetch failed') }],
      ['a 200 whose JSON lacks its shape', { body: { unexpected: true } }],
    ];
    for (const [label, route] of endings) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0_MS);
      const validBefore = T0_MS / 1000 + 60;
      const server = mockServer({ [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 }, [`${PATH}#2`]: route });
      const client = paidClient(server, spyPayer(validBefore));
      const err = await caughtPaid(client.walletBreakdown(KNOWN));
      expect(client.forgetAuthorization(err), label).toBe('may-still-execute');
      vi.setSystemTime((validBefore + 15) * 1000);
      expect(client.forgetAuthorization(err), label).toBe('forgotten');
      vi.useRealTimers();
    }
  });

  it('MOUNTS THE BAD STATE: an authorization that is gone never comes back — a late 503 to a send of it does not overwrite what the next call holds', async () => {
    const { fetchImpl, parked, sent } = parkedFetch();
    const pay = spyPayer();
    const client = testClient({ fetchImpl, payer: { pay } });
    const call = () => client.walletBreakdown(KNOWN).catch((e: unknown) => e);

    const a = call();
    await flushTasks();
    const b = call();
    await flushTasks();
    expect(sent).toHaveLength(2); // both took H1

    // describe.net refuses H1 on `a`'s send: the whitelist, so it is let go —
    // for every call that shared it (paybox.md step 7: nothing was settled).
    parked[0](reply(402, { ...CHALLENGE_402, error: 'PAYMENT_VERIFICATION_FAILED' }));
    expect((await caughtPaid(a.then(rethrown))).payment.resend).toBe('new-challenge-ok');

    // The next read buys H2, while `b`'s send of H1 is still out.
    const c = call();
    await flushTasks();
    expect(pay).toHaveBeenCalledTimes(2);
    const h2 = sent[2];
    expect(h2).not.toBe(sent[0]);

    // `b` answers late, with a 503. H1 is gone, and putting it back would
    // overwrite H2 while `c` has it out: the next call must join H2.
    parked[1](reply(503, { error: 'facilitator_unavailable' }));
    await caughtPaid(b.then(rethrown));
    const d = call();
    await flushTasks();
    expect(sent[3]).toBe(h2);
    expect(pay).toHaveBeenCalledTimes(2);
    parked[2](delivered());
    parked[3](delivered());
    expect(await c).toMatchObject({ finalScore: 83.0 });
    expect(await d).toMatchObject({ finalScore: 83.0 });
  });

  it('MOUNTS THE BAD STATE: the free ask is never single-flight — five reads the route answers for free run side by side, and four that time out fail together', async () => {
    // P2-A of this round's own refuter, measured on its first draft (which
    // put the single-flight before the free ask): the partner rail, where the
    // metered route answers 200 for free, ran five concurrent reads ONE at a
    // time, and four reads during an outage failed at 1x..4x `timeoutMs`.
    // Counted at the fetch, so the assertion is the concurrency itself, not a
    // clock on a loaded machine.
    let open = 0;
    let peak = 0;
    const freeFetch = (async () => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((resolve) => setTimeout(resolve, 20));
      open -= 1;
      return reply(200, WALLET_BREAKDOWN);
    }) as typeof fetch;
    const free = testClient({ fetchImpl: freeFetch, payer: { pay: spyPayer() } });
    const reads = await Promise.all(Array.from({ length: 5 }, () => free.walletBreakdown(KNOWN)));
    for (const read of reads) expect(read.finalScore).toBe(83.0);
    expect(peak).toBe(5);

    // An outage: nothing answers, and each request dies on its own timer.
    let hanging = 0;
    let hangPeak = 0;
    const deadFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        hanging += 1;
        hangPeak = Math.max(hangPeak, hanging);
        init?.signal?.addEventListener('abort', () => {
          hanging -= 1;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })) as typeof fetch;
    const dead = testClient({ fetchImpl: deadFetch, timeoutMs: 50, payer: { pay: spyPayer() } });
    const failures = await Promise.all(
      Array.from({ length: 4 }, () => dead.walletBreakdown(KNOWN).catch((e: unknown) => e)),
    );
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(DescribeError);
      expect((failure as DescribeError).kind).toBe('timeout');
      expect(failedAfterPaying(failure)).toBe(false); // the free ask: nothing was sent
    }
    expect(hangPeak).toBe(4);
  });

  it('MOUNTS THE BAD STATE: a payer that never answers does not hang every later call — the waiter gives up after timeoutMs having sent and paid nothing, and is not counted when the signature finally comes', async () => {
    // P2-B of this round's own refuter, measured on its first draft (an
    // unbounded wait): "b: still waiting after 1 s | c: still waiting after
    // 0.5 s", with no error to hand to `forgetAuthorization()`.
    let approve: () => void = () => undefined;
    const approved = new Promise<void>((resolve) => {
      approve = resolve;
    });
    const validBefore = Math.floor(Date.now() / 1000) + 300;
    let signed = 0;
    const pay = vi.fn(async (_challenge: X402Challenge) => {
      if (signed === 0) await approved; // the first approval is the one nobody gives (yet)
      return envelope(++signed, validBefore);
    });
    const server = scripted([delivered, delivered]);
    const client = testClient({ fetchImpl: server.fetchImpl, timeoutMs: 50, payer: { pay } });

    const a = client.walletBreakdown(KNOWN);
    await flushTasks();
    const waited = await client.walletBreakdown(KNOWN).catch((e: unknown) => e);
    expect(waited).toBeInstanceOf(DescribeError);
    expect((waited as DescribeError).kind).toBe('timeout');
    expect(failedAfterPaying(waited)).toBe(false); // it sent nothing and paid nothing
    expect((waited as Error).message).toContain('sent nothing');
    expect(pay).toHaveBeenCalledTimes(1);
    expect(server.sends).toHaveLength(0);

    // The approval comes at last. The waiter that gave up is NOT among the
    // readers: the delivery lets the authorization go, and the waiter's retry
    // is a new purchase — not a re-send of `a`'s, held forever by a reader
    // that will never finish.
    approve();
    expect((await a).finalScore).toBe(83.0);
    expect((await client.walletBreakdown(KNOWN)).finalScore).toBe(83.0);
    expect(pay).toHaveBeenCalledTimes(2);
    expect(server.sends).toHaveLength(2);
    expect(server.sends[1]).not.toBe(server.sends[0]);
  });

  it("MOUNTS THE BAD STATE: when a waiter's clock and the signature land in the same turn, the waiter that was counted sends the authorization instead of giving up", async () => {
    // The clock's reaction runs first, the payer's right after it, and the
    // payer's continuation counts the waiter into `readers` before the
    // waiter's continuation reads the clock. `acquiring.outcome`, set in that
    // same block, is what tells the waiter it was counted. Without it the
    // waiter throws a timeout, and the authorization keeps a reader that will
    // never finish: held for ever, `'in-flight'` for ever.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const drain = async () => {
      for (let i = 0; i < 200; i++) await Promise.resolve();
    };
    const validBefore = Math.floor(Date.now() / 1000) + 300;
    let sign: (header: string) => void = () => undefined;
    const pay = vi.fn(
      (_challenge: X402Challenge) =>
        new Promise<string>((resolve) => {
          sign = resolve;
        }),
    );
    const server = scripted([delivered, delivered, delivered]);
    const client = testClient({ fetchImpl: server.fetchImpl, timeoutMs: 50, payer: { pay } });

    const a = client.walletBreakdown(KNOWN);
    await drain();
    expect(pay).toHaveBeenCalledTimes(1); // `a` is inside its payer
    const b = client.walletBreakdown(KNOWN).catch((e: unknown) => e);
    await drain(); // `b` got its 402 and is waiting, its clock due at +50 ms
    // Scheduled AFTER `b`'s clock with the same deadline: it fires right after it.
    setTimeout(() => sign(envelope(1, validBefore)), 50);
    vi.advanceTimersByTime(50);
    await drain();

    expect(await b).toMatchObject({ finalScore: 83.0 });
    expect((await a).finalScore).toBe(83.0);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(server.sends).toHaveLength(2);
    expect(server.sends[1]).toBe(server.sends[0]);
    // Both readers finished: it was let go, and the next read is a purchase.
    const next = client.walletBreakdown(KNOWN);
    await drain();
    expect(pay).toHaveBeenCalledTimes(2);
    sign(envelope(2, validBefore));
    await drain();
    expect((await next).finalScore).toBe(83.0);
  });

  it('serverError is capped at 120 chars and nextAction at 600 — server-written text, not a place for a whole body', async () => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { status: 503, body: { error: 'E'.repeat(500), next_action: 'n'.repeat(2000), retryable: false } },
    });
    const err = await caughtPaid(paidClient(server, spyPayer()).walletBreakdown(KNOWN));
    expect(err.payment.serverError).toBe(`${'E'.repeat(120)}…`);
    expect(err.payment.nextAction).toBe(`${'n'.repeat(600)}…`);
    expect(err.payment.retryable).toBe(false);
  });

  it('MOUNTS THE BAD STATE: a paid 200 whose JSON lacks its shape carries `payment` and is re-sent — it used to say "nothing was transmitted"', async () => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { body: { unexpected: true }, headers: { 'X-Payment-Receipt': SETTLEMENT_TX } },
      [`${PATH}#3`]: DELIVERED,
    });
    const pay = spyPayer();
    const client = paidClient(server, pay);

    const err = await caughtPaid(client.walletBreakdown(KNOWN));
    expect(err.kind).toBe('unparseable');
    expect(err.payment).toMatchObject({ settlement: 'settled', receipt: SETTLEMENT_TX, status: 200, resend: 'same-header' });
    expect(err.message).toContain('AFTER paying');
    expect(err.message).toContain('went through');

    await client.walletBreakdown(KNOWN);
    expect(pay).toHaveBeenCalledTimes(1);
    expect(server.calls[2].headers['X-PAYMENT']).toBe(server.calls[1].headers['X-PAYMENT']);
  });
});

describe('constructor', () => {
  it('refuses to build without a usable fetch, instead of dying at the first call', () => {
    // Failing here names the problem ("no fetch"); failing at the first call
    // surfaces as `unreachable`, which reads as "describe.net is down".
    expect(() => new DescribeClient({ fetchImpl: 'not a function' as never })).toThrow(TypeError);
  });

  it("an unknown config key throws, listing the valid ones — mesh's silent `userAgent`", () => {
    // ⚠️ This is the REVERSAL of a decision this constructor used to defend in
    // a comment ("a library that dies in its constructor over one [option] is
    // worse than one that ignores it"). mesh disproved it in production
    // (spec in meshrelayserv/describenet.js@04f2ecf): they passed `userAgent`
    // where this client takes `product`, the key was ignored in silence, and
    // their attribution vanished from the CDN with no symptom — every call
    // kept succeeding, so nobody looked. The Python twin already throws
    // TypeError here (keyword-only, no **kwargs); this is parity.
    const err = (() => {
      try {
        new DescribeClient({ userAgent: 'meshrelay' } as never);
        return null;
      } catch (e) {
        return e as Error;
      }
    })();

    expect(err).toBeInstanceOf(TypeError);
    // The exact key that bit mesh gets the exact fix spelled out...
    expect(err!.message).toContain("'userAgent'");
    expect(err!.message).toContain('product');
    // ...and every message lists the valid keys, so the fix never needs docs.
    expect(err!.message).toContain('baseUrl');
    expect(err!.message).toContain('jitterMs');
  });

  it('MOUNTS THE BAD STATE: a typoed key must not build a client that quietly drops the option', () => {
    // Any unknown key, not just the famous one: `jitterms` (lowercase m) would
    // otherwise build a client with the default jitter and no way to notice.
    expect(() => new DescribeClient({ jitterms: 0 } as never)).toThrow(TypeError);
    // A garbage VALUE for a KNOWN key is the other half of the rule and still
    // does NOT throw — the key you spelled right proves which protection you
    // meant, and the value falls back to its default (asserted in the jitter
    // suite below).
    expect(() => testClient({ jitterMs: -1 })).not.toThrow();
  });

  it('trims a trailing slash off baseUrl so paths never double up', async () => {
    const server = mockServer({ '/health': { body: HEALTH } });
    const client = testClient({ baseUrl: 'https://api.describe.net/', fetchImpl: server.fetch });

    await client.health();

    expect(server.calls[0].path).toBe('/health');
  });
});

// ---------------------------------------------------------------------------
// Aporte ① — the jitter, wired. KarmaKadabra, 2026-08-30.
//
// The draw itself is tested purely in `jitter.test.ts`; these three pay for a
// real timer because PLACEMENT is the part that can be wrong, and placement is
// only visible from outside. `Math.random` is stubbed so every bound below is
// exact — a timing test that hopes is a flaky test.
// ---------------------------------------------------------------------------

describe('the jitter is where it says it is', () => {
  /** Draw near the top of the window, so the delay is deterministic. */
  const pinRandom = (value: number) => vi.spyOn(Math, 'random').mockReturnValue(value);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sleeps before a free request, and jitterMs: 0 does not', async () => {
    pinRandom(0.99);
    const server = mockServer({ '/health': { body: HEALTH } });

    const slowStart = Date.now();
    await new DescribeClient({ fetchImpl: server.fetch, jitterMs: 60 }).health();
    const slept = Date.now() - slowStart;

    const fastStart = Date.now();
    await new DescribeClient({ fetchImpl: server.fetch, jitterMs: 0 }).health();
    const notSlept = Date.now() - fastStart;

    // Discriminant: delete `await this.jitter()` from `request()` and the first
    // number collapses onto the second.
    expect(slept).toBeGreaterThanOrEqual(50);
    expect(notSlept).toBeLessThan(40);
  });

  it('MOUNTS THE BAD STATE: a paid call sleeps TWICE, because it makes two requests', async () => {
    // The discriminant of the correction of 2026-08-30. The rule was first
    // written as "once per public call, before the FIRST request", which reads
    // as the careful choice and is a hole: the 402 and its replay are two
    // arrivals at describe.net, and dispersing only the first lets 27 agents
    // replay in the same instant. Put the jitter back into `getJson()` /
    // `getPaidJson()` and this goes red at one sleep instead of two.
    pinRandom(0.99);
    const path = `/reputation/wallet/${KNOWN}`;
    const server = mockServer({
      [`${path}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${path}#2`]: { body: WALLET_BREAKDOWN, headers: { 'X-Payment-Receipt': SETTLEMENT_TX } },
    });
    const client = new DescribeClient({
      fetchImpl: server.fetch,
      jitterMs: 60,
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    const started = Date.now();
    await client.walletBreakdown(KNOWN);
    const elapsed = Date.now() - started;

    expect(server.calls).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(100); // two sleeps of ~59 ms
  });

  it('a garbage jitterMs falls back to the DEFAULT, never to off', async () => {
    // The house rule for a calibrable value: garbage gives the default, never an
    // exception and never silence. Off would be the dangerous reading — a typo
    // would remove a protection the whole ecosystem shares. 0.05 of the 400 ms
    // default is 20 ms: measurable, and cheap enough for the offline loop.
    pinRandom(0.05);
    const server = mockServer({ '/health': { body: HEALTH } });
    const client = new DescribeClient({ fetchImpl: server.fetch, jitterMs: -1 });

    const started = Date.now();
    await client.health();

    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// Aporte ③ — a hash field that is not a hash. KarmaKadabra, 2026-08-30.
//
// *"Un 200 que no hizo la cosa es peor que un 503, porque el cliente lo toma por
// bueno: si nosotros no chequeáramos el tx, habríamos contado 14 ratings que no
// existen."*
// ---------------------------------------------------------------------------

describe('a malformed hash is dropped, marked and announced — never thrown', () => {
  const PATH = '/reputation/agent/base/42';

  /** A real Solana signature, `GET /feed?network=solana` on 2026-08-30. */
  const SOLANA_TX =
    '2va3P3Q664cT3Zae88Fi3LMvpKWZt1J7c7TyzJHNd8pLczbwgLbwA6hELp7eAjdnwgES2cQoq42wCPtHSy9CTXjJ';

  const agentBody = (ratings: unknown[]) => ({
    network: 'base',
    agent_id: '42',
    score: 83.0,
    review_count: ratings.length,
    ratings,
    policy_version: 'equal-weight-per-chain@2',
  });

  /** Pay once, then answer with `body`. Returns the client and what it announced. */
  const paidRun = (body: unknown, headers: Record<string, string> = {}) => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { body, headers: { 'X-Payment-Receipt': SETTLEMENT_TX, ...headers } },
    });
    const seen: DescribeFailure[] = [];
    const client = testClient({
      fetchImpl: server.fetch,
      onFailure: (f) => seen.push(f),
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });
    return { client, seen };
  };

  it('drops the value, marks the field, and hands back the rest of the answer', async () => {
    const { client, seen } = paidRun(
      agentBody([{ client: '0xrater', tx_hash: '0x', feedback_index: 1, value: 100 }]),
    );

    const agent = await client.agent('base', 42);

    // The read SURVIVES: a bad accessory field must not destroy a decomposition
    // the caller has already paid for.
    expect(agent.score).toBe(83);
    expect(agent.ratings[0].txHash).toBeNull();
    expect(agent.ratings[0].malformedHashes).toEqual(['tx_hash']);
    // ...and it is announced on the channel the consumer is already watching.
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('malformed_hash');
    expect(seen[0].error).toBeInstanceOf(DescribeMalformedHash);
    expect((seen[0].error as DescribeMalformedHash).fields).toEqual(['ratings[0].tx_hash']);
    expect(seen[0].transient).toBe(false);
    // The value as served is still reachable: `raw` keeps the body verbatim.
    expect((agent.raw.ratings as Array<{ tx_hash: string }>)[0].tx_hash).toBe('0x');
  });

  it('MOUNTS THE BAD STATE: an ABSENT hash is not a malformed one', async () => {
    // R1, one level below where it normally lives. `tx_hash: null` is
    // documented and normal ("null until the log scan reaches this entry"). If
    // absence ever started firing this alarm, every consumer would learn to
    // ignore an alarm that is right the rest of the time.
    const { client, seen } = paidRun(
      agentBody([{ client: '0xrater', tx_hash: null, feedback_index: 1, value: 100 }]),
    );

    const agent = await client.agent('base', 42);

    expect(agent.ratings[0].txHash).toBeNull();
    expect(agent.ratings[0].malformedHashes).toEqual([]);
    expect(seen).toEqual([]); // nothing was swallowed, so nothing is announced
  });

  it('MOUNTS THE BAD STATE: a real Solana signature is NOT malformed', async () => {
    // The false positive that would have shipped with an EVM-only regex, seen
    // from outside: one of the eleven chains screaming on every read.
    const { client, seen } = paidRun(
      agentBody([{ client: '0xrater', tx_hash: SOLANA_TX, feedback_index: 1, value: 100 }]),
    );

    const agent = await client.agent('base', 42);

    expect(agent.ratings[0].txHash).toBe(SOLANA_TX);
    expect(agent.ratings[0].malformedHashes).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('locates every one of them, in order, with wire names', async () => {
    const { client, seen } = paidRun(
      agentBody([
        { client: '0xa', tx_hash: SOLANA_TX, feedback_index: 1, value: 100 },
        { client: '0xb', tx_hash: 'undefined', revoked_tx: 'null', feedback_index: 2, value: 50 },
      ]),
    );

    await client.agent('base', 42);

    expect((seen[0].error as DescribeMalformedHash).fields).toEqual([
      'ratings[1].tx_hash',
      'ratings[1].revoked_tx',
    ]);
  });

  it('the receipt header gets the same check, and `pending` passes it', async () => {
    const bad = paidRun(agentBody([]), { 'X-Payment-Receipt': 'rcpt_abc123' });
    const agent = await bad.client.agent('base', 42);

    expect(agent.payment).toEqual({
      receipt: null,
      settlementPending: false, // garbage is garbage — never promoted to a state
      reused: false,
      malformedHashes: ['receipt'],
    });
    expect((bad.seen[0].error as DescribeMalformedHash).fields).toEqual(['payment.receipt']);
    // `raw` is the BODY, so this is the one malformed value it cannot preserve.
    // It survives in the message or it is lost.
    expect(bad.seen[0].error.message).toContain('rcpt_abc123');

    const pending = paidRun(agentBody([]), { 'X-Payment-Receipt': 'pending' });
    const ok = await pending.client.agent('base', 42);

    // The happy path of a freshly settled payment. Alarming here would be the
    // alarm that screams about good data.
    //
    // ⚠️ Corrected 2026-08-31, and the old assertion is worth quoting because
    // it asserted the bug: `receipt: 'pending'`. That is EM's INC-2026-08-26
    // in miniature — the placeholder riding in the field meant for the hash,
    // ready to be archived as proof by anyone who stores `payment.receipt`.
    // Legitimate did not change (no mark, no alarm); WHERE the state travels
    // did: the flag says pending, the hash field stays empty.
    expect(ok.payment).toEqual({
      receipt: null,
      settlementPending: true,
      reused: false,
      malformedHashes: [],
    });
    expect(pending.seen).toEqual([]);
  });

  it('a garbage receipt may not be called proof of settlement', async () => {
    // The failure path keeps the served string — there it is forensic evidence,
    // not a typed field — but `settlement` may not claim `'settled'` on the
    // strength of something that is not a hash. `'settled'` means we hold it.
    const path = `/reputation/wallet/${KNOWN}`;
    const server = mockServer({
      [`${path}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${path}#2`]: { status: 500, body: {}, headers: { 'X-Payment-Receipt': 'rcpt_abc123' } },
    });
    const client = testClient({
      fetchImpl: server.fetch,
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    const err = await client.walletBreakdown(KNOWN).catch((e) => e);

    expect(failedAfterPaying(err)).toBe(true);
    expect(err.payment.settlement).toBe('unknown');
    expect(err.payment.receipt).toBe('rcpt_abc123'); // kept, for the reconciliation
    expect(err.payment.settlementPending).toBe(false); // garbage is not `pending`
  });

  it('an observer that throws does not destroy a response that was paid for', async () => {
    // The one call site where a throwing callback would cost real money: it
    // fires AFTER settlement, on a successful read. `guard()`'s call site is
    // deliberately not wrapped — there the answer is already null.
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: {
        body: agentBody([{ client: '0xa', tx_hash: '0x', feedback_index: 1, value: 100 }]),
        headers: { 'X-Payment-Receipt': SETTLEMENT_TX },
      },
    });
    const client = testClient({
      fetchImpl: server.fetch,
      onFailure: () => {
        throw new Error('the consumer logger is broken');
      },
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    const agent = await client.agent('base', 42);

    expect(agent.score).toBe(83);
  });

  it('the notice is never a throw, and failOpen never covers it', async () => {
    // `DescribeMalformedHash` exists to ride a typed channel, not to be caught.
    // A read that succeeded has nothing to fail open INTO, which is why it is
    // `serviceFault: false`.
    const { client, seen } = paidRun(
      agentBody([{ client: '0xa', tx_hash: 'nope', feedback_index: 1, value: 100 }]),
    );

    await expect(client.agent('base', 42)).resolves.toBeDefined();
    expect(failOpenCovers(seen[0].error)).toBe(false);
    expect(seen[0].error.serviceFault).toBe(false);
  });
});
