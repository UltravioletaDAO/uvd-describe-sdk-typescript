/**
 * The partner rail, and above all the ONE failure it exists to prevent.
 *
 * ## What these tests can assert
 *
 * That the headers we emit are the headers describe.net's gate accepts — proved
 * against the REAL verifier under the EXACT policy `partner.py` builds, not
 * against a mock of it. And that a partner client which stops being exempt
 * STOPS, instead of quietly paying.
 *
 * ## 🔴 THE TEST THAT MATTERS
 *
 * `the payer is NEVER reached when the rail is refused`. Every other test here
 * would still pass if the client answered a 402 by shrugging and paying: the
 * signature would still verify, the happy path would still be free, the signer
 * failure would still throw. The only test that can tell "signs and refuses to
 * pay" from "signs and pays anyway" is the one that puts a payer on the client,
 * has the server refuse the signature, and asserts the payer was never called.
 * Injected the bug (deleted the `partner && !partnerFallsBackToPaying` branch in
 * `client.ts`) and it is the test that goes red — see the session notes.
 *
 * ## What they cannot assert
 *
 * That the authority is pinned correctly against the DEPLOYED infrastructure.
 * The gate says the same thing about itself (`test_partner_gate.py`): a wrong
 * authority fails CLOSED — a permanent 402 for the partner — and no offline test
 * on either side can see it, because neither goes through CloudFront. Only a
 * live call as an allowlisted wallet closes that hole.
 *
 * Nothing here touches the network. No key is typed into this repository: the
 * signing key is the synthetic one the payment SDK ships in its conformance
 * vectors, documented there as never having held funds.
 */

import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { verifyRequest, type VerifyPolicy } from 'uvd-x402-sdk/erc8128';

import { CHALLENGE_402 } from '../__fixtures__/live';
import { mockServer } from '../__fixtures__/server';
import { DescribeClient, type DescribeClientConfig, type DescribeFailure } from '../client';
import {
  DescribeError,
  DescribePartnerRejected,
  DescribePartnerUnsigned,
  failedAfterPaying,
} from '../errors';
import { PARTNER_CHAIN_ID, PARTNER_KEY_ENV } from '../config';
import { partnerFromEnv, partnerFromSigner, syntheticTestKey } from './index';

const WALLET = '0x97cd97cfe21799bacbf39d0a53469e5f82f30996';
const METERED = `/reputation/wallet/${WALLET}`;

/**
 * Jitter off, same reason as in `client.test.ts`: the sleep ships ON (400 ms
 * max, KarmaKadabra's number) and buys nothing against a mock that answers
 * instantly. A helper rather than 9 repetitions, so the day the default moves
 * this file has one line to argue with.
 */
const testClient = (config: DescribeClientConfig = {}) =>
  new DescribeClient({ jitterMs: 0, ...config });

/** The synthetic vector key. Public, in everyone's node_modules, never funded. */
const testWallet = new ethers.Wallet(`0x${syntheticTestKey()}`);

/**
 * describe.net's gate policy, transcribed from `partner.py` field for field.
 *
 * AUTHORITY 84, CHAIN_ID 90, MAX_VALIDITY_SEC 95, CLOCK_SKEW_FUTURE_SEC 96, and
 * — the one that is an absence rather than a value — NO nonce policy, because
 * `PartnerGate.check` builds `VerifyPolicy(...)` with four keyword arguments and
 * `nonce` is not among them (`partner.py:216-223`). Transcribing the absence is
 * as load-bearing as transcribing the numbers: with a nonce store configured,
 * every signature this rail mints would come back `nonce_unknown`.
 */
const GATE_POLICY: VerifyPolicy = {
  authority: 'api.describe.net',
  allowedChainIds: [PARTNER_CHAIN_ID],
  maxValiditySec: 300,
  clockSkew: { future: 30 },
};

/** Run the request we just built through the real gate verifier. */
function asGate(path: string, headers: Record<string, string>) {
  return verifyRequest(
    { method: 'GET', url: `https://api.describe.net${path}`, headers },
    GATE_POLICY,
  );
}

/**
 * A describe.net that behaves like the real one: it charges for a metered route
 * UNLESS the request carries a signature its gate accepts.
 *
 * The acceptance test is the SDK's own `verifyRequest` under `GATE_POLICY` plus
 * an allowlist lookup — i.e. the same two steps in the same order as
 * `PartnerGate.check`, including the second one, which is what makes it a gate
 * rather than a signature check.
 */
