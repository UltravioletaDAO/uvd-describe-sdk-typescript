/**
 * The canonical payer — the ONLY file in this package that knows `uvd-x402-sdk`
 * exists.
 *
 * ## Why it lives behind a subpath instead of in the main entry
 *
 * `uvd-x402-sdk` depends on `ethers` plus three `@noble/*` packages (measured
 * 2026-08-30 with `npm view uvd-x402-sdk dependencies`). Measured on the same
 * day, **all three live HTTP consumers of describe.net read only free routes**:
 * EM's client says so in its docstring (*"Free routes only … Paid routes are a
 * separate, deliberate decision and are NOT implemented here"*), MeshRelay
 * fetches `/wallets/{w}/chains`, KarmaKadabra reads free and falls back to the
 * facilitator. Three of three would install a signing stack for code they never
 * call — and Saul's stated goal for this whole line of work is a widget so
 * light that a stranger pastes it into a news page.
 *
 * So: `uvd-x402-sdk` is an OPTIONAL peer dependency, and the split is enforced
 * by the build (`tsup.config.ts` has two entries; `index` never reaches here).
 * This is the same shape the payment SDK itself uses for its thirteen optional
 * peers — the house convention, not a new one.
 *
 * ## What it does NOT do, and this is the absolute part
 *
 * It does not sign. It does not build an EIP-3009 authorization. It does not
 * touch a private key. Every one of those is `uvd-x402-sdk`'s and stays there:
 * if the payment SDK lacks something, the fix goes UPSTREAM and is consumed
 * from here — never patched in this package.
 *
 * ⚠️ **Measured gap, reported not patched (2026-08-30):** npm `uvd-x402-sdk`
 * 2.75.0 has no `isTransientError` export, while PyPI `uvd-x402-sdk` 0.70.0
 * made one public that day. This package therefore classifies transience
 * itself, in `errors.ts`, over describe.net's HTTP surface only. That is a
 * narrower job than the payment SDK's and it is not a reimplementation of it —
 * but the moment npm ships the helper, the classification of PAYMENT failures
 * should come from there. Filed as a report, deliberately not patched here.
 */

// TYPE-ONLY, and that is load-bearing: with `import type` the compiler erases
// this line entirely, so the built `x402/index.js` has **zero** runtime imports
// and the optional peer stays optional even on the paid path. You get the
// checked signature of `uvd-x402-sdk` 2.75.0 without the artifact requiring it
// to be installed — which is what lets a browser bundle this subpath and pass
// in a wallet-backed client instead.
import type { PaymentInfo, X402Client } from 'uvd-x402-sdk';

import type { X402Payer } from '../client';
import type { X402Challenge } from '../errors';

/**
 * Wrap a connected `X402Client` as a payer this SDK can use.
 *
 * The challenge maps onto `PaymentInfo` almost field for field, because
 * describe.net serves the standard shape — verified live against the 402 of
 * `GET /reputation/wallet/{w}` on 2026-08-30: `recipient`, `recipients.evm`,
 * `amount: "0.01"`, `token: "USDC"`, `supportedChains: [8453, 43114, 42161, 10,
 * 137, 42220]`. So this function forwards; it does not translate. A translator
 * would be a second place where payment knowledge lives.
 *
 * The recipient has ALREADY been checked against the pinned treasury by the
 * time this runs (`DescribeClient.assertPayableTo`), and that ordering is the
 * contract: this function must never be the thing that decides who gets paid.
 *
 * ```ts
 * import { DescribeClient } from 'uvd-describe-sdk';
 * import { payerFromX402Client } from 'uvd-describe-sdk/x402';
 * import { X402Client } from 'uvd-x402-sdk';
 *
 * const x402 = new X402Client();
 * await x402.connectWithPrivateKey(process.env.PAYER_PRIVATE_KEY!, 'base');
 *
 * const describe = new DescribeClient({
 *   product: 'my-app',
 *   payer: payerFromX402Client(x402),
 * });
 * ```
 *
 * 🔴 The key comes from the environment. Never a literal, never "just for a
 * test": bots scan public repos for `0x` + 64 hex and drain in minutes (two DAO
 * wallets, INC-2026-03-30).
 *
 * ⚠️ **Verification status, stated plainly:** the mapping below is checked
 * against the live 402 body and against `PaymentInfo` / `PaymentResult` in
 * `uvd-x402-sdk` 2.75.0 (`src/types/index.ts:206,272`), and
 * `x402/payer.test.ts` proves the forwarding with a stub client. It has NOT
 * been run through a real settlement — that costs USDC and was out of scope for
 * the session that wrote it. Treat the first live metered call as the test.
 */
export function payerFromX402Client(client: X402Client): X402Payer {
  return {
    async pay(challenge: X402Challenge): Promise<string> {
      const info: PaymentInfo = {
        recipient: String(challenge.recipient ?? ''),
        recipients: challenge.recipients as PaymentInfo['recipients'],
        amount: String(challenge.amount ?? ''),
        token: typeof challenge.token === 'string' ? challenge.token : 'USDC',
        supportedChains: Array.isArray(challenge.supportedChains)
          ? (challenge.supportedChains as number[])
          : undefined,
      };

      const result = await client.createPayment(info);
      if (!result.success || !result.paymentHeader) {
        throw new Error(`x402 payment was not created: ${result.error ?? 'no header returned'}`);
      }
      return result.paymentHeader;
    },
  };
}

/**
 * The same seam for a wallet this package knows nothing about.
 *
 * Anything that can turn a challenge into an `X-PAYMENT` value is a payer — a
 * browser wallet, a custodial signer, a queue that asks a human. Exported so
 * that "bring your own payment" does not require importing `uvd-x402-sdk` at
 * all, which is the point of the subpath.
 */
export function payerFrom(fn: (challenge: X402Challenge) => Promise<string>): X402Payer {
  return { pay: fn };
}

export type { X402Payer } from '../client';
export type { X402Challenge } from '../errors';
