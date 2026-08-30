/**
 * The partner rail — how a product of the house reads describe.net for free.
 *
 * ## What this is, in one paragraph
 *
 * describe.net has no accounts and no API keys, on purpose: *"el pago es la
 * autenticación"*. So when Execution Market, MeshRelay and KarmaKadabra
 * deprecated their local reputation maths and became read-dependencies of the
 * index (2026-08-28), the question "does a service of the house pay like a
 * stranger?" could not be answered with a token. It was answered with an
 * ALLOWLIST OF PUBLIC ADDRESSES plus a per-request ERC-8128 signature
 * (`describe-net/describenet/partner.py`). The partner holds a dedicated wallet
 * with no funds whose only job is to sign; describe.net holds a list of
 * addresses. **The service custodies no secret of ours** — a breach there leaks
 * a list of things that were already public — and that property, not
 * convenience, is why this is a signature and not the `X-API-Key` everyone
 * reaches for first.
 *
 * This module is the client half. It is the only file in this package with a
 * RUNTIME import of `uvd-x402-sdk`, which is why it lives behind the
 * `uvd-describe-sdk/partner` subpath: the main entry and the `x402` entry keep
 * their zero-runtime-imports property, and a consumer who never signs installs
 * nothing.
 *
 * ## Upstream-first: the primitive already existed, MEASURED before writing
 *
 * `uvd-x402-sdk` 2.75.0 (installed, checked 2026-08-30) exports the whole
 * ERC-8128 signer from `uvd-x402-sdk/erc8128` — `signRequest`,
 * `signRequestWithSigner`, `signRequestWithWallet`, plus the pure base builder
 * and the verifier. So NOTHING is signed in this repo: this file picks a chain
 * id and a nonce and forwards. Not one byte of RFC 9421 canonicalisation is
 * reimplemented here, and if any of it ever needs to change, it changes THERE.
 *
 * Verified end to end, offline, on 2026-08-30: headers produced by
 * `signRequestWithSigner` at chain 8453 verify under the EXACT policy
 * `partner.py` builds (authority `api.describe.net`, `allowed_chain_ids=[8453]`,
 * `max_validity_sec=300`, `clock_skew_future_sec=30`), recovering the signer's
 * address. `partner.test.ts` is that probe, kept as a test.
 *
 * ## The nonce: minted here, and here is the argument
 *
 * The payment SDK requires a nonce and refuses to invent one — *"a local nonce
 * authenticates against a first-use-wins store and is rejected by an
 * issuer-bound one, which turns a server blip into an auth mystery"*
 * (`erc8128/signer.ts:15-17`). That reasoning is about servers that HAVE a nonce
 * store. describe.net has none: `PartnerGate` builds its `VerifyPolicy` with no
 * `nonce` field at all (`partner.py:216-223`), and the verifier skips every
 * nonce rule when `policy.nonce is None` — no presence check
 * (`verifier.py:458-462`), no consumption (`verifier.py:304`). Read in the
 * installed PyPI `uvd-x402-sdk` 0.70.0 on 2026-08-30.
 *
 * So there is no store to be unknown to, and a locally minted random nonce is
 * strictly better than the alternative the policy would also accept (none at
 * all): it makes each signature unique, so two identical GETs in the same second
 * do not produce byte-identical headers. This is the caller owning the
 * consequence, which is exactly what `onNonceUnavailable` exists to express in
 * the payment SDK — stated here rather than hidden.
 *
 * 🔴 If describe.net ever adds a nonce store, this line becomes wrong and the
 * failure is loud, not silent: every partner request starts answering 402 with
 * `nonce_unknown` and `DescribePartnerRejected` says so. That is the direction
 * this failure should point.
 *
 * ## What is signed, and the consequence of a custom `baseUrl`
 *
 * The signature covers `@method`, `@authority` and `@path` (plus `@query` when
 * there is one), and `@authority` comes from the URL being requested. The gate
 * pins `api.describe.net` and NEVER derives it from a header (`partner.py:73-84`
 * — deriving an authority from client-controlled input is how a verifier was
 * once made to rebuild a base over an attacker's domain). So a client pointed at
 * any other origin — a staging host, a proxy, the raw execute-api host behind
 * CloudFront — signs an authority the gate does not accept and is charged. That
 * is deliberate on both sides, and it fails LOUDLY here as
 * `DescribePartnerRejected` rather than quietly as a bill.
 */