function gatedServer(allowlist: string[], paidBody: unknown = { wallet: WALLET }) {
  const seen: Array<{ path: string; exempt: boolean; code?: string }> = [];
  const listed = new Set(allowlist.map((a) => a.toLowerCase()));

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    const raw = init?.headers as Record<string, string> | undefined;
    if (raw) for (const [k, v] of Object.entries(raw)) headers[k] = v;

    let exempt = false;
    let code: string | undefined;
    if (headers['Signature'] && headers['Signature-Input']) {
      const result = await verifyRequest(
        { method: 'GET', url: String(input), headers },
        GATE_POLICY,
      );
      // The allowlist lookup. Without this line a valid signature from any
      // wallet would enter free — the exact bug `partner.py:239-245` is
      // commented against.
      if (result.ok) exempt = listed.has(result.wallet.toLowerCase());
      else code = result.code;
    }
    seen.push({ path: url.pathname, exempt, code });

    // A settled envelope opens the route the same way exemption does — the two
    // rails are alternatives on the wire, which is what makes the fall-through
    // possible at all, and therefore worth being deliberate about.
    const paid = Boolean(headers['X-PAYMENT']);
    if (url.pathname.startsWith('/reputation/') && !exempt && !paid) {
      return new Response(JSON.stringify(CHALLENGE_402), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(paidBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, seen };
}

const goodSigner = () =>
  partnerFromSigner({
    address: testWallet.address,
    signMessage: (base) => testWallet.signMessage(base),
  });

// ---------------------------------------------------------------------------
// The wire format: what we emit is what the gate accepts
// ---------------------------------------------------------------------------

describe('the signature the gate accepts', () => {
  it('verifies under the EXACT policy partner.py builds, and recovers our address', async () => {
    const headers = await goodSigner().sign({
      method: 'GET',
      url: `https://api.describe.net${METERED}`,
    });

    expect(headers['Signature']).toMatch(/^eth=:.+:$/);
    expect(headers['Signature-Input']).toContain(`keyid="erc8128:8453:${testWallet.address.toLowerCase()}"`);
    // A GET has no body, so no Content-Digest — and the gate's rule is
    // body-presence, so demanding one here would be a rejection.
    expect(headers['Content-Digest']).toBeUndefined();

    const result = await asGate(METERED, headers);
    expect(result.ok).toBe(true);
    expect(result.ok && result.wallet).toBe(testWallet.address.toLowerCase());
  });

  it('MOUNTS THE BAD STATE: the wrong authority is refused, so the test above is not vacuous', async () => {
    // What a custom `baseUrl` produces. The gate pins api.describe.net and
    // never derives it from the request, so this signature rebuilds over a
    // different base and the recovered wallet does not match the keyid.
    const headers = await goodSigner().sign({
      method: 'GET',
      url: `https://staging.example${METERED}`,
    });

    const result = await asGate(METERED, headers);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('wallet_mismatch');
  });

  it('MOUNTS THE BAD STATE: the wrong chain id in the keyid is refused', async () => {
    const headers = await partnerFromSigner({
      address: testWallet.address,
      chainId: 1,
      signMessage: (base) => testWallet.signMessage(base),
    }).sign({ method: 'GET', url: `https://api.describe.net${METERED}` });

    const result = await asGate(METERED, headers);
    expect(result.ok === false && result.code).toBe('chain_not_allowed');
  });

  it('mints a fresh nonce per request, so two identical GETs are not byte-identical', async () => {
    const signer = goodSigner();
    const url = `https://api.describe.net${METERED}`;
    const a = await signer.sign({ method: 'GET', url });
    const b = await signer.sign({ method: 'GET', url });

    expect(a['Signature-Input']).not.toBe(b['Signature-Input']);
    // And both are still accepted: describe.net configures no nonce store, so
    // a client-minted nonce cannot be "unknown" to it (partner.py:216-223).
    expect((await asGate(METERED, a)).ok).toBe(true);
    expect((await asGate(METERED, b)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The rail, end to end through the client
// ---------------------------------------------------------------------------

describe('an allowlisted partner reads the metered routes for free', () => {
  it('gets a 200 with no payer configured at all', async () => {
    const server = gatedServer([testWallet.address]);
    const client = testClient({ fetchImpl: server.fetch, partner: goodSigner() });

    const result = await client.walletBreakdown(WALLET);

    expect(result.wallet).toBe(WALLET);
    // One request. No 402, no challenge, no replay — the gate exempted us on
    // the first pass, which is the whole product of this rail.
    expect(server.seen).toEqual([{ path: METERED, exempt: true, code: undefined }]);
    // Nothing was paid, and the result says so rather than leaving it implied.
    expect(result.payment).toBeNull();
  });

  it('signs the FREE routes too — there is no route table in this package', async () => {
    // Deliberate: a list of metered routes here would be a second copy of the
    // service's pricing.TIERS, and it would silently start paying the day a
    // free route becomes metered. The server decides; we sign everything.
    const server = gatedServer([testWallet.address], { status: 'ok' });
    const client = testClient({ fetchImpl: server.fetch, partner: goodSigner() });

    await client.health();

    expect(server.seen[0].path).toBe('/health');
    expect(server.seen[0].exempt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE DISCRIMINANT: a rail that stops working must not become a bill
// ---------------------------------------------------------------------------

describe('🔴 a refused rail throws and NEVER falls through to paying', () => {
  it('the payer is NEVER reached when the rail is refused', async () => {
    // A valid signature from a wallet nobody allowlisted — the exact case
    // partner.py:242 exists for, and the one that separates "verifies" from
    // "verifies AND looks up". The server's gate refuses it and charges.
    const server = gatedServer([/* nobody is allowlisted */]);
    const pay = vi.fn(async () => 'SIGNED-ENVELOPE');
    const client = testClient({
      fetchImpl: server.fetch,
      partner: goodSigner(),
      payer: { pay },
      // Even with failOpen explicitly on: a caller preference cannot buy the
      // right to spend money on their behalf.
      failOpen: true,
    });

    const error = await client.walletBreakdown(WALLET).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DescribePartnerRejected);
    expect((error as DescribeError).kind).toBe('partner_rejected');
    // 🔴 THE ASSERTION. Delete the partner branch in `getPaidJson` and this is
    // the line that goes red: the client pays, the test sees the call, and a
    // partner that lost its free rail has silently started spending USDC.
    expect(pay).not.toHaveBeenCalled();
    // One request: the 402. Nothing was replayed, so nothing was in flight.
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0].exempt).toBe(false);
    // No `payment` stamp — nothing was signed, so nothing could have settled.
    expect(failedAfterPaying(error)).toBe(false);
    // The price is handed over unpaid, so a caller can decide with the number
    // in front of them.
    expect((error as DescribePartnerRejected).challenge.amount).toBe('0.01');
    expect((error as DescribePartnerRejected).address).toBe(testWallet.address);
  });

  it('a signature the gate cannot verify is refused the same way', async () => {
    // Not "unlisted" but "invalid": a signer that signs the wrong string. The
    // gate answers with a code instead of a wallet, and the outcome for the
    // caller is identical — because from here both mean "you are not exempt".
    const server = gatedServer([testWallet.address]);
    const pay = vi.fn(async () => 'SIGNED-ENVELOPE');
    const client = testClient({
      fetchImpl: server.fetch,
      payer: { pay },
      partner: partnerFromSigner({
        address: testWallet.address,
        signMessage: () => testWallet.signMessage('not the signature base'),
      }),
    });

    await expect(client.walletBreakdown(WALLET)).rejects.toBeInstanceOf(DescribePartnerRejected);
    expect(pay).not.toHaveBeenCalled();
    expect(server.seen[0].code).toBe('wallet_mismatch');
  });

  it('partnerFallsBackToPaying: true is the explicit opt-in, and it works', async () => {
    // The flag exists so that "pay anyway" is something someone WROTE. Without
    // this test the default above could be an inability rather than a choice.
    const server = gatedServer([]);
    const pay = vi.fn(async () => 'SIGNED-ENVELOPE');
    const client = testClient({
      fetchImpl: server.fetch,
      partner: goodSigner(),
      payer: { pay },
      partnerFallsBackToPaying: true,
    });

    const result = await client.walletBreakdown(WALLET);

    expect(pay).toHaveBeenCalledTimes(1);
    expect(result.wallet).toBe(WALLET);
    // The replay carried the envelope, and it was still signed as a partner:
    // the two rails are not exclusive on the wire.
    expect(server.seen).toHaveLength(2);
  });

  it('with no payer at all it is still the partner error, not the payment one', async () => {
    // Both are true — the rail is off AND there is no payer — and the useful
    // message is the first one: "your free rail stopped working" tells you what
    // changed, "you forgot a payer" tells you about a thing you never wanted.
    const server = gatedServer([]);
    const client = testClient({ fetchImpl: server.fetch, partner: goodSigner() });

    await expect(client.walletBreakdown(WALLET)).rejects.toBeInstanceOf(DescribePartnerRejected);
  });
});

// ---------------------------------------------------------------------------
// A signer that cannot sign is the CALLER's bug — it must never degrade
// ---------------------------------------------------------------------------

describe('a signer that throws', () => {
  const brokenPartner = {
    address: testWallet.address,
    sign: async () => {
      throw new Error('the vault is locked');
    },
  };

  it('throws DescribePartnerUnsigned instead of sending an unsigned request', async () => {
    const server = gatedServer([testWallet.address]);
    const client = testClient({
      fetchImpl: server.fetch,
      partner: brokenPartner,
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    const error = await client.walletBreakdown(WALLET).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DescribePartnerUnsigned);
    expect((error as DescribeError).kind).toBe('partner_unsigned');
    // The signer's own error is preserved and NOT copied into our message: a
    // signer failing on a malformed key can have key material in its exception.
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('the vault is locked');
    // Not one byte left this process. The request was never made.
    expect(server.seen).toHaveLength(0);
  });

  it('🔴 MOUNTS THE BAD STATE: it throws on a FREE route with failOpen ON', async () => {
    // This is where the bug would hide. If `sign()` were called inside
    // `request()`'s try/catch, its throw would come back as DescribeUnreachable
    // — serviceFault: true — which failOpen swallows into `null`. "My partner
    // key is missing" would read as "this wallet has no reputation", and the
    // caller would keep asking, unsigned, until the first metered route
    // silently charged them.
    const server = gatedServer([testWallet.address]);
    const announced: DescribeFailure[] = [];
    const client = testClient({
      fetchImpl: server.fetch,
      partner: brokenPartner,
      failOpen: true,
      onFailure: (f) => announced.push(f),
    });

    await expect(client.wallet(WALLET)).rejects.toBeInstanceOf(DescribePartnerUnsigned);
    // And it is NOT announced through onFailure: that fires if and only if a
    // method hands back `null`, and this one threw.
    expect(announced).toEqual([]);
  });

  it('a client with no partner configured is byte-identical to before', async () => {
    // The rail is opt-in. Nothing about the unconfigured path may move.
    const server = mockServer({ [`/wallets/${WALLET}/chains`]: { body: { wallet: WALLET } } });
    const client = testClient({ fetchImpl: server.fetch });

    await client.wallet(WALLET);

    expect(Object.keys(server.calls[0].headers).sort()).toEqual(['Accept', 'User-Agent']);
  });
});

// ---------------------------------------------------------------------------
// The key never becomes a literal, and never becomes a log line
// ---------------------------------------------------------------------------

describe('partnerFromEnv', () => {
  it('signs from the environment and the gate accepts it', async () => {
    const partner = partnerFromEnv({ env: { [PARTNER_KEY_ENV]: syntheticTestKey() } });
    const headers = await partner.sign({
      method: 'GET',
      url: `https://api.describe.net${METERED}`,
    });

    const result = await asGate(METERED, headers);
    expect(result.ok && result.wallet).toBe(testWallet.address.toLowerCase());
  });

  it('throws at wiring time when the variable is unset, not at the first request', async () => {
    // A partner rail that is going to fail should fail before the process
    // claims to be up. The alternative is discovering it on a metered route.
    expect(() => partnerFromEnv({ env: {} })).toThrow(/is not set/);
    expect(() => partnerFromEnv({ env: { [PARTNER_KEY_ENV]: '   ' } })).toThrow(/is not set/);
  });

  it('🔴 MOUNTS THE BAD STATE: a key with a trailing newline never reaches an error message', async () => {
    // MEASURED 2026-08-30, ethers 6.17.0 (what uvd-x402-sdk 2.75.0 pulls in):
    // `new ethers.Wallet('0x'+64hex+'\n')` throws `invalid BytesLike value
    // (argument="value", value="0xabab…ab\n")` — THE WHOLE KEY, verbatim, in
    // the message. Only a well-formed-but-invalid key reaches the redacted
    // `invalid private key (value="[REDACTED]")` path. A trailing newline is
    // how `KEY=$(cat file)` ends, so the leaky case is the likely one.
    const key = syntheticTestKey();
    const partner = partnerFromEnv({ env: { [PARTNER_KEY_ENV]: `0x${key}\n` } });

    // Trimmed, therefore valid, therefore signing works — no error to leak into.
    const headers = await partner.sign({
      method: 'GET',
      url: `https://api.describe.net${METERED}`,
    });
    expect((await asGate(METERED, headers)).ok).toBe(true);
  });

  it('🔴 MOUNTS THE BAD STATE: a malformed key is refused WITHOUT echoing it', async () => {
    const leaky = `0x${'ab'.repeat(31)}zz`; // wrong shape, cannot be trimmed into one
    let message = '';
    try {
      partnerFromEnv({ env: { [PARTNER_KEY_ENV]: leaky } });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/not a 32-byte hex private key/);
    // The assertion this test is for. Remove the shape check in
    // `partnerFromEnv` and ethers' own message — which contains the value —
    // becomes what a caller logs.
    expect(message).not.toContain(leaky);
    expect(message).not.toContain('ab'.repeat(8));
    // The variable NAME is safe to say and useful; the value never is.
    expect(message).toContain(PARTNER_KEY_ENV);
  });

  it('reads process.env by default, without being handed one', () => {
    // The `env` parameter is for tests. The default path is the one consumers
    // use, and it must not require them to plumb anything.
    const previous = process.env[PARTNER_KEY_ENV];
    process.env[PARTNER_KEY_ENV] = syntheticTestKey();
    try {
      expect(() => partnerFromEnv()).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env[PARTNER_KEY_ENV];
      else process.env[PARTNER_KEY_ENV] = previous;
    }
  });
});
