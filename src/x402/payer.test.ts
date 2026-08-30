import { describe, expect, it, vi } from 'vitest';

import type { X402Client } from 'uvd-x402-sdk';

import { CHALLENGE_402 } from '../__fixtures__/live';
import { DescribeClient } from '../client';
import { mockServer } from '../__fixtures__/server';
import { payerFrom, payerFromX402Client } from './index';

/**
 * The payer adapter, proved against a stub of `uvd-x402-sdk`'s `X402Client`.
 *
 * No key, no signature, no network — none of which this SDK is allowed to do
 * anyway. What is under test is the FORWARDING: that the live challenge's
 * fields reach `createPayment` unmangled, and that the returned
 * `paymentHeader` is what ends up on the wire.
 *
 * 🔴 What this does NOT prove, said plainly: that a real settlement succeeds.
 * That costs USDC and no test here spends any. The first live metered call is
 * the test for that half.
 */

/** Enough of `X402Client` to satisfy the adapter, and nothing more. */
function stubX402Client(result: Partial<Awaited<ReturnType<X402Client['createPayment']>>>) {
  const createPayment = vi.fn(async () => ({
    success: true,
    paymentHeader: 'BASE64-PAYLOAD',
    headers: { 'X-PAYMENT': 'BASE64-PAYLOAD' },
    network: 'base',
    ...result,
  }));
  return { client: { createPayment } as unknown as X402Client, createPayment };
}

describe('payerFromX402Client', () => {
  it('forwards the live challenge fields into PaymentInfo untranslated', async () => {
    const { client, createPayment } = stubX402Client({});
    const payer = payerFromX402Client(client);

    const header = await payer.pay(CHALLENGE_402);

    expect(header).toBe('BASE64-PAYLOAD');
    // describe.net serves the standard shape, so this is a forward and not a
    // translation. A translator would be a second place payment knowledge lives.
    expect(createPayment).toHaveBeenCalledWith({
      recipient: '0xe4dc963c56979E0260fc146b87eE24F18220e545',
      recipients: { evm: '0xe4dc963c56979E0260fc146b87eE24F18220e545' },
      amount: '0.01',
      token: 'USDC',
      supportedChains: [8453, 43114, 42161, 10, 137, 42220],
    });
  });

  it('throws rather than returning an empty header', async () => {
    // An empty X-PAYMENT would be replayed, refused, and read as "they
    // rejected our payment" — a failure at the wrong layer with the wrong name.
    const { client } = stubX402Client({ success: false, paymentHeader: '', error: 'no funds' });
    await expect(payerFromX402Client(client).pay(CHALLENGE_402)).rejects.toThrow(/no funds/);
  });

  it('defaults the token to USDC when a challenge omits it', async () => {
    const { client, createPayment } = stubX402Client({});
    const { token: _token, ...noToken } = CHALLENGE_402;

    await payerFromX402Client(client).pay(noToken);

    expect(createPayment.mock.calls[0][0]).toMatchObject({ token: 'USDC' });
  });
});

describe('payerFrom — bring your own wallet', () => {
  it('is enough to pay a metered route end to end', async () => {
    const path = '/reputation/wallet/0x1';
    const server = mockServer({
      [`${path}#1`]: { status: 402, body: CHALLENGE_402 },
      [`${path}#2`]: { body: { wallet: '0x1', final_score: 83.0 } },
    });
    const client = new DescribeClient({
      fetchImpl: server.fetch,
      payer: payerFrom(async (c) => `signed:${c.amount}`),
    });

    const result = await client.walletBreakdown('0x1');

    expect(server.calls[1].headers['X-PAYMENT']).toBe('signed:0.01');
    expect(result!.finalScore).toBe(83.0);
  });

  it('a payer that throws aborts the call — nothing is replayed', async () => {
    const path = '/reputation/wallet/0x1';
    const server = mockServer({ [path]: { status: 402, body: CHALLENGE_402 } });
    const client = new DescribeClient({
      fetchImpl: server.fetch,
      payer: payerFrom(async () => {
        throw new Error('user declined');
      }),
    });

    await expect(client.walletBreakdown('0x1')).rejects.toThrow('user declined');
    expect(server.calls).toHaveLength(1);
  });
});
