/**
 * `recovery` — the sentence that says what to do INSTEAD.
 *
 * Absorbed from Execution Market (`#agents`, 2026-08-30) and their 317 hours of
 * retries against a closed window. What these tests hold down, in order: every
 * kind decided something (including the one that honestly decided nothing), the
 * 429 split, the wiring through real client failures, and — the one that goes
 * red for a security reason rather than a behavioural one — that a recovery is
 * never built out of a string this package did not write.
 */

import { describe, expect, it, vi } from 'vitest';

import { CHALLENGE_402, WALLET_UNRATED } from './__fixtures__/live';
import { mockServer } from './__fixtures__/server';
import { DescribeClient, type DescribeClientConfig } from './client';
import {
  DescribeError,
  DescribeHTTPError,
  DescribeNotFound,
  DescribePaymentRequired,
  DescribeTimeout,
  DescribeUnreachable,
  type DescribeErrorKind,
} from './errors';
import { RECOVERY, recoveryFor, type RecoveryKey } from './recovery';

const KNOWN = '0x97cd97cfe21799bacbf39d0a53469e5f82f30996';
const UNRATED = '0xdead00000000000000000000000000000000beef';

/** Same helper as `client.test.ts`: the jitter is off in this suite. */
const testClient = (config: DescribeClientConfig = {}) =>
  new DescribeClient({ jitterMs: 0, ...config });

/**
 * Every kind, written out — and the two lines below make the list impossible to
 * leave behind. A kind added to the union without an entry here stops
 * compiling; an entry here that is not a kind stops compiling too.
 */
const ALL_KINDS = [
  'timeout',
  'http_5xx',
  'http_4xx',
  'not_found',
  'unreachable',
  'unparseable',
  'partial_index',
  'payment_required',
  'payment_refused',
  'malformed_hash',
  'partner_unsigned',
  'partner_rejected',
] as const satisfies readonly DescribeErrorKind[];

type _ListedKind = (typeof ALL_KINDS)[number];
/**
 * `true` only while the list above covers the union. Add a `kind` to
 * `errors.ts` and forget it here and this line stops compiling — the runtime
 * assertion below would have kept walking a shorter list and stayed green.
 */
const everyKindIsListed: DescribeErrorKind extends _ListedKind ? true : false = true;

describe('the table decides for every kind', () => {
  it('every kind has an entry, and every entry is either advice or an explicit null', () => {
    expect(everyKindIsListed).toBe(true); // the compile-time half, read once
    for (const kind of ALL_KINDS) {
      expect(Object.prototype.hasOwnProperty.call(RECOVERY, kind)).toBe(true);
      const text = RECOVERY[kind];
      if (text !== null) {
        expect(typeof text).toBe('string');
        // The floor is not style: "Try again." would pass a typeof check and is
        // exactly the non-recovery this field exists to not be.
        expect(text.length).toBeGreaterThan(120);
      }
    }
    // 12 kinds + `rate_limited`, which is a status and not a kind.
    expect(Object.keys(RECOVERY)).toHaveLength(ALL_KINDS.length + 1);
    expect(Object.isFrozen(RECOVERY)).toBe(true);
  });

  it('🔴 `timeout` is null ON PURPOSE — the honest empty, not a gap', () => {
    // A recovery that does not work is worse than none. A timeout's only two
    // levers are retrying (which `transient` already announces) and the client
    // timeout, and raising that past the default buys nothing an API Gateway
    // that cuts at 29 s can deliver. See the entry in `recovery.ts`.
    expect(RECOVERY.timeout).toBeNull();
    expect(new DescribeTimeout('GET /health timed out').recovery).toBeNull();
    // And it is the ONLY one: if a second null shows up here, it was a decision
    // somebody has to defend at its entry, not a default.
    const empty = (Object.keys(RECOVERY) as RecoveryKey[]).filter((k) => RECOVERY[k] === null);
    expect(empty).toEqual(['timeout']);
  });

  it('no entry is "retry" in other words — `transient` already says that', () => {
    for (const key of Object.keys(RECOVERY) as RecoveryKey[]) {
      const text = RECOVERY[key];
      if (text === null) continue;
      // A smell test, not a proof: it catches the one regression that would
      // make this field a second copy of `transient`.
      expect(text).not.toMatch(/^\s*(retry|try again|wait and)/i);
    }
  });
});

