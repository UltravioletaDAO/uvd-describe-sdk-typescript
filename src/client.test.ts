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
import {
  DescribeError,
  DescribeNotFound,
  DescribePaymentRefused,
  DescribePaymentRequired,
  failedAfterPaying,
  type X402Challenge,
} from './errors';
import type { AgentReputation, WalletBreakdown } from './types';

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

  it('a 404 on a FREE route does not throw with failOpen OFF either — a different axis', async () => {
    // failOpen is about THEIR outage. A 404 is about absence. Making the
    // second depend on the first would put "there is no such wallet" behind a
    // switch whose name says nothing about it.
    const server = mockServer({ '/wallets/0xnope/chains': { status: 404, body: {} } });
    const client = new DescribeClient({ fetchImpl: server.fetch, failOpen: false });

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
    const client = new DescribeClient({ fetchImpl: server.fetch, failOpen: false });

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
    // The declared parameter is what makes `pay.mock.calls[0][0]` type-check:
    // a bare `vi.fn(async () => …)` infers a zero-length argument tuple.
    const pay = vi.fn(async (_challenge: X402Challenge) => 'BASE64-X-PAYMENT');
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
    expect(result.payment).toEqual({ receipt: 'rcpt_abc123', reused: false });
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
    const client = new DescribeClient({ fetchImpl: server.fetch, payer: { pay: async () => 'ok' } });

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
    await expect(client.walletBreakdown(KNOWN)).resolves.toMatchObject({ finalScore: 83.0 });
  });

  it('a metered route that answers 200 straight away reports no payment', async () => {
    const server = mockServer({ [PATH]: { body: WALLET_BREAKDOWN } });
    const client = new DescribeClient({ fetchImpl: server.fetch });

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
      const client = new DescribeClient({
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
      const client = new DescribeClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

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
    const client = new DescribeClient({
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
        headers: { 'X-Payment-Receipt': '0xsettlementhash', 'X-Payment-Reused': 'false' },
      },
    });
    const client = new DescribeClient({
      fetchImpl: server.fetch,
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    const err = await client.walletBreakdown(KNOWN).catch((e) => e);

    expect(failedAfterPaying(err)).toBe(true);
    expect(err.payment).toMatchObject({
      settlement: 'settled',
      receipt: '0xsettlementhash',
      reused: false,
      status: 500,
      amount: '0.01',
      token: 'USDC',
    });
    // The message says it too, because the first thing anyone reads is the
    // message and not the properties.
    expect(err.message).toContain('settlement: settled');
  });

  it('no receipt is `unknown`, never "nothing happened"', async () => {
    // An unhandled 500 is rendered ABOVE the paywall middleware, so the header
    // line never runs while the settlement already did. Claiming "not settled"
    // from a missing header would be inventing a fact.
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { status: 500, body: {} },
    });
    const client = new DescribeClient({
      fetchImpl: server.fetch,
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    const err = await client.walletBreakdown(KNOWN).catch((e) => e);

    expect(err.payment).toMatchObject({ settlement: 'unknown', receipt: null, reused: null });
  });

  it('a timeout with the envelope in flight is the case that CANNOT be narrowed', async () => {
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { hang: true },
    });
    const client = new DescribeClient({
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
      reused: null,
      amount: '0.01',
      token: 'USDC',
      payTo: TREASURY_EVM,
    });
  });

  it('a 200 with an unreadable body is the worst case, and it settled', async () => {
    // Easiest one to forget: they charged, answered 200, and the bytes are
    // garbage. The old code returned `null` here.
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: { notJson: '<html>gateway</html>', headers: { 'X-Payment-Receipt': '0xabc' } },
    });
    const client = new DescribeClient({
      fetchImpl: server.fetch,
      failOpen: true,
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    const err = await client.walletBreakdown(KNOWN).catch((e) => e);

    expect(err.kind).toBe('unparseable');
    expect(err.payment).toMatchObject({ settlement: 'settled', receipt: '0xabc', status: 200 });
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
      () => new DescribeClient({ fetchImpl: noPayer.fetch }).walletBreakdown(KNOWN),
    ]);

    const stranger = mockServer({
      [PATH]: { status: 402, body: { ...CHALLENGE_402, recipient: '0xstranger', recipients: {}, accepts: [] } },
    });
    before.push([
      'payment_refused',
      () =>
        new DescribeClient({
          fetchImpl: stranger.fetch,
          payer: { pay: async () => 'never' },
        }).walletBreakdown(KNOWN),
    ]);

    const down = mockServer({ [PATH]: { status: 503, body: {} } });
    before.push([
      'http_5xx on the FIRST ask',
      () =>
        new DescribeClient({
          fetchImpl: down.fetch,
          payer: { pay: async () => 'never' },
        }).walletBreakdown(KNOWN),
    ]);

    const declined = mockServer({ [PATH]: { status: 402, body: CHALLENGE_402 } });
    before.push([
      'the payer itself declined',
      () =>
        new DescribeClient({
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
