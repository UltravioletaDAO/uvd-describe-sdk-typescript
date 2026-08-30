/**
 * The only place this package defines a calibrable value.
 *
 * House rule (decisión de Saul, 2026-08-26, born from a measured case in
 * describe.net: one threshold written with TWO DIFFERENT VALUES across four
 * surfaces, and the one charged was not the one the site promised). Nothing
 * else in this package re-types these numbers — modules import them.
 *
 * What does NOT live here, by the same rule: anything that moves a score or a
 * price. This SDK computes neither, so the list is short: `POLICY_VERSION` and
 * the prices are the server's and travel in its responses. We never type a
 * price. See `errors.ts` for what we do with a 402 challenge instead.
 */

/** Where the index answers. Overridable per client for a staging deploy. */
export const DEFAULT_BASE_URL = 'https://api.describe.net';

/** Where a human reads the same wallet. Never fetched — only linked. */
export const DEFAULT_SITE_URL = 'https://describe.net';

/**
 * 30 s, and the number is not taste — it is the one number of the three live
 * consumers that came with its measurement written down (EM `client.py:19-23`,
 * INC-2026-08-19):
 *
 *   * the provider's Lambda cold start was measured at **15,2 s**, so anything
 *     under it turns a cold index into a fake outage. An 8 s timeout already
 *     broke a real integration once.
 *   * its API Gateway integration ceiling is **29 s**, so waiting past 30 buys
 *     nothing the gateway will ever deliver.
 *   * it is deliberately DISTINCT from the Facilitator's 45 s so two clocks can
 *     never expire in the same second and produce an error nobody can attribute.
 *
 * Measured across the ecosystem on 2026-08-30: EM 30 s, MeshRelay 30 000 ms,
 * KarmaKadabra 25 s. Two of three already sit here.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The treasury this SDK will pay, and NOTHING else.
 *
 * Read live from the 402 challenge of `GET /reputation/wallet/{w}` on
 * 2026-08-30 (`recipient`, and `payTo` on all six `accepts[]` entries — base,
 * avalanche, arbitrum, optimism, polygon, celo — identical on every one).
 *
 * Pinning it is the point: an x402 challenge is fetched over the network and
 * names its own recipient, so a client that pays whatever `payTo` arrives will
 * happily pay an attacker who can answer as the API. A challenge whose `payTo`
 * is not this address is `DO_NOT_PAY` — never a retry, never a warning that a
 * caller can ignore.
 *
 * 🔴 THE FAILURE MODE OF PINNING, written down because it will happen: if
 * describe.net rotates its treasury, every published version of this SDK stops
 * paying until it is republished. That is the SAFE direction of the failure
 * (refusing to pay a stranger beats paying one), and the escape hatch is
 * `expectedPayTo` in the client config — a caller who has verified the new
 * address out of band can move without waiting for us.
 */
export const TREASURY_EVM = '0xe4dc963c56979E0260fc146b87eE24F18220e545';

/**
 * The chain id that goes in the ERC-8128 keyid of a partner signature.
 *
 * 8453 (Base). Not a preference — it is what the gate accepts:
 * `describe-net/describenet/partner.py:90` sets `CHAIN_ID = 8453` and passes it
 * as the ONLY member of `allowed_chain_ids`, with its own comment explaining
 * that `None` (accept any chain) would be "innecesariamente laxo para una
 * allowlist de tres servicios propios". Read 2026-08-30.
 *
 * The payment SDK's own default happens to be 8453 too, and this constant
 * deliberately does not lean on that: this value belongs to describe.net's
 * policy, not to the signer's convenience, and the day one moves the other must
 * not follow by accident. Measured failure mode of getting it wrong: the gate
 * answers `chain_not_allowed` and the route charges — loud, since partner mode
 * throws `DescribePartnerRejected` instead of paying.
 */
export const PARTNER_CHAIN_ID = 8453;

/**
 * The environment variable `partnerFromEnv()` reads the signing key from.
 *
 * A variable name is not a secret; the value it holds is. Naming it here means
 * a consumer can grep for it, a deploy manifest can set it, and nobody has to
 * guess — while `partnerFromEnv()` staying the ONLY reader means the key has
 * exactly one path into this package.
 */
export const PARTNER_KEY_ENV = 'DESCRIBE_PARTNER_PRIVATE_KEY';

/**
 * The package version, for the `User-Agent`.
 *
 * MeshRelay reads its version from `package.json` at runtime because "a
 * User-Agent that lies about the version is worse than none"
 * (`describenet.js:39`). It can afford the `readFileSync`: it is a server, not
 * a bundled library. We cannot — a library that reads its own manifest at
 * runtime either bundles `package.json` into the artifact or breaks in a
 * browser, and this package has to run in a browser.
 *
 * So the constant is typed here and `config.test.ts` asserts it equals
 * `package.json`'s `version`. Same guarantee (the UA cannot lie), paid at test
 * time instead of at runtime. Bumping the version without the constant is a
 * red test, not a silent lie in someone's access log.
 */
export const SDK_VERSION = '0.1.0';

/** `uvd-describe-sdk-ts/0.1.0`, plus `(+<product>)` when the caller names itself. */
export const SDK_NAME = 'uvd-describe-sdk-ts';

/**
 * Build the `User-Agent`.
 *
 * The provider's rate limit is **shared by every consumer with no per-partner
 * bucket**, so identifying ourselves is the only thing that makes our share of
 * it attributable at all. That is why the UA is on by default and `product` is
 * the one field a caller should bother to fill.
 *
 * ⚠️ CORRECTION 2026-08-30, left written rather than swapped: this comment
 * first said "20 rps", copied from `meshrelay/describenet.js:19-20`. The live
 * OpenAPI says **50 requests/second sustained, bursts up to 40**, at the API
 * Gateway edge, and it also says where the truth lives: *"Every response
 * carries the policy as a header, `RateLimit-Policy: 50;w=1;burst=40` … and
 * **that header is the authority**"*. So neither number belongs in this file —
 * read the header. Cached free routes (`/health`, `/pricing`, `/leaderboard`,
 * `/stats/*`) are served by CloudFront and do not consume the budget on a hit.
 * The 20 was probably right when MeshRelay wrote it; a dated figure does not
 * stop being stale, it only stops being a lie.
 *
 * ⚠️ It is attribution, not authentication. describe.net has no accounts and
 * no API keys — "el pago es la autenticación" — so anyone can send any UA.
 * Never treat this string as identity, on either side.
 */
export function userAgent(product?: string): string {
  const base = `${SDK_NAME}/${SDK_VERSION}`;
  const trimmed = (product ?? '').trim();
  return trimmed ? `${base} (+${trimmed})` : base;
}