describe('the 429 split — a kind is not always fine enough', () => {
  it('422 and 429 are both http_4xx and get opposite advice', () => {
    const wrongInput = new DescribeHTTPError(422, 'GET /x -> HTTP 422');
    const tooLoud = new DescribeHTTPError(429, 'GET /x -> HTTP 429');

    expect(wrongInput.kind).toBe('http_4xx');
    expect(tooLoud.kind).toBe('http_4xx');

    // One says "this is your input"; the other says "this is not your request
    // at all". Merging them would produce a paragraph wrong for both.
    expect(wrongInput.recovery).toBe(RECOVERY.http_4xx);
    expect(tooLoud.recovery).toBe(RECOVERY.rate_limited);
    expect(wrongInput.recovery).not.toBe(tooLoud.recovery);

    // The same condition that already decides `transient` one file over.
    expect(tooLoud.transient).toBe(true);
    expect(wrongInput.transient).toBe(false);
  });

  it('recoveryFor() is the same lookup without an instance', () => {
    expect(recoveryFor('http_4xx', 429)).toBe(RECOVERY.rate_limited);
    expect(recoveryFor('http_4xx', 422)).toBe(RECOVERY.http_4xx);
    expect(recoveryFor('http_4xx')).toBe(RECOVERY.http_4xx);
    expect(recoveryFor('payment_refused', 402)).toBe(RECOVERY.payment_refused);
    expect(recoveryFor('timeout')).toBeNull();
  });
});

describe('the advice names another door, and the door exists', () => {
  it('a 402 with no payer points at the free route the challenge itself names', async () => {
    const path = `/reputation/wallet/${KNOWN}`;
    const server = mockServer({ [path]: { status: 402, body: CHALLENGE_402 } });
    const client = testClient({ fetchImpl: server.fetch });

    const err = await client.walletBreakdown(KNOWN).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DescribePaymentRequired);
    expect((err as DescribeError).recovery).toBe(RECOVERY.payment_required);
    // The most useful thing this SDK can say: the cheaper question is free, and
    // the 402 body names its own route for THIS subject.
    expect(RECOVERY.payment_required).toContain('free_preview.endpoint');
    expect(RECOVERY.payment_required).toContain('GET /wallets/{wallet}/chains');
  });

  it('the free route the paid advice names is a route this client really serves', async () => {
    // Verifying the recovery is not fiction: the same path it names answers.
    const server = mockServer({ [`/wallets/${UNRATED}/chains`]: { body: WALLET_UNRATED } });
    const client = testClient({ fetchImpl: server.fetch });

    await client.wallet(UNRATED);

    expect(server.calls[0].path).toBe('/wallets/0xdead00000000000000000000000000000000beef/chains');
    // …which is the template the advice prints, with the wallet filled in.
    expect(RECOVERY.http_5xx).toContain('GET /wallets/{wallet}/chains');
  });

  it('a 404 says it is data, and points at the free resolver for an agent id', () => {
    const err = new DescribeNotFound('GET /reputation/agent/base/42 -> HTTP 404');

    expect(err.recovery).toBe(RECOVERY.not_found);
    expect(err.recovery).toContain('GET /search/{query}');
    // It is absence, so the advice must not read as an outage.
    expect(err.serviceFault).toBe(false);
  });

  it('the announced (never thrown) malformed-hash notice carries advice too', async () => {
    // The one notice that is not a failure of the call: the read succeeded and
    // a field was dropped. It rides `onFailure` as a `DescribeError`, so it
    // goes through the same table — nothing reaches a consumer without one.
    const path = '/reputation/agent/base/42';
    const server = mockServer({
      [path]: {
        body: {
          network: 'base',
          agent_id: '42',
          score: 83.0,
          review_count: 1,
          ratings: [{ client: '0xrater', tx_hash: '0x', feedback_index: 1, value: 100 }],
        },
      },
    });
    const onFailure = vi.fn();
    const client = testClient({ fetchImpl: server.fetch, onFailure });

    const agent = await client.agent('base', 42);

    expect(agent.ratings[0].malformedHashes).toEqual(['tx_hash']);
    expect(onFailure).toHaveBeenCalledOnce();
    const notice = onFailure.mock.calls[0][0];
    expect(notice.kind).toBe('malformed_hash');
    expect(notice.error).toBeInstanceOf(DescribeError);
    expect(notice.error.recovery).toBe(RECOVERY.malformed_hash);
    // It says the useful half out loud: read the MARK, not the null.
    expect(RECOVERY.malformed_hash).toContain('`raw`');
  });

  it('a fail-open null still hands the caller the advice, on the announced error', async () => {
    const server = mockServer({ [`/wallets/${KNOWN}/chains`]: { status: 503, body: {} } });
    const onFailure = vi.fn();
    const client = testClient({ fetchImpl: server.fetch, failOpen: true, onFailure });

    const answer = await client.wallet(KNOWN);

    expect(answer).toBeNull();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0][0].error.recovery).toBe(RECOVERY.http_5xx);
  });
});

// ---------------------------------------------------------------------------
// 🔴 The redaction guard. Execution Market's second warning of 2026-08-30: an
// unclassified error "can carry an RPC URL with its API key inside", and they
// added a test with a fake secret that fails if it leaks. The service side of
// the house has had this guard since `chain/rpc.py::_redact`, which replaces
// the endpoint with `<rpc-url>` in anything about to be logged or raised.
//
// The SDK equivalent is structural: `recovery.ts` is literals only. This test
// is what keeps it that way — interpolate a cause into any recovery and it goes
// red, which is exactly what was injected to check it can.
// ---------------------------------------------------------------------------