import {
  CONFORMANCE_VECTORS_F3_1,
  signRequest,
  signRequestWithSigner,
} from 'uvd-x402-sdk/erc8128';

import type { PartnerSigner } from '../client';
import { PARTNER_CHAIN_ID, PARTNER_KEY_ENV } from '../config';

/**
 * The signer's typed header object as a plain `Record<string, string>`.
 *
 * Not cosmetic: `Erc8128Headers` declares `'Content-Digest'?: string`, and an
 * interface with an optional member is not assignable to `Record<string,
 * string>` — the dts build says so, loudly (TS2322 at the return, TS2345 at the
 * parameter, which is why the parameter is `object` and not a `Record` of its
 * own). Dropping the undefined entries here is the honest conversion, and it
 * means the client never merges a header whose value is `undefined` into a
 * `fetch` call, which is how a literal `"undefined"` ends up on a wire.
 */
function plainHeaders(headers: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

/** A 128-bit hex nonce. See the module header for why this is minted locally. */
function mintNonce(): string {
  const bytes = new Uint8Array(16);
  // `globalThis.crypto` is standard in Node >= 18 and in every browser, which
  // is the same floor as this package's `engines`. No import, no polyfill.
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** What every factory here accepts. Both fields have defaults that are right. */
export interface PartnerOptions {
  /**
   * The keyid's chain id. Defaults to `PARTNER_CHAIN_ID` (8453, Base), which is
   * what the gate pins. Override only if describe.net's `CHAIN_ID` moves.
   */
  chainId?: number;
}

/**
 * The rail, from a signer you already have. **This is the preferred form.**
 *
 * It takes an OBJECT THAT SIGNS, never a key: a browser wallet, an ethers
 * `Wallet` built somewhere else, an OWS vault, a KMS client, a queue that asks a
 * human. The key material never enters this package, never enters
 * `uvd-x402-sdk`'s signer, and cannot end up in a stack trace it produces.
 *
 * ```ts
 * import { DescribeClient } from 'uvd-describe-sdk';
 * import { partnerFromSigner } from 'uvd-describe-sdk/partner';
 *
 * // `wallet` is yours — this package never learns how it holds its key.
 * const describe = new DescribeClient({
 *   product: 'meshrelay',
 *   partner: partnerFromSigner({
 *     address: await wallet.getAddress(),
 *     signMessage: (base) => wallet.signMessage(base),
 *   }),
 * });
 *
 * // Metered route, no payer, no USDC: the free rail carries it.
 * const detail = await describe.walletBreakdown('0x97cd…0996');
 * ```
 *
 * `signMessage` is an EIP-191 `personal_sign` over the string it is handed and
 * must return `0x` + 130 hex. It is the ONE thing this rail cannot do for you.
 */
export function partnerFromSigner(
  signer: {
    /** The signing wallet's address. Public by design — the allowlist is public. */
    address: string;
    /** EIP-191 personal_sign over the signature base. */
    signMessage(message: string): string | Promise<string>;
  } & PartnerOptions,
): PartnerSigner {
  const { address, signMessage, chainId = PARTNER_CHAIN_ID } = signer;
  return {
    address,
    async sign({ method, url }) {
      return plainHeaders(
        await signRequestWithSigner({
          method,
          url,
          address,
          chainId,
          nonce: mintNonce(),
          signMessage,
        }),
      );
    },
  };
}

/**
 * The rail, from a private key **the environment holds**.
 *
 * ## Why this reads the variable itself instead of taking a string
 *
 * Because a function that takes a key as an argument is a function somebody
 * calls with a literal. Two DAO wallets were drained in minutes by bots
 * scanning public repositories for `0x` + 64 hex (INC-2026-03-30), and "it was
 * only for a test" is how both got there. This signature makes the safe path
 * the only path: the key can come from `process.env` and from nowhere else, so
 * there is no argument to paste one into. If your key lives somewhere better —
 * Secrets Manager, a vault, a hardware signer — fetch it there and use
 * {@link partnerFromSigner}, which never sees a key at all.
 *
 * ```ts
 * // DESCRIBE_PARTNER_PRIVATE_KEY is set in the environment. Never in code.
 * const describe = new DescribeClient({
 *   product: 'karmakadabra',
 *   partner: partnerFromEnv(),
 * });
 * ```
 *
 * Throws immediately — at wiring time, not at the first request — when the
 * variable is unset or malformed. A partner rail that is going to fail should
 * fail before the process claims to be up.
 *
 * ## 🔴 The shape check, and the measurement that put it here
 *
 * The key is trimmed and checked against `^(0x)?[0-9a-fA-F]{64}$` before it
 * reaches the payment SDK, and that is a SECURITY guard, not politeness.
 * Measured 2026-08-30 with `ethers` 6.17.0, the version `uvd-x402-sdk` 2.75.0
 * pulls in:
 *
 *   * `new ethers.Wallet('0x'+64hex)` with a **trailing newline** — the single
 *     most common way an env var gets malformed, e.g. `KEY=$(cat file)` —
 *     throws `invalid BytesLike value (argument="value", value="0xabab…ab\n")`.
 *     **The entire private key is inside the message, verbatim.**
 *   * only a well-formed-but-invalid key reaches the redacted path,
 *     `invalid private key (argument="privateKey", value="[REDACTED]")`.
 *
 * So the redaction everyone assumes is there covers the second case and not the
 * first, and the first is the likely one. Trimming closes the newline path; the
 * shape check guarantees that whatever reaches `ethers` is exactly 64 hex
 * characters and can therefore only fail into the REDACTED branch. The error
 * this function throws names the variable and the length and never the value.
 *
 * ⚠️ Reported upstream, not patched there by this session: `signRequest` in
 * `uvd-x402-sdk/erc8128` hands its `privateKey` straight to `new
 * ethers.Wallet()` (`signer.ts:255-258`) and has the same exposure for anyone
 * calling it directly. The house rule is that the fix goes upstream; this guard
 * protects THIS path in the meantime and is not a reimplementation of anything.
 */
export function partnerFromEnv(
  options: PartnerOptions & {
    /** Which variable holds the key. Defaults to `DESCRIBE_PARTNER_PRIVATE_KEY`. */
    envVar?: string;
    /** Injectable for tests. Defaults to `process.env`. */
    env?: Record<string, string | undefined>;
  } = {},
): PartnerSigner {
  const { chainId = PARTNER_CHAIN_ID, envVar = PARTNER_KEY_ENV } = options;
  const env = options.env ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

  const raw = env?.[envVar];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(
      `partnerFromEnv: ${envVar} is not set. The partner rail signs every ` +
        'request with a dedicated wallet; without its key this client is an ' +
        'anonymous client, and an anonymous client pays. Set the variable, or ' +
        'use partnerFromSigner() with a signer you build yourself.',
    );
  }

  // Trimmed on purpose: a private key has no meaningful surrounding
  // whitespace, and the alternative to trimming is the ethers leak above.
  const key = raw.trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
    // Length and nothing else. Never the value, never a prefix of it, never a
    // "did you mean" that echoes it back.
    throw new Error(
      `partnerFromEnv: ${envVar} is not a 32-byte hex private key ` +
        `(got ${key.length} characters after trimming; expected 64, or 66 with ` +
        'the 0x prefix). The value is deliberately not shown.',
    );
  }

  // The address is derived by the payment SDK from the key, so we do not know
  // it here without building a wallet ourselves — which would mean importing
  // `ethers` into this package. It stays undefined; error messages lose one
  // detail and this package keeps its dependency list empty.
  return {
    async sign({ method, url }) {
      return plainHeaders(
        await signRequest({ method, url, chainId, nonce: mintNonce(), privateKey: key }),
      );
    },
  };
}

/**
 * The synthetic key the payment SDK ships in its ERC-8128 conformance vectors,
 * documented there as a key that never held funds.
 *
 * Exported for one reason: so that a consumer's own tests can exercise the
 * partner rail without anybody typing 64 hex characters into a repository. It
 * is read out of the installed package at call time and is not stored anywhere
 * in this one.
 *
 * 🔴 It is PUBLIC and it is in everybody's `node_modules`. Never fund it, never
 * allowlist it, never use it outside a test.
 */
export function syntheticTestKey(): string {
  const key = CONFORMANCE_VECTORS_F3_1.frozen.private_key;
  if (!key) throw new Error('the installed uvd-x402-sdk ships no synthetic test key');
  return key;
}

export type { PartnerSigner } from '../client';
export { PARTNER_CHAIN_ID, PARTNER_KEY_ENV } from '../config';
