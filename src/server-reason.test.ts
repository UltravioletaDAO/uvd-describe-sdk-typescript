/**
 * `serverReason` — the error body travels IN the exception. EM's contribution.
 *
 * Mirror of the Python twin's `tests/test_server_reason.py` (ported
 * 2026-08-31): same field, same `' — the server says: '` text, so a consumer
 * who moves stacks reads the same fact in the same place. The `recovery` of
 * `DescribeHTTPError` has promised since day one that *"the body names the
 * field"* — and until today the exception threw that body away and carried the
 * bare status. Whoever caught a 422 had to re-request to learn WHICH field.
 *
 * What this file pins, in order of importance:
 *
 * 1. The body's `error` / `code` / `message` arrive in `serverReason` and
 *    appended to the message — through the doors that raise
 *    `DescribeHTTPError` with a response in hand (free route, pre-402 of the
 *    metered route, and post-payment).
 * 2. 🔴 Every URL in the body leaves REDACTED. The body is written by the
 *    SERVER: a 5xx can echo an upstream URL with the API key in its path —
 *    the exact shape the service scrubs on its own side
 *    (`chain/rpc.py::_redact`). It is not ours to assume they always did.
 * 3. A non-JSON (or non-object) body gives `undefined`, never a second
 *    exception on top of the one being raised.
 * 4. The reason truncates to ~300 chars AFTER redacting — the other order
 *    could cut a URL in half and leave the key standing.
 *
 * What this file does NOT touch: `recovery`. That stays the frozen literal
 * `recovery.test.ts` pins against the table — nothing here interpolates into
 * it.
 */

import { describe, expect, it } from 'vitest';

import { CHALLENGE_402 } from './__fixtures__/live';
import { mockServer } from './__fixtures__/server';
import { DescribeClient, type DescribeClientConfig } from './client';
import { DescribeHTTPError } from './errors';

const testClient = (config: DescribeClientConfig = {}) =>
  new DescribeClient({ jitterMs: 0, ...config });

/**
 * A FAKE key with the shape of the real incident: an upstream URL carrying its
 * credential in the path. Not a real key, and deliberately not shaped like a
 * private key (no `0x` + 64 hex). The scheme is `wss://` on purpose — the
 * redaction pattern is RFC 3986's generic scheme prefix, and a test that only
 * ever feeds it `https://` would stay green with the pattern narrowed to the
 * one scheme everybody remembers.
 */
const BODY_WITH_URL = {
  error: 'upstream_failed',
  message: 'gateway wss://rpc.invalid/v2/FAKE-TEST-KEY-NOT-REAL timed out',
};

async function caught(promise: Promise<unknown>): Promise<DescribeHTTPError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DescribeHTTPError);
  return error as DescribeHTTPError;
}

describe('serverReason — what the body said rides in the exception', () => {
  it('a 422 arrives with what the body said (the free door)', async () => {
    const server = mockServer({
      '/wallets/0xzz/chains': {
        status: 422,
        body: { error: 'invalid_address', code: 422, message: 'not hex' },
      },
    });
    const client = testClient({ fetchImpl: server.fetch, failOpen: false });

    const error = await caught(client.wallet('0xzz'));

    expect(error.status).toBe(422);
    expect(error.serverReason).toContain('invalid_address');
    expect(error.serverReason).toContain('not hex');
    // Appended to the message, not only the attribute: the string that lands
    // in a log line without anyone reading the field.
    expect(error.message).toContain('invalid_address');
  });

  it('a non-JSON body gives serverReason undefined — and no dangling suffix', async () => {
    // Tolerant: the absence of a reason must never bury the original error.
    const server = mockServer({
      '/wallets/0xdead/chains': { status: 500, notJson: '<html>gateway error</html>' },
    });
    const client = testClient({ fetchImpl: server.fetch, failOpen: false });

    const error = await caught(client.wallet('0xdead'));

    expect(error.serverReason).toBeUndefined();
    expect(error.message).not.toContain('the server says');
  });

  it('🔴 every URL in the body leaves redacted — the upstream key does not ride the exception', async () => {
    const server = mockServer({ '/wallets/0xdead/chains': { status: 502, body: BODY_WITH_URL } });
    const client = testClient({ fetchImpl: server.fetch, failOpen: false });

    const error = await caught(client.wallet('0xdead'));

    expect(error.serverReason).toBeDefined();
    expect(error.serverReason).not.toContain('FAKE-TEST-KEY');
    expect(error.serverReason).not.toContain('rpc.invalid');
    expect(error.message).not.toContain('FAKE-TEST-KEY');
    expect(error.serverReason).toContain('[url-redacted]');
    // The URL is redacted, not the rest: without this the guard could be
    // satisfied by returning undefined and the whole contribution would be off.
    expect(error.serverReason).toContain('upstream_failed');
  });

  it('the reason truncates AFTER redacting — ~300 chars, and the URL is already gone when the scissors cut', async () => {
    const filler = 'x'.repeat(400);
    const server = mockServer({
      '/wallets/0xdead/chains': {
        status: 500,
        body: { message: `wss://rpc.invalid/v2/FAKE-TEST-KEY-NOT-REAL ${filler}` },
      },
    });
    const client = testClient({ fetchImpl: server.fetch, failOpen: false });

    const error = await caught(client.wallet('0xdead'));

    expect(error.serverReason).toBeDefined();
    expect(error.serverReason!.length).toBeLessThanOrEqual(301); // 300 + the ellipsis
    expect(error.serverReason).not.toContain('FAKE-TEST-KEY');
  });

  it('the most expensive door: an error AFTER paying says what the server said', async () => {
    const PATH = '/reputation/wallet/0xdead';
    const server = mockServer({
      [`${PATH}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${PATH}#2`]: {
        status: 503,
        body: { error: 'snapshot_failed', message: 'matview refresh in progress' },
      },
    });
    const client = testClient({
      fetchImpl: server.fetch,
      payer: { pay: async () => 'SIGNED-ENVELOPE' },
    });

    const error = await caught(client.walletBreakdown('0xdead'));

    expect(error.status).toBe(503);
    expect(error.serverReason).toContain('snapshot_failed');
    // The post-payment mark is not lost to the suffix.
    expect(error.message).toContain('AFTER paying');
  });
});