/** Synthetic, and shaped like the leak rather than like a key: no `0x` + hex. */
const FAKE_RPC_WITH_KEY = 'https://rpc.example.invalid/v2/NOT-A-REAL-KEY-abcdef123456';

describe('MOUNTS THE BAD STATE: a transport exception never bleeds into `recovery`', () => {
  it('a fetch that throws a credentialed URL leaves the recovery byte-identical', async () => {
    const server = mockServer({
      [`/wallets/${KNOWN}/chains`]: {
        throws: new TypeError(`fetch failed: connect ECONNREFUSED ${FAKE_RPC_WITH_KEY}`),
      },
    });
    const client = testClient({ fetchImpl: server.fetch, failOpen: false });

    const err = (await client.wallet(KNOWN).catch((e: unknown) => e)) as DescribeUnreachable;

    expect(err).toBeInstanceOf(DescribeUnreachable);
    // Identity with the table, not a `.not.toContain()` — a filter can be
    // fooled by an encoding, a literal cannot be anything but itself.
    expect(err.recovery).toBe(RECOVERY.unreachable);
    expect(err.recovery).not.toContain('NOT-A-REAL-KEY');
    expect(err.recovery).not.toContain('rpc.example.invalid');
    // The boundary is deliberate and this line is where it is drawn: the
    // MESSAGE is forensic and quotes the cause on purpose, because a transport
    // failure with the cause stripped is undebuggable. The recovery is advice
    // WE wrote, and it is the string that gets pasted into tickets.
    expect(err.message).toContain('unreachable');
  });

  it('no entry in the table carries a credential, an address or a key-value secret', () => {
    const CREDENTIALED_URL = /\/\/[^/\s]*:[^/\s]*@/;
    const SECRET_ASSIGNMENT = /(api[-_]?key|apikey|token|secret|password)\s*[=:]/i;
    const KEY_MATERIAL = /0x[0-9a-fA-F]{40,}/;

    for (const key of Object.keys(RECOVERY) as RecoveryKey[]) {
      const text = RECOVERY[key];
      if (text === null) continue;
      expect(text).not.toMatch(CREDENTIALED_URL);
      expect(text).not.toMatch(SECRET_ASSIGNMENT);
      expect(text).not.toMatch(KEY_MATERIAL);
    }
    // `KEY=$(cat file)` in `partner_unsigned` is deliberately NOT flagged: it
    // names a shell idiom that eats a newline, and it holds no value. A pattern
    // wide enough to catch it would fire on the advice that prevents the leak.
    expect(RECOVERY.partner_unsigned).toContain('KEY=$(cat file)');
  });

  it('every error class this package throws arrives with its table entry attached', async () => {
    const path = `/reputation/wallet/${KNOWN}`;
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        'unreachable',
        () => {
          const server = mockServer({
            [`/wallets/${KNOWN}/chains`]: { throws: new TypeError('fetch failed') },
          });
          return testClient({ fetchImpl: server.fetch, failOpen: false }).wallet(KNOWN);
        },
      ],
      [
        'unparseable',
        () => {
          const server = mockServer({
            [`/wallets/${KNOWN}/chains`]: { notJson: '<html>502 Bad Gateway</html>' },
          });
          return testClient({ fetchImpl: server.fetch, failOpen: false }).wallet(KNOWN);
        },
      ],
      [
        'http_4xx',
        () => {
          const server = mockServer({
            [`/wallets/${KNOWN}/chains`]: { status: 422, body: { detail: 'not_an_address' } },
          });
          return testClient({ fetchImpl: server.fetch }).wallet(KNOWN);
        },
      ],
      [
        'payment_required',
        () => {
          const server = mockServer({ [path]: { status: 402, body: CHALLENGE_402 } });
          return testClient({ fetchImpl: server.fetch }).walletBreakdown(KNOWN);
        },
      ],
      [
        'payment_refused',
        () => {
          const server = mockServer({
            [path]: { status: 402, body: { ...CHALLENGE_402, recipient: '0xdeadbeef', recipients: {}, accepts: [] } },
          });
          return testClient({
            fetchImpl: server.fetch,
            payer: { pay: async () => 'never' },
          }).walletBreakdown(KNOWN);
        },
      ],
      [
        'timeout',
        () => {
          const server = mockServer({ [`/wallets/${KNOWN}/chains`]: { hang: true } });
          return testClient({ fetchImpl: server.fetch, failOpen: false, timeoutMs: 5 }).wallet(KNOWN);
        },
      ],
    ];

    for (const [kind, run] of cases) {
      const err = (await run().catch((e: unknown) => e)) as DescribeError;
      expect(err).toBeInstanceOf(DescribeError);
      expect(err.kind).toBe(kind);
      expect(err.recovery).toBe(RECOVERY[kind as RecoveryKey]);
    }
  });
});
