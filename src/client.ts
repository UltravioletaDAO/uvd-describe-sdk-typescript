/**
 * `DescribeClient` — nine public methods, six of which touch the network.
 *
 * ⚠️ This line read *"six methods, four of which touch the network"* until
 * 0.7.0, and it was already short before then: counted 2026-11-17 there were
 * eight (`forgetAuthorization()` came with 0.6.0) and five touched the network.
 * 0.7.0 adds `byResource()`, free.
 *
 * ## The one thing to read before changing anything here
 *
 * There are THREE different absences in this file and collapsing any two of
 * them is the failure this package exists to prevent:
 *
 *   1. **`globalScore: null` inside a returned object** — "the index looked and
 *      there is no eligible rating". Verified live on 2026-08-30 against
 *      `0xdEaD…BEEF`: HTTP 200, `chains: []`, `global_score: null`. Data.
 *   2. **The method returning `null`** — "we could not ask" (`failOpen`).
 *      describe.net is down, or slow, or answered something unreadable.
 *   3. **A thrown `DescribeError`** — the caller's request was wrong, or a 402
 *      arrived with no payer, or a challenge named the wrong treasury.
 *
 * A fail-open that is silent turns (2) into (1) — "describe is down" becomes
 * "this wallet has no reputation" — which is precisely the confusion R1 exists
 * to forbid, arriving through the back door. That is why `onFailure` is not
 * optional decoration: it is the half of `failOpen` that keeps it honest, and
 * `client.test.ts` asserts a failure is always announced before `null` is
 * returned.
 *
 * ## 🔴 The paid routes never fail open — added 2026-08-30, and it is a money rule
 *
 * `wallet()`, `leaderboard()`, `health()` and `byResource()` are free, so
 * absence (2) costs nothing and a `null` is the kindest answer: without it every consumer writes
 * the same try/catch around a lookup, which is the duplication this package
 * exists to delete.
 *
 * `walletBreakdown()` and `agent()` are NOT free, and there they return no
 * absence value at all — they throw, always, **including with `failOpen: true`
 * set explicitly**. The line is not "how many methods", it is *was there money
 * in flight*.
 *
 * ⚠️ **This is a correction of what shipped, left written because it is the
 * whole reason this rule exists.** Until 2026-08-30 these two returned
 * `| null` and ran their failures through `failOpenCovers()`, which is `true`
 * for every `serviceFault`. Measured against a dead port that same day: a
 * timeout on a metered route returned `null`. The paywall settles **before**
 * running the query (`describe-net/describenet/paywall.py:1031-1047`), so that
 * `null` could be handed back with the USDC already moved — and nothing in it
 * distinguished "I paid and it fell over" from "there was nothing to fetch".
 * That is not degrading gracefully, it is a spent credential with no receipt.
 *
 * A loud failure after paying is recoverable: the caller can retry, log or
 * claim. A silent `null` is not, and no flag the caller sets can buy the right
 * to swallow a receipt — availability is a preference, a settled payment is a
 * fact. What the exception carries instead is `error.payment` (see
 * `errors.ts::PaymentAttempt`) and `failedAfterPaying()` reads it.
 *
 * ⚠️ **"The caller can retry" was true and dangerous until 2026-11-16 (F-A2).**
 * A retry called the method again, the method asked for a fresh 402, and the
 * payer signed a SECOND authorization — after a 503 whose body says, in
 * describe.net's words, *"NO firmes una autorización nueva"*. Now the client
 * holds the authorization it sent, per resource (`#held`, below), and a retry
 * re-sends it; `error.payment.resend` says when not to call again at all.
 *
 * ## 🔴 The partner rail has a THIRD money rule — added 2026-08-30
 *
 * With `partner` configured (see `PartnerSigner` below and
 * `uvd-describe-sdk/partner`), every request is signed and the metered routes
 * are supposed to be free. Two failures are therefore CALLER-fault and neither
 * one degrades:
 *
 *   1. the signature could not be produced → `DescribePartnerUnsigned`, thrown
 *      on every route including the free ones, `failOpen` or not;
 *   2. the signature was produced and the route charged anyway →
 *      `DescribePartnerRejected`, thrown BEFORE the payer is ever called.
 *
 * Both are `serviceFault: false`, so `failOpenCovers()` refuses them. The
 * symmetry with the paid-route rule is exact and deliberate: there, money that
 * already moved may not be swallowed; here, money that is ABOUT to move may not
 * be spent by accident. A partner rail that quietly falls back to paying is
 * indistinguishable from a working one until the invoice arrives.
 *
 * ## What this client deliberately does NOT do
 *
 * **No cache.** MeshRelay has one (a `Map`, 12-minute TTL) and needs it: it
 * recomputes channel scores on a route reachable from the internet, so an
 * uncached lookup would let a stranger burn our share of a rate limit that has
 * no per-partner bucket (the live figure is 50 rps sustained / burst 40, and
 * the `RateLimit-Policy` response header is the authority — see the correction
 * in `config.ts`). EM and KarmaKadabra have none. One of three is not a
 * mandate, and a cache in a library is a policy
 * decision about staleness that belongs to the app: MeshRelay's split of
 * `refreshWallets` (async, network) from `getCached` (sync, NEVER network)
 * exists because ITS threat model needed it, and baking a TTL in here would
 * hand every consumer a staleness they did not choose. Documented in the README
 * with MeshRelay's shape as the recipe.
 *
 * ⚠️ **Ratified 2026-08-30 by the only consumer that has a cache.** MeshRelay
 * reviewed this decision in `#agents` and agreed the cache must not move into
 * the library: *"una librería que decide cuánto tiempo miente por vos es peor
 * que una que no cachea"*. The paragraph above now has two signatures, not one —
 * which is the difference between a preference and a decision.
 *
 * **No retry.** Same reason, plus a measured one: MeshRelay retries a transient
 * failure at most ONCE, "hammering a permanent failure is how EM turned one
 * error into a four-hour storm" (`describenet.js:150-151`). A retry policy
 * inside a library multiplies against whatever the caller already has.
 * `DescribeError.transient` is exported so a caller can build the policy they
 * want on a fact instead of on a string match.
 *
 * ⚠️ On the metered routes that sentence used to end in a second payment: a
 * policy built on `transient` re-called the method and signed again. Since
 * 2026-11-16 the re-call re-sends the held authorization, so the policy is
 * safe — and still no retry happens HERE. What the client does on its own is
 * remember; what it never does is send by itself. Branch on
 * `error.payment.resend`, wait `retryAfterSeconds`, and stop at
 * `validBefore`: past it the next call is a new purchase.
 *
 * ## What it DOES do without being asked, and there is exactly one — added 2026-08-30
 *
 * **It sleeps `[0, 400) ms` before the first request of every call.** That is
 * the one thing in this list that goes the other way, so it carries the burden
 * of proof: the number and the measurement are KarmaKadabra's (27 agents on one
 * EventBridge schedule, against a rate limit shared with no per-partner bucket —
 * *"sin jitter, un enjambre es un DDoS educado"*), and the argument for shipping
 * it ON is in `config.ts::DEFAULT_JITTER_MS`. `jitterMs: 0` turns it off.
 *
 * It is NOT the retry policy above wearing a different hat, and `jitter.ts`
 * spells out why: jitter disperses a herd that has not asked for anything yet,
 * backoff yields to a service that has already said no. The first goes before
 * the first request; the second would go before a retry this package does not
 * have.
 *
 * ## The second thing `onFailure` announces — added 2026-08-30
 *
 * A hash field that arrives as something other than a hash is dropped to `null`
 * and announced as `kind: 'malformed_hash'` (KarmaKadabra's *"el 200 sin tx"*;
 * see `hashes.ts` and `announceMalformed` below). It does not throw — one bad
 * accessory field must not destroy a decomposition that was paid for — and it
 * does not pass through, which is what bit them.
 */

import {
  AUTHORIZATION_EXPIRY_MARGIN_SECONDS,
  DEFAULT_BASE_URL,
  DEFAULT_JITTER_MS,
  DEFAULT_SITE_URL,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRY_AFTER_SECONDS,
  TREASURY_EVM,
  userAgent,
} from './config';
import {
  attachPayment,
  DescribeError,
  DescribeHTTPError,
  DescribeMalformedHash,
  DescribeNotFound,
  DescribePartnerRejected,
  DescribePartnerUnsigned,
  DescribePaymentRefused,
  DescribePaymentRequired,
  DescribeTimeout,
  DescribeUnparseable,
  DescribeUnreachable,
  failOpenCovers,
  type PaymentAttempt,
  resendAfterPaying,
  type X402Challenge,
} from './errors';
import { looksLikeSettlementReceipt, malformedHashReport, SETTLEMENT_PENDING } from './hashes';
import { jitterDelayMs, sleep } from './jitter';
import {
  parseAgentReputation,
  parseByResource,
  parseHealth,
  parseLeaderboard,
  parseWalletBreakdown,
  parseWalletReputation,
} from './parse';
import type {
  AgentReputation,
  ByResourceReputation,
  IndexHealth,
  LeaderboardRow,
  PaymentEvidence,
  WalletBreakdown,
  WalletReputation,
} from './types';

/**
 * How a metered call gets paid.
 *
 * 🔴 This SDK NEVER signs, never touches a private key and never builds an
 * EIP-3009 authorization. That is `uvd-x402-sdk`'s job and reimplementing it
 * here would be the house's cardinal sin (upstream-first: if the payment SDK
 * lacks something, it is added THERE and consumed from here). This interface is
 * the seam, and it is one method wide on purpose — anything wider would start
 * to encode payment knowledge we have no business having.
 *
 * The canonical implementation ships at `uvd-describe-sdk/x402` and wraps the
 * payment SDK's `X402Client`. It lives behind a subpath so this module never
 * imports it: a consumer who only reads free routes installs nothing.
 */
export interface X402Payer {
  /**
   * Given the parsed 402 challenge, return the value for the `X-PAYMENT`
   * header. Throwing aborts the call — nothing is replayed.
   *
   * It must RESOLVE OR THROW. While it is pending, every other call this
   * client makes for the same resource waits for its signature instead of
   * signing its own — each wait lasting at most `timeoutMs`, then a
   * `DescribeTimeout` that sent and paid nothing (since 0.6.0; see
   * `DescribeClient.#acquiring`). That timeout says `serviceFault: true`
   * although the slow party is this payer: do not page on it as "describe.net
   * is down". A payer that waits on a human should carry its own deadline.
   */
  pay(challenge: X402Challenge): Promise<string>;
}

/**
 * How a request proves it comes from a partner of the house.
 *
 * ## The seam, and why it is exactly one method wide
 *
 * Same shape and same reason as {@link X402Payer}: this package holds no key,
 * builds no signature and knows no cryptography. It hands a request over and
 * gets headers back. Anything wider would start encoding signing knowledge that
 * belongs to `uvd-x402-sdk`, and the canonical implementation — which does
 * nothing but call that SDK's ERC-8128 signer — ships at
 * `uvd-describe-sdk/partner`, behind a subpath, so the main entry keeps its zero
 * runtime imports.
 *
 * ## What the other side does with it
 *
 * describe.net has no accounts and no API keys — *"el pago es la
 * autenticación"* — so the free rail for our own products could not be a token.
 * It is an allowlist of PUBLIC ADDRESSES plus a per-request ERC-8128 signature
 * (`describe-net/describenet/partner.py`, read 2026-08-30). The service
 * therefore custodies no secret of ours: a breach of describe.net leaks a list
 * of addresses, which are already public. That property is the reason this is a
 * signature and not the `X-API-Key` everybody expects, and it is worth
 * protecting when extending this interface.
 *
 * The gate verifies with a policy pinned to `api.describe.net`, chain 8453 and a
 * 300 s window, and then — the line that makes it a gate — looks the recovered
 * address up in the allowlist (`partner.py:242`). A valid signature from an
 * unlisted wallet pays like everybody else.
 *
 * ## Throwing is the contract
 *
 * `sign()` MUST throw rather than return partial or unsigned headers. The client
 * turns that throw into `DescribePartnerUnsigned` and raises it — it never
 * proceeds unsigned, because an unsigned request from a partner client is an
 * anonymous request, and an anonymous request pays.
 */
export interface PartnerSigner {
  /**
   * Sign one request; return the headers to add to it.
   *
   * For describe.net's GET-only surface that is `Signature` and
   * `Signature-Input` (RFC 9421). `Content-Digest` appears only for a request
   * with a body, and this client never sends one.
   */
  sign(request: { method: string; url: string }): Promise<Record<string, string>>;
  /**
   * The signing address, if the implementation cares to publish it. Used ONLY
   * to write a useful error message. It is never sent as a header and never
   * trusted: the server decides from the address it RECOVERS, not one we claim.
   */
  readonly address?: string;
}

/** What `onFailure` is handed. Enough to log, alert or fall back on. */
export interface DescribeFailure {
  /** The route that failed, e.g. `/wallets/0x…/chains`. */
  path: string;
  error: DescribeError;
  /** Shorthand for `error.kind`, so a logger never has to reach in. */
  kind: DescribeError['kind'];
  /** Would retrying help? */
  transient: boolean;
}

export interface DescribeClientConfig {
  /** Default `https://api.describe.net`. */
  baseUrl?: string;
  /** Default 30 000 ms. See `config.ts` for why that number and not another. */
  timeoutMs?: number;
  /**
   * Your product's name, appended to the `User-Agent` as `(+name)`.
   *
   * Strongly recommended and free: the rate limit is shared across the
   * ecosystem with no per-partner bucket, and the UA is the only thing that
   * makes your share of it attributable when something gets loud. The ceiling
   * itself is not typed here — the `RateLimit-Policy` response header is the
   * authority (see the correction in `config.ts`).
   */
  product?: string;
  /**
   * Default **true**, and it is what Saul asked for in those words: *"pon un
   * fallback si es que describe está caído"* (2026-08-28).
   *
   * `true` — a describe.net-side failure returns `null` and calls `onFailure`.
   * `false` — the same failure throws a typed `DescribeError`.
   *
   * **Scope: the free routes only** — `wallet()`, `leaderboard()`, `health()`.
   * `walletBreakdown()` and `agent()` ignore this flag in both positions and
   * always throw; see the header of this file for why money removes the choice.
   *
   * Either way a 4xx that is the CALLER's fault still throws: `failOpen`
   * protects you from their outage, not from your own bug.
   */
  failOpen?: boolean;
  /**
   * Where a swallowed fact goes. **`onFailure` announces everything this client
   * swallowed, and nothing it handed you.** Two things qualify:
   *
   *   1. a `null` returned instead of an answer (the fail-open, free routes
   *      only) — announced BEFORE the `null`, always;
   *   2. a hash field dropped because it was not a hash
   *      (`kind: 'malformed_hash'`, metered routes, added 2026-08-30).
   *
   * A failure that reaches you as a throw is never announced here: you are
   * already holding it.
   *
   * ⚠️ **This is a restatement, and the old wording is left because someone will
   * look for it.** It read: *"fires if and only if a method hands back `null`…
   * the paid routes therefore never call this at all"*. That was a description
   * of the only case that existed, not of the rule — and the rule it protected
   * is that nothing disappears quietly. A field that vanished out of a 200 is
   * exactly as invisible as a silent fail-open, so it belongs on the same
   * channel. Filter it in one line if you only page on outages:
   * `if (f.kind === 'malformed_hash') return;` — it is `transient: false` and
   * `serviceFault: false`, and the paid routes still never fail open.
   *
   * Leaving this unset with `failOpen: true` is the one configuration this
   * package will not defend: it converts "describe is down" into "this wallet
   * has no reputation" with nothing written down anywhere. It is allowed
   * because a hard requirement would be a `throw` in the constructor of a
   * read-only client, but the README says it plainly and so does this comment.
   */
  onFailure?: (failure: DescribeFailure) => void;
  /**
   * Sleep a random `[0, jitterMs)` before **every** request, so a fleet waking
   * on one schedule does not arrive as one spike. **Default 400**, and `0` turns
   * it off.
   *
   * ⚠️ *Every* request, the replay of a paid one included: a method that fires
   * two requests sleeps twice. The intuitive rule — once per public call — was
   * written here first and is wrong, because it disperses the first request and
   * lets the rest out in a pack. `jitter()` below carries the correction and the
   * call site in KarmaKadabra's own code that settles it.
   *
   * The number and the reason are KarmaKadabra's, measured on a fleet of 27
   * (2026-08-30) — see `config.ts::DEFAULT_JITTER_MS` for why it ships ON, and
   * `jitter.ts` for why this is not backoff and why it is not a CSPRNG.
   *
   * Set it to `0` in your own unit tests: a suite that sleeps 200 ms per mocked
   * call is paying for a behaviour it is not testing. This package's own suite
   * does exactly that.
   *
   * A value that is not a finite number ≥ 0 falls back to the **default**, not
   * to off: a typo must not silently remove a protection the rest of the
   * ecosystem is relying on. Only a real `0` disables it.
   */
  jitterMs?: number;
  /** Pay metered routes. Without it, a 402 throws `DescribePaymentRequired`. */
  payer?: X402Payer;
  /**
   * Enter through the partner rail: sign every request as a wallet the house
   * has allowlisted, and read the metered routes for free.
   *
   * Build one with `partnerFromEnv()` or `partnerFromSigner()` from
   * `uvd-describe-sdk/partner`. Both are the same rail — one reads a key the
   * environment holds, the other takes a signer you already have.
   *
   * 🔴 EVERY request is signed, free routes included, and that is a decision
   * with a reason: the alternative is a table in this package saying which
   * routes are metered, which would be a second copy of the service's
   * `pricing.TIERS` and would silently start paying the day a free route
   * becomes metered. The server already knows which is which; we do not need
   * to. What it costs, measured on this machine 2026-08-30 (Node v23.11.0, 200
   * signatures with an in-process ethers wallet, after 20 warm-up rounds):
   * **0,67 ms** per signature, against a 30 000 ms request timeout. Four ten-
   * thousandths of the budget for the request it rides on.
   */
  partner?: PartnerSigner;
  /**
   * 🔴 Default **false**, and the default is the point.
   *
   * With partner mode on, a metered route that answers 402 means the free rail
   * did not work. By default that throws `DescribePartnerRejected` and NOTHING
   * IS PAID. Set this to `true` to fall through to the `payer` instead — an
   * explicit decision to spend USDC when the rail is down, which is a
   * reasonable thing to want and an unreasonable thing to get by accident.
   *
   * With no `partner` configured this flag does nothing at all.
   */
  partnerFallsBackToPaying?: boolean;
  /**
   * The only address this client will pay. Defaults to the pinned treasury.
   * Override only if you have verified a rotation out of band — see
   * `config.ts::TREASURY_EVM` for the failure mode of pinning.
   */
  expectedPayTo?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Anything shaped like a URL inside a server-written error body. The scheme
 * prefix (`[a-z][a-z0-9+.-]*://`) is RFC 3986's, not a guess: it catches
 * `https://`, `postgresql://`, `wss://` — every place a credential travels in
 * a path or in userinfo. Used by `serverReason`; see its docstring for why the
 * redaction runs BEFORE the truncation.
 */
const URL_IN_BODY = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * What the server SAID, not just the number it said it with.
 *
 * Ported 2026-08-31 from the Python twin (`client.py::_server_reason`;
 * Execution Market's contribution, verified additive there the same day): the
 * `recovery` of `DescribeHTTPError` has promised since day one that "the body
 * names the field" — and then the exception threw that body away and carried
 * the bare status. Whoever caught a 422 had to re-request to learn which field
 * was wrong. This reads `error` / `code` / `message` from the JSON body —
 * tolerant: a non-JSON or non-object body is `undefined`, never a second
 * exception on top of the one being raised.
 *
 * 🔴 Two guards, in this order, and the order is the point:
 *
 * - **URLs are redacted first** (`URL_IN_BODY` → `[url-redacted]`). The body
 *   is written by the SERVER: a 5xx can echo an upstream URL that carries an
 *   API key in its path — the exact shape the service scrubs on its own side
 *   (`describe-net/describenet/chain/rpc.py::_redact`, because the key lives
 *   in the path). We do not get to assume they always did.
 * - **Truncation to ~300 chars runs AFTER the redaction.** The other order
 *   could cut the string in the middle of a URL and leave the key standing.
 *
 * Nothing here is ever interpolated into `recovery`: that stays the frozen
 * literal `recovery.test.ts` pins against the table.
 */
async function serverReason(response: Response): Promise<string | undefined> {
  return reasonOf(await bodyRecord(response));
}

/**
 * The error body as a JSON object, or `undefined` — tolerant, so a body that is
 * not JSON never becomes a second exception on top of the one being raised.
 * Split out of `serverReason` on 2026-11-16 because the post-payment path reads
 * four more fields of the SAME body (`PaymentAttempt.serverError` and its
 * neighbours), and a `Response` body can be read once.
 */
async function bodyRecord(response: Response): Promise<Record<string, unknown> | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  return body as Record<string, unknown>;
}

/**
 * `serverReason` over a body already read. Same guards, same order — and, on
 * the post-payment path, a third one in the same position: the `X-PAYMENT`
 * this client just sent (`secret`) is cut out BEFORE the truncation too, for
 * the reason the URLs are: a cut taken first could leave half a credential
 * standing. describe.net does not echo the header today; this is the line
 * that makes "today" not matter.
 */
function reasonOf(record: Record<string, unknown> | undefined, secret?: string): string | undefined {
  if (!record) return undefined;
  const parts: string[] = [];
  for (const key of ['error', 'code', 'message'] as const) {
    const value = record[key];
    if (value !== null && value !== undefined) parts.push(`${key}=${String(value)}`);
  }
  if (parts.length === 0) return undefined;
  let reason = withoutHeader(parts.join(' · ').replace(URL_IN_BODY, '[url-redacted]'), secret);
  if (reason.length > 300) reason = `${reason.slice(0, 300)}…`;
  return reason;
}

/**
 * One server-written string field, with `reasonOf`'s guards in its order —
 * URLs and the header out FIRST, then the cut — or `null` when the field is not
 * a non-empty string.
 */
function serverText(value: unknown, max: number, secret?: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const redacted = withoutHeader(value.replace(URL_IN_BODY, '[url-redacted]'), secret);
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

/**
 * `text` with every occurrence of the header replaced, when there is one worth
 * scrubbing — verbatim, and in the two spellings a transport or a server most
 * plausibly re-encodes it in: percent-encoded (a query string, a logged URL)
 * and JSON with escaped slashes (base64 carries `/`). Exact matching is all
 * this is; a header split, truncated or decoded by whoever echoes it is not
 * recognisable, and the guard that covers those is that this package never
 * echoes it itself.
 */
function withoutHeader(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length < SCRUB_MIN_LENGTH) return text;
  let out = text;
  for (const spelling of new Set([secret, encodeURIComponent(secret), secret.split('/').join('\\/')])) {
    out = out.split(spelling).join(HEADER_REDACTED);
  }
  return out;
}

/**
 * A stand-in for a transport error that may quote the header: same `name`,
 * `code`, `message`, `stack` and `cause` chain (five deep), each with the
 * header cut out, and nothing else — no own properties copied, because a
 * request-config-shaped property (`config.headers`) is exactly where an HTTP
 * client keeps it.
 */
function scrubbedCause(error: unknown, secret: string, depth = 0): unknown {
  if (!(error instanceof Error) || depth >= 5) {
    return error instanceof Error ? undefined : withoutHeader(String(error), secret);
  }
  // `String()` on every field: `message` and `name` are writable and need not
  // be strings, and a `split` that throws here would leave the transport's
  // raw error in the caller's hands with no `payment` on it.
  const copy = new Error(withoutHeader(String(error.message), secret), {
    cause: error.cause === undefined ? undefined : scrubbedCause(error.cause, secret, depth + 1),
  });
  copy.name = String(error.name);
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') {
    (copy as Error & { code?: string | number }).code = code;
  }
  copy.stack = typeof error.stack === 'string' ? withoutHeader(error.stack, secret) : undefined;
  return copy;
}

/** RFC 9110 §5.6.7 IMF-fixdate, the HTTP-date form every sender must generate. */
const IMF_FIXDATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * How long the answer asks us to wait, in whole seconds, capped at
 * `MAX_RETRY_AFTER_SECONDS` — or `null` when it names no wait.
 *
 * The `Retry-After` header first (RFC 9110 §10.2.3: delay-seconds, or an
 * HTTP-date), then the body's `retry_after_seconds`, which describe.net's
 * paywall serves next to it on every 503 (`describenet/paywall.py:2258-2271`).
 *
 * 🔴 The HTTP-date branch only accepts the IMF-fixdate SHAPE before it calls
 * `Date.parse`, and that is measured, not tidy: V8's `Date.parse` takes almost
 * anything — `Date.parse('5.5')` is a day in May 2001 (Node 20.20.2,
 * 2026-11-16) — so a header like `5.5` would come out as a date in the past
 * and a wait of 0 instead of "no usable header". The two obsolete HTTP-date
 * forms (RFC 850, asctime) fall through to the body field, and an unreadable
 * header is the same as an absent one.
 */
function retryAfterOf(response: Response, record: Record<string, unknown> | undefined): number | null {
  let seconds: number | null = null;
  const header = response.headers.get('Retry-After')?.trim();
  if (header !== undefined && /^\d+$/.test(header)) {
    seconds = Number(header);
  } else if (header !== undefined && IMF_FIXDATE.test(header)) {
    const at = Date.parse(header);
    if (Number.isFinite(at)) seconds = Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }
  if (seconds === null) {
    const fromBody = record?.retry_after_seconds;
    if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) {
      seconds = Math.ceil(fromBody);
    }
  }
  return seconds === null ? null : Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/**
 * `payload.authorization.validBefore` of a signed `X-PAYMENT`, in Unix
 * seconds, or `null` when this client cannot read one.
 *
 * The header is `base64(JSON)`, and on EVM the EIP-3009 authorization rides at
 * `payload.authorization` in BOTH x402 envelopes (v1 flat, v2 with
 * `x402Version: 2`) — that is how `uvd-x402-sdk` 2.75.0 builds it
 * (`encodeEVMPaymentHeader`, `validBefore = now + 300` on Base and `+ 60`
 * elsewhere), and how describe.net's pay bar reads it back
 * (`describe-net/site/dn-pay.js:721-731`). Read here, not asked of the payment
 * SDK, because the main entry imports NOTHING at runtime (invariant 7), and
 * reading a public timestamp off an envelope somebody else signed is not
 * signing.
 *
 * 🔴 `null` is "I cannot tell", never "expired": a header this client cannot
 * date is held until the SERVER releases it. Treating an unreadable date as a
 * licence to sign again is the double payment, arriving through a parse error.
 */
function readEnvelope(header: string): Pick<PaymentAttempt, 'validBefore' | 'nonce' | 'network'> {
  const none = { validBefore: null, nonce: null, network: null };
  try {
    const envelope = JSON.parse(atob(header.trim())) as {
      network?: unknown;
      payload?: { authorization?: { validBefore?: unknown; nonce?: unknown } };
    };
    const authorization = envelope?.payload?.authorization;
    const raw = authorization?.validBefore;
    const value =
      typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    return {
      // Above 1e11 s (year 5138) it is not seconds: a payer that stamped
      // milliseconds. Reported as unreadable rather than as a date three
      // thousand years out that a caller would wait for.
      validBefore: Number.isFinite(value) && value > 0 && value < 1e11 ? value : null,
      // The EIP-3009 nonce is a bytes32, and it is what the token contract
      // records when the authorization executes (`AuthorizationUsed(authorizer,
      // nonce)`, `authorizationState`): the one value that ties a transfer
      // on-chain to THIS authorization, which a caller with many 0.01 USDC
      // transfers to the treasury cannot do by amount (the refuter's P2-2).
      // Public: without the signature it authorises nothing.
      nonce:
        typeof authorization?.nonce === 'string' && /^0x[0-9a-fA-F]{64}$/.test(authorization.nonce)
          ? authorization.nonce
          : null,
      network:
        typeof envelope?.network === 'string' && /^[\w:.-]{1,64}$/.test(envelope.network)
          ? envelope.network
          : null,
    };
  } catch {
    return none;
  }
}

/** What the challenge asked for, carried with the authorization it paid. */
type PaymentTerms = Pick<PaymentAttempt, 'amount' | 'token' | 'payTo'>;

/**
 * An authorization this client signed and has not seen through, for ONE
 * resource. Lives only in `DescribeClient.#held` — see "the held
 * authorization" there.
 */
interface HeldAuthorization {
  /** The `X-PAYMENT` value. A bearer credential until `validBefore`. */
  readonly header: string;
  readonly validBefore: number | null;
  readonly nonce: string | null;
  readonly network: string | null;
  readonly terms: PaymentTerms;
  /**
   * Calls that took it and have not finished: the send is out, or its answer
   * has not been classified yet. A call waiting on the signature is counted
   * from the moment it is held (`#acquiring`), before it has sent anything —
   * so no answer to another call can find it at zero while one is still on
   * its way.
   *
   * ⚠️ Replaced `inFlight` on 2026-11-16 (c0der's round 1, P1-1). `inFlight`
   * counted SENDS and dropped at the answer, before its body was read; a
   * delivery that came in through that gap saw nobody else and let go of an
   * authorization another call had just failed on.
   */
  readers: number;
  /**
   * Reads it bought that were never handed over: calls that took it and ended
   * in a failure that keeps it (`same-header`, `reconcile`). The next call for
   * this resource claims one (`join`) — it is that read, re-sent, which is
   * describe.net's rule: *"Do not sign a fresh authorization to recover a read
   * you already paid for: re-send the same header to the request you signed it
   * for"* (`describe-net/site/auth.md:385-387`). A delivery lets the
   * authorization go only when nobody is reading it and nothing is owed.
   *
   * Added 2026-11-16 (c0der's round 1, P1-1). Measured before it: two calls
   * share one authorization, A gets `503 settlement_unconfirmed`, B is
   * delivered, B's delivery let go, and A — retrying exactly as its error told
   * it to — signed a new one. A's read had been paid and was never served.
   */
  owed: number;
  /**
   * Reads this client handed over with it (a 2xx whose body parsed). Once
   * above zero the authorization is known to have SETTLED, so a 409 to a later
   * re-send of it is describe.net's receipt window closing, not a payment in
   * doubt — and the error says so (`ALREADY_DELIVERED_409`). Added 2026-11-16
   * at c0der's request when ratifying `owed`.
   */
  delivered: number;
  /**
   * How many times it has been SENT, by any call. Counted per authorization
   * and not per call, because two concurrent calls share one: a first send
   * answered `payment_required` says nothing about the other send of the same
   * header that got a 503 (the refuter's P3 of 2026-11-16).
   *
   * 🔴 Counted when a call COMMITS to sending it — on entering
   * `sendAndRead`, before the jitter and the request — never when its answer
   * arrives (c0der's round 1, P2-1, mutant MR14). Counted at the answer, a
   * first send answered `payment_required` while a second send of the same
   * header is still out reads as "sent once" and lets the authorization go —
   * while the other send may be settling. Counting a little early errs on the
   * side that keeps it held.
   */
  sent: number;
}

/**
 * A signature being bought for one resource, and the calls waiting for it.
 * Lives only in `DescribeClient.#acquiring`.
 */
interface Acquiring {
  /** What the buying call held, or `null` when it held nothing (its payer declined, a failure before paying). */
  readonly settled: Promise<HeldAuthorization | null>;
  /** Calls waiting on it. Counted into `readers` the moment an authorization is held. */
  waiting: number;
  /**
   * The same answer as `settled`, readable synchronously: set in the block
   * that holds the authorization, `undefined` while the buying call is still
   * at it. A waiter whose clock ran out reads it before giving up.
   */
  outcome: HeldAuthorization | null | undefined;
}

/** How one call that sent an authorization ended for it — see `DescribeClient.end`. */
type Ending = 'delivered' | 'refused' | 'owed';

/**
 * One more call takes a held authorization: it claims a read the
 * authorization owes, if there is one, and is counted as a reader either way.
 * Synchronous on purpose — nothing may run between finding it held and
 * counting the call (see `HeldAuthorization.owed`).
 */
function join(authorization: HeldAuthorization): HeldAuthorization {
  if (authorization.owed > 0) authorization.owed -= 1;
  authorization.readers += 1;
  return authorization;
}

/** What replaces the header wherever it would otherwise be quoted. */
const HEADER_REDACTED = '[x-payment-redacted]';

/**
 * Appended to a 409 on an authorization this client already delivered a read
 * with (`HeldAuthorization.delivered`). A literal, like every advice here.
 *
 * Why a message and not a self-healing re-purchase — the other option c0der
 * offered when ratifying `owed` on 2026-11-16: forgetting and buying again on
 * its own is paying a second time as a REFLEX, which `forgetAuthorization()`
 * exists to make a decision. The 409 stays typed (`DescribeHTTPError`, status
 * 409, `payment.resend: 'reconcile'`); this sentence names the way out.
 *
 * ⚠️ Until c0der's round 2 (P3 of its refuter on 6f097af8) the last clause
 * read *"past `validBefore` it answers `forgotten`"*. `forgetAuthorization()`
 * answers that only past `validBefore` + `AUTHORIZATION_EXPIRY_MARGIN_SECONDS`
 * with no other call reading it, and never without `force` when `validBefore`
 * could not be read — a caller who took the old wording at its word got
 * `'may-still-execute'` for 15 s and did not know why.
 */
const ALREADY_DELIVERED_409 =
  ' This client already delivered a read paid with this authorization, so it SETTLED and this ' +
  '409 is describe.net no longer serving that read again (its receipt window is over), not a ' +
  'payment in doubt. To buy the read again, call `forgetAuthorization(error)`: once ' +
  '`validBefore` plus `AUTHORIZATION_EXPIRY_MARGIN_SECONDS` has passed and no other call has it ' +
  'out, it answers `forgotten` (an unreadable `validBefore` needs `{ force: true }`) and the ' +
  'next call signs a new authorization.';

/**
 * Below this length a "header" is not an x402 envelope (a real one is a
 * base64'd JSON of several hundred characters), and scrubbing it out of a
 * message would mangle ordinary words instead of protecting anything.
 */
const SCRUB_MIN_LENGTH = 16;

/**
 * The advice half of every post-payment message, one per `resend`. Literals:
 * nothing from the response is interpolated except the wait, which is a number
 * this client parsed and capped.
 */
function adviceAfterPaying(attempt: PaymentAttempt): string {
  switch (attempt.resend) {
    case 'same-header': {
      const wait =
        attempt.retryAfterSeconds !== null ? ` after ${attempt.retryAfterSeconds} s (Retry-After)` : '';
      if (attempt.status !== undefined && attempt.status >= 200 && attempt.status < 300) {
        return (
          'describe.net answered and the payment went through; only the body could not be read. Do ' +
          'NOT sign a new authorization: calling this method again for the same resource re-sends ' +
          'the SAME one, which describe.net serves again from its receipt, without a second ' +
          'charge, for as long as it keeps that receipt.'
        );
      }
      return (
        'There is no verdict on that payment yet, and it may have settled: do NOT sign a new ' +
        'authorization for it. Calling this method again for the same resource re-sends the SAME ' +
        `one${wait}, which cannot be charged twice — also after it expires, when describe.net ` +
        'answers from what it recorded of it. This client signs a new one only when describe.net ' +
        'says nothing was settled.'
      );
    }
    case 'reconcile':
      // ⚠️ Until c0der's round 2 (P3 of this round's own refuter) the
      // parenthesis read *"(past `error.payment.validBefore`)"* — the same
      // threshold, short of the clock margin, that the round corrected in
      // `ALREADY_DELIVERED_409`; with both on one 409 the message gave two.
      return (
        'That authorization may already have moved money, and re-sending it will not change this ' +
        'answer: read `error.payment.nextAction` and look on-chain for the transfer to `payTo` ' +
        'before paying for this resource again (`error.payment.nonce` on `error.payment.network` ' +
        'is what identifies it). Calling this method again re-sends the same authorization, never ' +
        'a new one. Only once it can no longer execute (past `error.payment.validBefore` plus ' +
        '`AUTHORIZATION_EXPIRY_MARGIN_SECONDS`) AND no transfer of it is on-chain does ' +
        '`forgetAuthorization(error)` let the next call buy the read again.'
      );
    case 'new-challenge-ok':
      return (
        'describe.net says nothing was settled: this client dropped that authorization, and calling ' +
        'this method again asks for a new challenge and signs a new one.'
      );
  }
}

/**
 * Every key `DescribeClientConfig` accepts, as a value the COMPILER keeps in
 * sync: a key added to the interface without a row here is a type error, and a
 * row without a key is an excess-property error. The constructor checks incoming
 * config against this, so "the compiler knows the keys" and "the runtime knows
 * the keys" cannot drift apart — see the rewritten defence at the check itself.
 */
const KNOWN_CONFIG_KEYS: Record<keyof DescribeClientConfig, true> = {
  baseUrl: true,
  timeoutMs: true,
  product: true,
  failOpen: true,
  onFailure: true,
  jitterMs: true,
  payer: true,
  partner: true,
  partnerFallsBackToPaying: true,
  expectedPayTo: true,
  fetchImpl: true,
};

/** Read reputation from describe.net. */
export class DescribeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly ua: string;
  private readonly failOpen: boolean;
  private readonly onFailure?: (failure: DescribeFailure) => void;
  private readonly jitterMs: number;
  private readonly payer?: X402Payer;
  private readonly partner?: PartnerSigner;
  private readonly partnerFallsBackToPaying: boolean;
  private readonly expectedPayTo: string;
  private readonly fetchImpl: typeof fetch;
  /**
   * 🔴 **The held authorization — one per resource, and the ONLY place an
   * `X-PAYMENT` header lives after it is signed.** Added 2026-11-16 (F-A2).
   *
   * Keyed by the request path, which is the resource describe.net charges
   * for (`GET /reputation/wallet/0x…` — same route, same query, same bytes).
   * Set the moment the payer returns, BEFORE the header leaves: an
   * authorization that is in flight is held, so no branch below — present or
   * future — can forget to hold it. Released on exactly two answers — a 2xx
   * whose body was read (the read was delivered), and the whitelist 402 that
   * says nothing was settled (`resendAfterPaying` → `'new-challenge-ok'`) —
   * and by the caller, through `forgetAuthorization(error)`. Every other
   * answer keeps it, so calling the method again re-sends it instead of
   * signing a second one — the move describe.net asks for after a 503 and the
   * one that cannot charge twice.
   *
   * ⚠️ **Never released by the clock, and the first version of this was.** It
   * let go at `validBefore` + 15 s, on the reading "the old one can no longer
   * execute, so a new one cannot charge twice for it". The refuter of
   * 2026-11-16 (P1-2) measured why that is the double payment by another
   * door: `uvd-x402-sdk` 2.75.0 stamps `validBefore = now + 60` on five of its
   * six chains, describe.net replays a SETTLED read from its receipt for 300 to
   * 1800 s, and so 76 s after a `500` that carried `X-Payment-Receipt` the
   * client bought the same read a second time. An expired authorization costs
   * nothing to re-send — it cannot execute — and describe.net's answer to it
   * is the only evidence of what the first send did: the replay (200), the
   * receipt of a settlement (409 `authorization_already_settled`), an
   * authorization that may have been used (409 `authorization_spent`), or —
   * when it never reached the paywall — `PAYMENT_VERIFICATION_FAILED`, which
   * releases it. Signing again on the strength of a clock is what
   * `describe-net/site/paybox.md` step 7 forbids: *"past its `validBefore` …
   * with no transfer on-chain"* — and the second half is a check only the
   * caller can make. That is what `forgetAuthorization()` is for.
   *
   * Why a `#private` field and not `error.payment`, a `private` property or a
   * hidden key on the error: this is a bearer credential until its
   * `validBefore` (after a connect timeout it may never have reached the
   * server), and everything else in reach is serialised by somebody —
   * `error.payment` is enumerable (`JSON.stringify(err)`, every structured
   * logger), and TypeScript's `private` is a compile-time word that
   * `JSON.stringify(client)` ignores. A `#` field is invisible to
   * `JSON.stringify`, `Object.keys` and `util.inspect` (measured on Node
   * 20.20.2, `showHidden: true` included). The Python twin hit the same wall
   * from the other side — `BaseException` pickles `__dict__`, so a header on
   * the exception travels in `pickle.dumps(exc)` (measured,
   * `RA-refutacion.md` F-A1).
   *
   * Two calls for the same resource at the same time share it: the second
   * re-sends the first one's authorization instead of buying the read again,
   * and may meet `503 authorization_in_flight` while the first settles — and
   * that is true from the first instant, not only once the first call is past
   * its payer: a call whose free ask comes back 402 while another is reading
   * the challenge or waiting on its payer waits for THAT signature
   * (`#acquiring`, at most `timeoutMs`) instead of buying its own. A delivery
   * lets it go only when every call that took it was served
   * (`HeldAuthorization.owed`). A new `DescribeClient` holds nothing.
   *
   * ⚠️ Corrected 2026-11-16 (c0der's round 1, P1-1), and the old claim is left
   * because it is what the code did not do: this paragraph read *"Two calls
   * for the same resource at the same time share it"* and stopped there. It
   * held only if the second call started after the first was back from
   * `payer.pay()`. Two calls in the same tick both found nothing held, both
   * signed, and the second `set` overwrote the first; one 503 later the
   * caller retrying as told signed a THIRD authorization — three payments for
   * two reads, measured by the refuter with a spy payer.
   */
  readonly #held = new Map<string, HeldAuthorization>();
  /**
   * The signature being bought for a resource right now, so a second call for
   * it waits for that one instead of having its payer sign its own
   * (single-flight from the 402 on). Set the moment a call's free ask comes
   * back 402 and finds nothing held and nobody buying; cleared once the
   * authorization is held — or as soon as the buying call ends without one,
   * when the waiters look again: nothing was spent.
   *
   * ⚠️ The free ask itself is NOT single-flight, and the first draft of this
   * round put it inside: every outcome that buys nothing — the free answer
   * the partner rail gets, a timeout during an outage — then ran one call at
   * a time (measured by the round's refuter, P2-A). A waiter gives up after
   * `timeoutMs`, having sent nothing (P2-B: a payer that never answered left
   * every later call waiting forever).
   */
  readonly #acquiring = new Map<string, Acquiring>();
  /**
   * Which held authorization each post-payment failure was about, so
   * `forgetAuthorization(error)` can drop THAT one and never a newer one.
   * Weak, so a dropped error frees its entry; private, so no serialisation of
   * the error reaches it.
   */
  readonly #heldFor = new WeakMap<object, { path: string; authorization: HeldAuthorization }>();

  constructor(config: DescribeClientConfig = {}) {
    // ⚠️ REWRITTEN 2026-08-31, and the old defence is left quoted because it
    // was reasonable, measured wrong, and somebody will want it back. It read:
    // *"a library that dies in its constructor over one [option] is worse than
    // one that ignores it"* — and it sat here defending exactly the silence
    // that bit mesh (meshrelay; spec in `meshrelayserv/describenet.js@04f2ecf`):
    // they passed `userAgent` where this client takes `product`, the key was
    // ignored without a sound, and their attribution vanished from the CDN
    // logs with NO symptom on their side — every call kept succeeding, which
    // is why nobody looked. A constructor throw costs one red test at dev
    // time; the silent ignore cost an ecosystem its only attribution on a
    // shared rate limit. The Python twin already dies here (keyword-only
    // arguments, no `**kwargs`) — and the parity is in the THROW, not in the
    // keys accepted: that twin takes both `product` and `user_agent`, this
    // client only `product`. What is mirrored is that a mistyped key never
    // passes in silence, so this is parity, not invention.
    //
    // What SURVIVES of the old rule is the VALUE half: garbage in a KNOWN key
    // still falls back to its default instead of throwing (see `jitterMs`
    // below) — a key you spelled right proves which protection you meant.
    for (const key of Object.keys(config)) {
      if (!(key in KNOWN_CONFIG_KEYS)) {
        const hint =
          key === 'userAgent'
            ? " The User-Agent is built for you; name your product with `product` — it becomes the '(+name)' suffix."
            : '';
        throw new TypeError(
          `Unknown DescribeClient option '${key}'.${hint} ` +
            `Valid options: ${Object.keys(KNOWN_CONFIG_KEYS).join(', ')}.`,
        );
      }
    }
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ua = userAgent(config.product);
    this.failOpen = config.failOpen ?? true;
    this.onFailure = config.onFailure;
    // A garbage VALUE falls back to the DEFAULT, never to off, and never throws
    // here: a mistyped value must not silently drop a protection the rest of
    // the ecosystem relies on. Only a real 0 disables the jitter. (A mistyped
    // KEY is different and throws above — mesh's case.)
    this.jitterMs =
      typeof config.jitterMs === 'number' && Number.isFinite(config.jitterMs) && config.jitterMs >= 0
        ? config.jitterMs
        : DEFAULT_JITTER_MS;
    this.payer = config.payer;
    this.partner = config.partner;
    this.partnerFallsBackToPaying = config.partnerFallsBackToPaying ?? false;
    this.expectedPayTo = config.expectedPayTo ?? TREASURY_EVM;
    const impl = config.fetchImpl ?? globalThis.fetch;
    if (typeof impl !== 'function') {
      throw new TypeError(
        'No fetch available. Node >= 18 has one; otherwise pass `fetchImpl` in the config.',
      );
    }
    this.fetchImpl = impl;
  }

  // -------------------------------------------------------------------------
  // Free — no dependency, no signature, no credential
  // -------------------------------------------------------------------------

  /**
   * `GET /wallets/{wallet}/chains` — **free**. The happy path starts here.
   *
   * Gratis-primero is not politeness, it is the shape of the product: the 402
   * challenge of the metered route says it itself — *"si ahí no hay nada, no
   * hay nada que comprar"*. Ask for free whether there is anything, and only
   * then buy the decomposition.
   *
   * `wallet` goes through VERBATIM. EVM is normalised server-side, but Solana
   * base58 is case-SENSITIVE and lower-casing it here would silently ask about
   * a different wallet.
   *
   * @returns the reputation (whose `globalScore` may be `null` — that is an
   * answer), or `null` when describe.net could not be reached and `failOpen`
   * is on.
   */
  async wallet(address: string): Promise<WalletReputation | null> {
    const path = `/wallets/${encodeURIComponent(address)}/chains`;
    return this.guard(path, async () => parseWalletReputation(await this.getJson(path)));
  }

  /**
   * `GET /leaderboard` — **free**, first page.
   *
   * Takes NO parameters: `?limit=2` answers 422 `leaderboard_takes_no_params`
   * (verified live 2026-08-30). Paging is the metered `/leaderboard/page`.
   *
   * ⚠️ Ordered by `shrunkScore`, not by `finalScore`. Re-sorting client-side by
   * `finalScore` undoes the shrinkage and puts a single 100-point rating above
   * two hundred real ones.
   */
  async leaderboard(): Promise<LeaderboardRow[] | null> {
    const path = '/leaderboard';
    return this.guard(path, async () => parseLeaderboard(await this.getJson(path)));
  }

  /**
   * `GET /health` — **free**, and the authority on this index's totals.
   *
   * Also the live source for `readingPolicy` and `confidenceThresholds`: the
   * server publishes its own calibrable values so that no consumer re-types
   * them. Read them here rather than hardcoding a threshold that will drift.
   */
  async health(): Promise<IndexHealth | null> {
    const path = '/health';
    return this.guard(path, async () => parseHealth(await this.getJson(path)));
  }

  /**
   * `GET /reputation/by-resource` — **free**. Who collects at an x402 resource,
   * asked by the resource's URL, and their reputation — and **not one address
   * in the answer**, which is why a directory or a router that must never hold
   * a payment address (Emporium, by its anti-rail rule) can ask it and store
   * the result. Added 2026-11-17 (0.7.0); describe.net serves it since
   * 2026-10-02 (PA-D2, describe-net #80).
   *
   * Pass one URL or up to describe.net's batch limit (published in its 422 as
   * `max_urls`; not re-typed here). Each goes as its own `url=` parameter,
   * percent-encoded, so a `&` or `#` inside a resource URL cannot cut it short.
   * The URL is a lookup KEY, never a destination: describe.net sends nothing
   * to it.
   *
   * 🔴 `resources[i]` answers `urls[i]`, and the order is the only key — no URL
   * comes back. An answer with a different number of rows than URLs sent is
   * refused as `unparseable` (fail-open: `null`, announced) rather than handed
   * over for someone to zip against the wrong list.
   *
   * ⚠️ The tightest budget of any route: `RateLimit-Policy: 1;w=1;burst=1`,
   * measured 2026-11-17 (the header is the authority, and `GET /health` →
   * `by_resource` publishes the cache TTLs). Batch instead of looping: a loop
   * of single-URL calls meets a 429, which this method returns as an
   * announced `null`, transient.
   *
   * Same fail-open rules as `wallet()`: `null` = could not ask; a 422
   * (`not_a_resource_url`, `too_many_urls`) is the caller's bug and throws. An
   * empty list throws a `TypeError` before any request — it can only be a 422,
   * and on this route a wasted request is a wasted second of everybody's budget.
   *
   * 🔴 **Deduplicate before you follow the links.** Every collector row
   * carries an `agent`, and rows repeat it: describe.net's own listing answers
   * six rows and ONE agent (2026-11-17). `agent()` is a PAID call, and a loop
   * of `agent(row.agent.network, row.agent.agentId)` over the rows pays six
   * times for one read (measured by the refuter of 0.7.0 with a spy payer: six
   * signatures). Key by `network` AND `agentId` — an id alone is not unique
   * across chains (see the `not_found` recovery).
   *
   * Three things this route inherits from the rest of the client and that
   * read differently here:
   *
   *   * `error.recovery` is drawn by `kind`, for every route alike, and the
   *     `http_5xx` / `unparseable` entries point at `GET /wallets/{wallet}/chains`
   *     — a door for someone who holds a wallet, which a caller of this route by
   *     definition does not. Read them as "try another route", nothing more.
   *   * The URLs travel in the query, so they appear in `onFailure`'s `path` and
   *     in error messages, percent-encoded — like the address does for
   *     `wallet()`. describe.net never echoes them back; this client's logs
   *     will. Do not ask about a URL that carries a credential.
   *   * Percent-encoding roughly triples every `/` and `:`, so a batch of long
   *     URLs makes a long request line. Not measured against the edge's limit;
   *     keep batches of long URLs small.
   */
  async byResource(urls: string | readonly string[]): Promise<ByResourceReputation | null> {
    const list = typeof urls === 'string' ? [urls] : [...urls];
    if (list.length === 0) {
      throw new TypeError('byResource() needs at least one URL: describe.net answers 422 to none');
    }
    const path = `/reputation/by-resource?${list.map((url) => `url=${encodeURIComponent(url)}`).join('&')}`;
    return this.guard(path, async () => {
      const answer = parseByResource(await this.getJson(path));
      if (answer.resources.length !== list.length) {
        throw new DescribeUnparseable(
          `GET /reputation/by-resource answered ${answer.resources.length} row(s) for ${list.length} URL(s); ` +
            'the order is the only key (no URL comes back), so no row can be attributed to a URL',
        );
      }
      return answer;
    });
  }

  /**
   * The badge URL. **Builds a string, opens no socket, cannot fail.**
   *
   * `GET /badge/{wallet}.svg` is free and returns `image/svg+xml` (604 bytes,
   * verified 2026-08-30). Drop it in an `<img>` and a page shows a live score
   * with its distinct raters and the date of the data, with no JavaScript and
   * no dependency on this package at all.
   */
  badgeUrl(address: string): string {
    return `${this.baseUrl}/badge/${encodeURIComponent(address)}.svg`;
  }

  /** Where a human reads the same wallet. On surfaces without hover, THIS is the attribution. */
  profileUrl(address: string, siteUrl: string = DEFAULT_SITE_URL): string {
    return `${siteUrl.replace(/\/+$/, '')}/agent.html?wallet=${encodeURIComponent(address)}`;
  }

  /**
   * Let go of the authorization a post-payment failure was about, so that the
   * NEXT call for that resource asks for a new challenge and signs a new one.
   *
   * 🔴 This is how you pay a second time, so it is a decision, never a reflex,
   * and it refuses what this client can check. describe.net's rule
   * (`site/paybox.md`, step 7): do not sign a new authorization until the first
   * one can no longer execute — past its `validBefore` — **and** there is no
   * transfer of it on-chain (look for `error.payment.nonce` on
   * `error.payment.network`: `AuthorizationUsed(authorizer, nonce)` on the token,
   * or `authorizationState`). The second half is yours. The first half is
   * checked here:
   *
   *   * `'in-flight'` — a call that took that authorization has not finished:
   *     its send is unanswered, its answer is still being read, or it is
   *     waiting to send it. Never overridable: wait for the answer.
   *   * `'may-still-execute'` — `validBefore` + `AUTHORIZATION_EXPIRY_MARGIN_SECONDS`
   *     has not passed, or `validBefore` could not be read. Pass
   *     `{ force: true }` only when you KNOW it did not and will not execute
   *     (it is past `validBefore` by a clock you trust, say).
   *   * `'not-held'` — nothing is held for that failure any more: a later
   *     answer released it, a newer authorization replaced it, or the error
   *     did not come from this client. Pass the error this client threw, or one
   *     that wraps it in `cause` (five levels are followed); a
   *     `structuredClone` of it is a different object and is not recognised.
   *   * `'forgotten'` — done; the next call signs a new one.
   *
   * ⚠️ If the check finds the transfer — the read was paid and lost, past
   * describe.net's receipt window — forgetting buys a SECOND read, knowingly.
   * And it drops the authorization for every call that shared it: a read it
   * still owes another failed call is bought again too.
   *
   * Added 2026-11-16 (F-A2). A first version answered a bare `true` at any
   * time, and the 503 message pointed at it: the refuter's round 2 had it sign
   * again while the first authorization was 300 s from expiring and while a
   * re-send of it was still in flight. RA's design for the Python twin clears
   * the same state with `close()` on the whole client (`RA-refutacion.md`
   * F-A1).
   */
  forgetAuthorization(
    error: unknown,
    options: { force?: boolean } = {},
  ): 'forgotten' | 'not-held' | 'in-flight' | 'may-still-execute' {
    let entry: { path: string; authorization: HeldAuthorization } | undefined;
    let current: unknown = error;
    for (let depth = 0; depth < 6 && entry === undefined; depth++) {
      if (typeof current !== 'object' || current === null) break;
      entry = this.#heldFor.get(current);
      current = (current as { cause?: unknown }).cause;
    }
    if (!entry || this.#held.get(entry.path) !== entry.authorization) return 'not-held';
    const { authorization } = entry;
    if (authorization.readers > 0) return 'in-flight';
    const executable =
      authorization.validBefore === null ||
      Date.now() < (authorization.validBefore + AUTHORIZATION_EXPIRY_MARGIN_SECONDS) * 1000;
    if (executable && options.force !== true) return 'may-still-execute';
    this.#held.delete(entry.path);
    return 'forgotten';
  }

  // -------------------------------------------------------------------------
  // Metered — a 402 is paid through uvd-x402-sdk, never by us
  // -------------------------------------------------------------------------

  /**
   * `GET /reputation/wallet/{wallet}` — **metered, $0.01** ($0.05 with a
   * citable snapshot). Who rated, how many times, how concentrated.
   *
   * The price above is documentation with a date on it, not a value this SDK
   * uses: what gets paid is what the live challenge says. We never type a
   * price into a code path.
   *
   * 🔴 **Not nullable, and never fail-open** — not even with `failOpen: true`.
   * There is money in flight here, and a swallowed failure is a spent
   * credential with no receipt. Every failure arrives as a typed throw, and one
   * that happened after the envelope left carries `error.payment`
   * (`failedAfterPaying()`). Note this includes a 404: it is still absence and
   * still costs nothing (it is checked before the challenge is read), but with
   * no `| null` left there is nowhere to degrade it to.
   *
   * Without a `payer`, throws `DescribePaymentRequired` with the challenge
   * attached — asking is free and is the intended first move, so you can read
   * the price without paying.
   */
  async walletBreakdown(address: string): Promise<WalletBreakdown> {
    const path = `/reputation/wallet/${encodeURIComponent(address)}`;
    const { result, servedReceipt } = await this.getPaidJson(path, parseWalletBreakdown);
    this.announceMalformed(path, result, servedReceipt);
    return result;
  }

  /**
   * `GET /reputation/agent/{network}/{agentId}` — **metered, $0.02**. One
   * ERC-8004 identity, down to the individual ratings.
   *
   * 🔴 Same money rule as `walletBreakdown()`: not nullable, never fail-open,
   * throws on everything including a 404 for an agent id that does not exist.
   */
  async agent(network: string, agentId: string | number): Promise<AgentReputation> {
    const path = `/reputation/agent/${encodeURIComponent(network)}/${encodeURIComponent(String(agentId))}`;
    const { result, servedReceipt } = await this.getPaidJson(path, parseAgentReputation);
    this.announceMalformed(path, result, servedReceipt);
    return result;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The fail-open gate — **for the free routes, and only for them**.
   *
   * ⚠️ Corrected 2026-08-30. The old comment here read *"every network method
   * goes through exactly one of these so the rule cannot drift between
   * methods"*, and the intent was right while the scope was wrong: routing the
   * paid methods through it is what let a post-settlement timeout come back as
   * `null`. The rule that must not drift is R5, and R5 has a term this function
   * cannot see. So the paid methods do not call it — deliberately, and a test
   * named `MOUNTS THE BAD STATE` goes red if anyone puts them back.
   *
   * Whoever adds the sixth method: free ⇒ wrap it here; metered ⇒ do not.
   */
  private async guard<T>(path: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      // A 404 is DATA — "there is nothing here" — so it never leaves as an
      // exception, `failOpen` or not (R4). It is still announced: a mistyped
      // `baseUrl` 404s every route, and a silent null forever would read as
      // "nobody in this index has any reputation".
      if (error instanceof DescribeNotFound) {
        this.onFailure?.({ path, error, kind: error.kind, transient: false });
        return null;
      }
      if (this.failOpen && failOpenCovers(error)) {
        // Announced BEFORE the null. If this ever moves below the return, a
        // failure becomes indistinguishable from an unrated wallet.
        this.onFailure?.({
          path,
          error,
          kind: error.kind,
          transient: error.transient,
        });
        return null;
      }
      throw error;
    }
  }

  /**
   * The pause that disperses a fleet. **Before EVERY request** — called from the
   * top of `request()` and from nowhere else, so a method that makes two
   * requests sleeps twice.
   *
   * ⚠️ **Corrected 2026-08-30, and the wrong version is left written because it
   * is the intuitive one and someone will want it back.** This first sat in
   * `getJson()` / `getPaidJson()`, i.e. *once per public call, before the FIRST
   * request*, on the theory that the metered flow should not sleep twice. That
   * is a hole: a call that fires N requests would disperse one of them and let
   * the other N−1 out in a pack, which is the exact problem this contribution
   * came to fix. KarmaKadabra's own call site settles it — their sleep lives
   * inside the function that performs the GET (`reputation_scan.py:123`), and
   * that function runs twice on their real path (`:242` for the EVM address,
   * `:245` for the Solana one). Their jitter is per REQUEST, and the reason they
   * wrote beside it (`:121-122`) is per-PROCESS: agents that wake together
   * against a shared ceiling.
   *
   * The paid replay sleeps too, and that was the hardest half of the correction
   * to accept. The argument for exempting it was that delaying a signed envelope
   * widens the window in which a crash loses a receipt — but the challenge this
   * client answers carries `maxTimeoutSeconds: 120`, so 400 ms is a third of a
   * percent of the envelope's own validity, while the herd argument applies to
   * the replay in full: 27 agents that get their 402 in the same second replay
   * in the same second.
   *
   * **Before the signature, and before the clock.** `request()` calls this
   * first, so an ERC-8128 signature is never left ageing against its 300 s
   * window while we sleep, and the sleep is not charged to `timeoutMs`.
   */
  private async jitter(): Promise<void> {
    const ms = jitterDelayMs(this.jitterMs);
    if (ms > 0) await sleep(ms);
  }

  /**
   * Announce a malformed hash field, if there is one — KarmaKadabra's *"el 200
   * sin tx"*, reaching the caller.
   *
   * ⚠️ **This is the second thing `onFailure` announces, and invariant 4 is
   * restated rather than broken.** It used to read *"`onFailure` fires if and
   * only if a method hands back `null`"*, and that wording was a description of
   * the only case that existed on 2026-08-30 at noon. The rule it was protecting
   * is bigger and now reads: **`onFailure` announces everything that was
   * silently swallowed — a `null` handed back instead of an answer, and a field
   * dropped because it was not what it claimed to be — and nothing that reaches
   * you as a throw.** A failure you are holding does not need announcing; a
   * field that vanished out of a 200 does, and it is exactly as invisible as a
   * silent fail-open.
   *
   * That is why it is not a second callback: the channel a consumer is already
   * watching is where KarmaKadabra asked for this to land, and a new one would
   * be a channel nobody wired. The notice is filterable in one line
   * (`f.kind === 'malformed_hash'`), carries `transient: false` and
   * `serviceFault: false`, and the error it carries is never thrown.
   *
   * 🔴 The callback is wrapped, and this call site is the reason: it fires after
   * a metered read that already SETTLED. An observer that throws would destroy a
   * response the caller paid for, which is the same class of bug as swallowing a
   * receipt — with the sign flipped. (The `guard()` call site is deliberately
   * left unwrapped: there the answer is already `null`, so a throwing observer
   * costs nothing that was bought.)
   */
  private announceMalformed(
    path: string,
    result: Parameters<typeof malformedHashReport>[0],
    servedReceipt: string | null,
  ): void {
    const fields = malformedHashReport(result);
    if (fields.length === 0) return;
    // The receipt is the ONE malformed value `raw` cannot preserve — `raw` is
    // the body and that arrived as a header — so it is quoted here or it is
    // lost. Truncated because a field that is not a hash can be anything: the
    // longest `tag1` in this index is 471 characters of prose.
    const quoted =
      fields.includes('payment.receipt') && servedReceipt !== null
        ? ` The receipt as served was ${JSON.stringify(servedReceipt.slice(0, 120))}.`
        : '';
    const error = new DescribeMalformedHash(
      `GET ${path} served ${fields.length} field(s) that are not hashes: ${fields.join(', ')}. ` +
        'Each one was dropped to null; every other value as served is still in `raw`. ' +
        `Nothing was retried and nothing else in the answer was touched.${quoted}`,
      fields,
    );
    try {
      this.onFailure?.({ path, error, kind: error.kind, transient: false });
    } catch {
      // An observer that throws must not destroy a response that was paid for.
    }
  }

  /**
   * The partner headers for one request, or `{}` when there is no partner.
   *
   * 🔴 THIS RUNS OUTSIDE `request()`'s try/catch AND THAT IS THE WHOLE POINT.
   * Inside it, a signer that threw would be caught by the transport handler and
   * re-thrown as `DescribeUnreachable` — which is `serviceFault: true`, which
   * `failOpen` swallows, which turns "my partner key is missing" into a `null`
   * that reads as "this wallet has no reputation". The most expensive bug in
   * this file, one indentation level away.
   */
  private async partnerHeaders(path: string): Promise<Record<string, string>> {
    if (!this.partner) return {};
    try {
      return await this.partner.sign({ method: 'GET', url: `${this.baseUrl}${path}` });
    } catch (error) {
      throw new DescribePartnerUnsigned(path, this.partner.address, error);
    }
  }

  private async request(path: string, headers: Record<string, string> = {}): Promise<Response> {
    // Every request, not every call: see `jitter()` for the correction and for
    // the KarmaKadabra call site that settles it. It runs before the signature
    // (which would otherwise age against its 300 s window) and before the timer
    // (so the sleep is not charged to `timeoutMs`).
    await this.jitter();

    // Signed BEFORE the timer starts and before the try: see `partnerHeaders`.
    const signed = await this.partnerHeaders(path);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const payment = headers['X-PAYMENT'];
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET', // never HEAD: every route but /openapi.json answers 405 to it
        headers: { Accept: 'application/json', 'User-Agent': this.ua, ...signed, ...headers },
        signal: controller.signal,
        // 🔴 A paid request does not follow redirects. The Fetch standard
        // strips `Authorization` on a cross-origin redirect and NOTHING else,
        // so a 30x on the paid send would hand the `X-PAYMENT` — a bearer
        // credential until its `validBefore` — to whatever host the Location
        // names. describe.net never redirects a metered route; one that does is
        // an ANSWER after paying, classified like any other (`reconcile`: a 3xx
        // from Node, or the status-0 `opaqueredirect` a browser hands back),
        // with the authorization held. `'manual'` and not `'error'`, measured
        // by the refuter's round 2 on 2026-11-16: with `'error'` undici rejects
        // with `TypeError: fetch failed`, which read as a dead socket — "no
        // verdict, re-send" — forever, against a redirect that never answers
        // anything else; and `'manual'` is the value every runtime accepts.
        redirect: payment !== undefined ? 'manual' : 'follow',
      });
    } catch (error) {
      // An AbortError here is ours (the timer), not the caller's: this
      // controller is created in this function and handed to nobody.
      const name = (error as { name?: string } | null)?.name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new DescribeTimeout(
          `GET ${path} timed out after ${this.timeoutMs} ms`,
          payment !== undefined ? scrubbedCause(error, payment) : error,
        );
      }
      // 🔴 `String(error)` is the transport's own text, and a `fetchImpl` that
      // quotes its request in its exception would put the `X-PAYMENT` in it —
      // a credential, in the string everybody logs. Cut out HERE, where the
      // message is built, and not later: V8 formats `error.stack` lazily from
      // whatever `message` holds when the stack is first read, so a message
      // that never held the header gives a stack that never can (measured
      // 2026-11-16: scrubbing `stack` after the fact was a mutant nothing could
      // kill).
      // ⚠️ And on a paid send the transport's error does NOT ride as `cause`:
      // `util.inspect(err)`, `console.error(err)` and every error tracker that
      // follows `cause` print it whole (the refuter's P1-1 of 2026-11-16 — the
      // first version of this line left it "as it came", and `inspect(err)`
      // carried the header). It rides as a scrubbed copy: name, code, message,
      // stack and its own `cause` chain, with the header cut out of each.
      throw new DescribeUnreachable(
        `GET ${path} unreachable: ${withoutHeader(String(error), payment)}`,
        payment !== undefined ? scrubbedCause(error, payment) : error,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async readJson(response: Response, path: string): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw new DescribeUnparseable(`GET ${path} body is not JSON`, error);
    }
  }

  /** A free route: any non-2xx is a typed HTTP error. */
  private async getJson(path: string): Promise<unknown> {
    const response = await this.request(path);
    if (response.status === 404) {
      throw new DescribeNotFound(`GET ${path} -> HTTP 404`);
    }
    if (!response.ok) {
      throw new DescribeHTTPError(response.status, `GET ${path} -> HTTP ${response.status}`, {
        serverReason: await serverReason(response),
      });
    }
    return this.readJson(response, path);
  }

  /**
   * A metered route: ask free, read the challenge, verify WHO we are about to
   * pay, pay through the injected payer, replay the identical request.
   *
   * The order matters and the third step is the one people skip. The published
   * guide says it in the imperative — *"verify who you are about to pay — do
   * this every time"* — because the challenge arrives over the same network
   * that could be lying to you, and it names its own recipient.
   *
   * There is one line in this function that changes what a failure MEANS, and
   * it is marked: everything above `payer.pay()` returning is a failure that
   * cost nothing, everything below it may have cost real USDC. Failures below
   * it are stamped with a `PaymentAttempt` so the caller does not have to infer
   * which side of that line they landed on. Nothing above it is stamped, and
   * that asymmetry IS the signal — see `errors.ts::PaymentAttempt`.
   *
   * And one step comes before all of that since 2026-11-16 (F-A2): if this
   * client already holds an authorization for this resource — it left on an
   * earlier call and that call did not see it through — it is re-sent as is,
   * with no free ask, no challenge and no payer before it. See `#held`.
   *
   * And since c0der's round 1 of the same day (P1-1), if this call's free ask
   * comes back 402 while another call is buying one for this resource —
   * reading the challenge, waiting on the payer — this call waits for that
   * signature (at most `timeoutMs`) instead of buying its own. See
   * `#acquiring`.
   */
  private async getPaidJson<T>(
    path: string,
    parse: (body: unknown, payment: PaymentEvidence | null) => T,
  ): Promise<{ result: T; servedReceipt: string | null }> {
    const held = this.#held.get(path);
    if (held) {
      // An authorization for THIS resource already left and was not seen
      // through. Re-send it — no new 402, no payer, no signature: the
      // treasury was checked when it was signed, and asking again would only
      // lead to the second authorization this branch exists to prevent.
      return this.sendPaid(path, join(held), parse);
    }

    // The free ask is NEVER single-flight: it costs nothing, and making
    // concurrent calls wait on it serialised every answer that buys nothing.
    // Measured by the round's own refuter on the first draft, which put the
    // single-flight here: five partner-rail reads that the route answers free
    // ran ONE at a time (127, 228, 330, 432, 534 ms against ~134 ms each), and
    // four reads during an outage failed at 1x, 2x, 3x and 4x `timeoutMs`.
    const first = await this.request(path);

    if (first.ok) {
      // Free-tier or already-settled. No charge, so no evidence to report.
      return { result: parse(await this.readJson(first, path), null), servedReceipt: null };
    }

    if (first.status === 404) {
      // Absence, and free: nothing was paid to learn it. The metered route is
      // the one where a 404 is most likely (an agent id that does not exist),
      // and charging for it would be charging for "there is nothing here".
      throw new DescribeNotFound(`GET ${path} -> HTTP 404`);
    }

    if (first.status !== 402) {
      throw new DescribeHTTPError(first.status, `GET ${path} -> HTTP ${first.status}`, {
        serverReason: await serverReason(first),
      });
    }

    // A 402: this read costs money. Another call may have bought — or be
    // buying — this resource while this one asked. Everything from here to
    // `buy` setting `#acquiring` is synchronous, so two calls cannot both find
    // nobody buying.
    for (;;) {
      const bought = this.#held.get(path);
      if (bought) return this.sendPaid(path, join(bought), parse);
      const acquiring = this.#acquiring.get(path);
      if (!acquiring) break;
      // Its signature is this call's too: asking the payer here is how two
      // calls in the same tick signed twice and the second overwrote the
      // first in `#held` (c0der's round 1, P1-1 — measured with `Promise.all`
      // and with a payer slow enough to approve by hand).
      const theirs = await this.waitFor(path, acquiring);
      // Counted among its readers when it was held: nothing to join.
      if (theirs) return this.sendPaid(path, theirs, parse);
      // It held nothing — its payer declined, or it failed before paying.
      // Look again: another waiter may be buying now; if not, this call buys,
      // with the 402 it already has. Nothing was spent.
    }
    return this.buy(path, first, parse);
  }

  /**
   * Wait for the signature another call is buying for this resource — at most
   * `timeoutMs`, and then give up having sent nothing.
   *
   * Bounded since the round's refuter measured the first draft, which waited
   * with no limit: a payer that never answers (an approval nobody gives, a
   * remote signer with no timeout of its own) left every later call for that
   * resource waiting forever — *"b: still waiting after 1 s | c: still
   * waiting after 0.5 s"* — with no error to hand to `forgetAuthorization()`
   * and no way out but a new client. Giving up takes this call OUT of
   * `waiting` before it throws, so the authorization held later does not
   * count a reader that will never finish (that would hold it, and answer
   * `'in-flight'`, forever).
   *
   * The bound is per WAIT, not per call: a waiter that wakes with `null` (its
   * buyer's payer declined) and finds another buyer waits again, so k
   * declines in a row add up to k × `timeoutMs`.
   *
   * ⚠️ The give-up is a `DescribeTimeout`, which says `serviceFault: true`,
   * and here the slow party is the caller's OWN payer, not describe.net. The
   * paid routes never fail open, so nothing is swallowed — but a consumer
   * that pages on `serviceFault` will page "describe.net is down" for its own
   * slow approval. Its message names the payer. (A kind of its own would be a
   * taxonomy change; not made here.)
   */
  private async waitFor(path: string, acquiring: Acquiring): Promise<HeldAuthorization | null> {
    acquiring.waiting += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gaveUp = new Promise<'gave-up'>((resolve) => {
      timer = setTimeout(() => resolve('gave-up'), this.timeoutMs);
    });
    let outcome: HeldAuthorization | null | 'gave-up';
    try {
      outcome = await Promise.race([acquiring.settled, gaveUp]);
    } finally {
      clearTimeout(timer);
    }
    if (outcome !== 'gave-up') return outcome;
    // If the authorization was held between the clock firing and this line,
    // this call was counted among its readers and must send it. That only
    // happens under SYNCHRONOUS timer batching — fake timers that fire both
    // callbacks with no microtask checkpoint in between, like vitest's
    // `advanceTimersByTime` in a consumer's suite. Node and browsers drain
    // microtasks between timers, so there the waiter gives up before the hold
    // and is never counted (measured by the round's refuter, vuelta 2: with
    // `advanceTimersByTimeAsync` and with real timers, the next read is a new
    // purchase and the books close). Cheap, and it keeps the count right in
    // both worlds.
    if (acquiring.outcome !== undefined) return acquiring.outcome;
    acquiring.waiting -= 1;
    // The last sentence since c0der's round 2 (P3 of its refuter on 6f097af8,
    // probe X2: `timeout`, `timeout`, `timeout`, `pay` = 1, and
    // `forgetAuthorization` → `'not-held'`): a `pay()` that never settles
    // leaves this resource unreadable on this client, and nothing here can
    // let go of a purchase still inside the caller's payer — so the message
    // says where the way out is instead of letting "call again" read as one.
    throw new DescribeTimeout(
      `GET ${path}: another call has been buying the authorization for this resource for ` +
        `${this.timeoutMs} ms and its payer has not answered. This call sent nothing and paid ` +
        'nothing; calling again waits for that signature again, or sends it once it is held. ' +
        'Until that payer resolves or throws, every call for this resource on this client that ' +
        'gets a 402 ends like this one, and `forgetAuthorization()` has nothing to drop: no ' +
        'authorization is held yet.',
    );
  }

  /**
   * Read the challenge, check who is paid, have the payer sign, HOLD what it
   * signed — counting the calls waiting on it as its readers — and send it.
   * Single-flight per resource from its first line (`#acquiring`). Nothing in
   * here spends anything before the marked line.
   */
  private async buy<T>(
    path: string,
    first: Response,
    parse: (body: unknown, payment: PaymentEvidence | null) => T,
  ): Promise<{ result: T; servedReceipt: string | null }> {
    let settle: (authorization: HeldAuthorization | null) => void = () => undefined;
    const acquiring: Acquiring = {
      settled: new Promise<HeldAuthorization | null>((resolve) => {
        settle = resolve;
      }),
      waiting: 0,
      outcome: undefined,
    };
    // In the same synchronous turn as the check that found nothing held and
    // nobody buying (`getPaidJson`): no await between them.
    this.#acquiring.set(path, acquiring);
    let authorization: HeldAuthorization | null = null;
    try {
      authorization = await this.signAndHold(path, first, acquiring);
    } finally {
      // Every way out lands here, so a waiter is never left hanging. The hold
      // (and `outcome`) happened inside `signAndHold`, at least one microtask
      // ago: a call that arrived in between found the authorization in
      // `#held`, which the 402 loop checks first, and joined it there. On a
      // failure before paying the waiters wake with `null` and look again —
      // the first of them buys with its own 402.
      if (this.#acquiring.get(path) === acquiring) this.#acquiring.delete(path);
      acquiring.outcome = authorization;
      settle(authorization);
    }
    return this.sendPaid(path, authorization, parse);
  }

  private async signAndHold(path: string, first: Response, acquiring: Acquiring): Promise<HeldAuthorization> {
    const challenge = await this.readChallenge(first, path);

    // ── THE PARTNER RAIL FAILED, AND FAILING LOUDLY IS THE FEATURE ──────────
    // We signed this request (every request is signed in partner mode) and the
    // route charged anyway, so the gate did not exempt us. Falling through to
    // `payer.pay()` from here is the silent downgrade this whole rail exists to
    // prevent: identical answers, identical latency, USDC leaving a wallet that
    // budgeted none. Checked BEFORE the missing-payer branch because "your free
    // rail is down" is the more useful of the two messages when both are true.
    if (this.partner && !this.partnerFallsBackToPaying) {
      throw new DescribePartnerRejected(path, this.partner.address, challenge);
    }

    if (!this.payer) {
      throw new DescribePaymentRequired(
        `GET ${path} is metered (${challenge.amount ?? '?'} ${challenge.token ?? 'USDC'}) ` +
          'and no `payer` is configured. Read `error.challenge` for the terms, or use the ' +
          'free route: GET /wallets/{wallet}/chains.',
        challenge,
      );
    }

    this.assertPayableTo(challenge);

    // Nothing above this line has spent anything: the payer may still refuse,
    // and a signature that never leaves the payer moves no money — the seller
    // is what settles it. A throw from `pay()` is the caller's own payer
    // talking, so it is not annotated and not translated.
    const signed = await this.payer.pay(challenge);
    // A payer that hands back nothing usable is the caller's bug, and it is
    // caught HERE, before anything is held or sent: a header held per resource
    // that cannot be sent — empty, not a string, or carrying a CR/LF or a
    // non-ASCII character that `fetch` refuses to put on the wire — would be
    // re-sent forever as "it may have settled" although it never left. An x402
    // envelope is base64: visible ASCII. Trimmed first, because `fetch` would
    // trim it anyway, so the trimmed value IS what goes on the wire. The value
    // is never quoted — it came from a signer.
    const header = typeof signed === 'string' ? signed.trim() : '';
    if (!/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(header)) {
      throw new TypeError(
        `payer.pay() returned ${typeof signed === 'string' ? 'a string that is not a header value' : `a ${typeof signed}`} ` +
          `for GET ${path}, not an X-PAYMENT value. Nothing was sent.`,
      );
    }

    // ─────────── BELOW THIS LINE A SIGNED ENVELOPE IS IN FLIGHT ───────────
    // Held before it leaves, so every way out of `sendPaid` — the ones written
    // today and the ones nobody has written yet — finds it there.
    const authorization: HeldAuthorization = {
      header,
      ...readEnvelope(header),
      terms: {
        amount: typeof challenge.amount === 'string' ? challenge.amount : undefined,
        token: typeof challenge.token === 'string' ? challenge.token : undefined,
        payTo: typeof challenge.recipient === 'string' ? challenge.recipient : undefined,
      },
      sent: 0,
      // This call, and every call that waited for this signature: each of
      // them sends it, and none of them may find it let go before it has.
      readers: 1 + acquiring.waiting,
      owed: 0,
      delivered: 0,
    };
    this.#held.set(path, authorization);
    // In the SAME synchronous block that counted the waiters into `readers`:
    // a waiter whose clock runs out after this line, but before `buy` wakes
    // it, reads this and sends the authorization instead of giving up — it
    // was counted, and a reader that never finishes would hold it forever.
    acquiring.outcome = authorization;
    return authorization;
  }

  /**
   * Send one held authorization and classify the answer.
   *
   * Whether it is a RE-send is read off the authorization's own counter when
   * the answer arrives — the one input that changes a verdict (a 402
   * `payment_required` on a re-send does not release it; see
   * `resendAfterPaying`).
   *
   * ⚠️ **The message this throws was rewritten on 2026-11-16 (F-A2) and the old
   * one is quoted because it is the bug:** *"Read `error.payment` before
   * retrying: the same receipt unlocks only this byte-identical resource."* No
   * receipt unlocks anything — `X-Payment-Receipt` is a settlement hash, and
   * what describe.net recognises is the `X-PAYMENT` header, which the caller
   * never held — and "before retrying", next to `transient: true`, read as
   * "retry", which signed a second authorization. Every message now says what
   * this client will do with the authorization, from `resend`.
   *
   * The caller has already counted this call among the authorization's
   * `readers` (`join`, or the hold for the buying call and its waiters). What
   * the call's ending does to the authorization is applied ONCE, in the
   * `finally`, whatever way out it took — and it is `'owed'` unless the body
   * proves otherwise, which keeps the authorization held: the side that
   * cannot pay twice.
   */
  private async sendPaid<T>(
    path: string,
    authorization: HeldAuthorization,
    parse: (body: unknown, payment: PaymentEvidence | null) => T,
  ): Promise<{ result: T; servedReceipt: string | null }> {
    const ending: { is: Ending } = { is: 'owed' };
    try {
      return await this.sendAndRead(path, authorization, parse, ending);
    } finally {
      this.end(path, authorization, ending.is);
    }
  }

  /**
   * One call is done with an authorization — and its ending is what decides
   * whether the authorization is let go:
   *
   *   * `'refused'` — the whitelist 402: describe.net says nothing was settled.
   *     Let go at once, whoever else holds it (their sends are refused alike).
   *   * `'delivered'` — the read reached this caller. Let go only when NOBODY
   *     is reading it and it owes NO read: one authorization pays one read,
   *     but a read it bought for a call that failed is still owed to that
   *     call, and the way to recover it is to re-send it, never to buy it
   *     again (`HeldAuthorization.owed`).
   *   * `'owed'` — every other ending: this call's read was paid and not
   *     handed over. Held, and the next call claims it.
   *
   * Only ever deletes the authorization it was given — never a newer one that
   * replaced it — and never puts back one that is gone.
   */
  private end(path: string, authorization: HeldAuthorization, ending: Ending): void {
    authorization.readers -= 1;
    if (ending === 'delivered') authorization.delivered += 1;
    if (ending === 'owed') {
      authorization.owed += 1;
      return;
    }
    if (ending === 'delivered' && (authorization.readers > 0 || authorization.owed > 0)) return;
    if (this.#held.get(path) === authorization) this.#held.delete(path);
  }

  private async sendAndRead<T>(
    path: string,
    authorization: HeldAuthorization,
    parse: (body: unknown, payment: PaymentEvidence | null) => T,
    ending: { is: Ending },
  ): Promise<{ result: T; servedReceipt: string | null }> {
    const { header, terms, validBefore, nonce, network } = authorization;
    // Counted here, when this call commits to sending it, before the jitter
    // and the request — see `HeldAuthorization.sent`.
    authorization.sent += 1;
    const resent = () => authorization.sent > 1;
    const unanswered = {
      serverError: null,
      retryable: null,
      retryAfterSeconds: null,
      nextAction: null,
      validBefore,
      nonce,
      network,
    };

    let second: Response;
    try {
      second = await this.request(path, { 'X-PAYMENT': header });
    } catch (error) {
      // No answer at all — timeout or dead socket. `fetch` rejects identically
      // whether the request bytes were written or not, so this is exactly the
      // case that CANNOT be narrowed: `unknown`, said out loud. And the one
      // where the header may never have reached anyone, which is why it stays
      // in `#held` and nowhere else (it is already there: held before sent).
      throw this.failedAfterSending(error, path, authorization, {
        settlement: 'unknown',
        receipt: null,
        settlementPending: false,
        reused: null,
        ...terms,
        resend: resendAfterPaying(undefined, null, resent()),
        ...unanswered,
      });
    }

    const receipt = second.headers.get('X-Payment-Receipt');
    const reused = second.headers.get('X-Payment-Reused');
    const receiptPending = receipt === SETTLEMENT_PENDING;
    const evidence: Omit<PaymentAttempt, keyof typeof unanswered | 'resend'> = {
      // A receipt is the settlement transaction hash, put there by the seller:
      // proof, not inference. Its absence proves nothing — an unhandled 500 is
      // rendered above the paywall middleware and never gets the header.
      //
      // ⚠️ Since 2026-08-30 the header must also LOOK like a settlement id (a
      // hash, or the `pending` the OpenAPI declares) before it may be called
      // proof. `'settled'` means *the seller stated settlement*: we hold the
      // hash, or the seller answered the literal `pending` and
      // `settlementPending` says so. A string that is neither is neither, and
      // `'unknown'` is the honest verdict: ask the chain.
      //
      // ⚠️ Since 2026-08-31 the `pending` sentinel never rides in `receipt` —
      // Execution Market's INC-2026-08-26: a placeholder stored in the column
      // meant for the hash gets archived as proof. Here `receipt` is null and
      // the flag carries the state. Garbage, by contrast, IS kept verbatim on
      // this failure path: there it is forensic evidence, not a typed field.
      settlement: receipt !== null && looksLikeSettlementReceipt(receipt) ? 'settled' : 'unknown',
      receipt: receiptPending ? null : receipt,
      settlementPending: receiptPending,
      reused: reused === null ? null : reused.toLowerCase() === 'true',
      status: second.status,
      ...terms,
    };

    if (!second.ok) {
      // 🔴 Money may already be gone here: the authorization was signed and the
      // paywall settles BEFORE running the query. The status is preserved so a
      // caller can tell "they refused the payment" (4xx) from "we paid and
      // their query blew up" (5xx) — different conversations to have with them.
      // ONE read of the body, for the reason and for the four fields describe.net
      // writes next to it on every post-payment refusal (`error`, `retryable`,
      // `retry_after_seconds`, `next_action`; `describenet/paywall.py`
      // `_unavailable`, `_conflict`, `_rejected`).
      const record = await bodyRecord(second);
      const rawError = typeof record?.error === 'string' ? record.error : null;
      const attempt: PaymentAttempt = {
        ...evidence,
        resend: resendAfterPaying(second.status, rawError, resent()),
        serverError: serverText(rawError, 120, header),
        retryable: typeof record?.retryable === 'boolean' ? record.retryable : null,
        retryAfterSeconds: retryAfterOf(second, record),
        nextAction: serverText(record?.next_action, 600, header),
        validBefore,
        nonce,
        network,
      };
      // Every other answer leaves it held — it is already there, set before
      // the send — and owes this call its read (`end`). There is deliberately
      // no "hold again" anywhere: one that is gone — refused, or forgotten by
      // the caller — is never put back (the refuter's P2-2).
      // ⚠️ Until c0der's round 1 (P1-1) this comment also read *"a concurrent
      // call that was DELIVERED released it"*. That release was the bug: a
      // delivery to one call let go of the read another call had paid for.
      if (attempt.resend === 'new-challenge-ok') ending.is = 'refused';
      const failure = attachPayment(
        new DescribeHTTPError(
          second.status,
          `GET ${path} -> HTTP ${second.status}` +
            `${attempt.serverError ? ` ${attempt.serverError}` : ''} AFTER paying ` +
            `(settlement: ${attempt.settlement}${receipt ? `, receipt ${receipt}` : ''}). ` +
            adviceAfterPaying(attempt) +
            // A held authorization is re-sent to every later call for its
            // resource (`owed`), and past describe.net's receipt window that
            // re-send answers 409. When this client already DELIVERED a read
            // with it, that 409 is known and harmless, and it must not reach
            // the integrator as one more "may have moved money" (c0der,
            // ratifying `owed`, 2026-11-16).
            (second.status === 409 && authorization.delivered > 0 ? ALREADY_DELIVERED_409 : ''),
          // The most expensive door gets the reason too: a 4xx/5xx AFTER money
          // moved is exactly where "what did they SAY" matters most.
          { serverReason: reasonOf(record, header) },
        ),
        attempt,
      );
      this.#heldFor.set(failure as object, { path, authorization });
      throw failure;
    }

    // The receipt is a hash too, and it is the one hash the caller is most
    // likely to carry somewhere — to an explorer, to a support ticket, to a
    // reconciliation. So it gets the same shape check as every other hash field
    // (KarmaKadabra, 2026-08-30), with its own predicate: `pending` is a value
    // the seller's OpenAPI declares legitimate, and calling it garbage would
    // fire an alarm on the happy path of every freshly settled payment.
    //
    // 🔴 Only the SUCCESS path nulls a malformed receipt. On the failure path
    // (`attempt`, above) the served string is kept verbatim, because there it is
    // forensic evidence rather than a typed field — what changes there is that
    // `settlement` may not claim `'settled'` on the strength of a string that is
    // not a hash. `'settled'` means *we hold the hash — or the seller declared
    // it `pending`*, and we hold neither.
    //
    // ⚠️ Legitimate is not the same as a hash, and since 2026-08-31 the two no
    // longer share a field: a `pending` header is NOT garbage (no mark, no
    // alarm) and it is NOT a receipt either, so `receipt` goes `null` and
    // `settlementPending` carries the state. Execution Market's INC-2026-08-26
    // is the measurement: a placeholder that rides in the column meant for the
    // hash ends up archived as proof, and every consumer that wants the state
    // has to string-compare against a sentinel. The flag is the state; the
    // field is the hash; neither ever stands in for the other.
    const receiptOk = receipt !== null && looksLikeSettlementReceipt(receipt);
    const payment: PaymentEvidence = {
      receipt: receiptOk && !receiptPending ? receipt : null,
      settlementPending: receiptPending,
      reused: (reused ?? '').toLowerCase() === 'true',
      malformedHashes: receipt !== null && !receiptOk ? ['receipt'] : [],
    };

    let result: T;
    try {
      result = parse(await this.readJson(second, path), payment);
    } catch (error) {
      // The worst of the set and the easiest to forget: a 200 whose body is
      // garbage. It settled — the receipt is right there — and the caller got
      // nothing for it. Swallowing THIS was the old behaviour. Held: the same
      // header reads it again from describe.net's receipt, a new one buys it.
      //
      // ⚠️ The PARSE is inside this `try` since 2026-11-16, and that closed a
      // hole the "body is not JSON" case hid: a 200 whose JSON lacks its
      // essential shape (`parse.ts` throws `DescribeUnparseable`) used to be
      // parsed by the public method, AFTER this function returned — so it left
      // with no `error.payment`, `failedAfterPaying()` said "nothing was
      // transmitted", the README said "retry freely", and the retry signed a
      // second authorization for a read that had already settled.
      throw this.failedAfterSending(error, path, authorization, {
        ...evidence,
        resend: resendAfterPaying(second.status, null, resent()),
        ...unanswered,
      });
    }

    // Delivered. One authorization pays one read: once nobody else is
    // reading it and it owes nobody a read, the next call is a new purchase
    // (`end`).
    ending.is = 'delivered';
    return { result, servedReceipt: receipt };
  }

  /**
   * A failure that left no answer we could read — a timeout, a dead socket, a
   * 2xx whose body could not be parsed — after the authorization was sent.
   *
   * Says so in the message (`AFTER paying` + the same advice as every other
   * post-payment failure) and stamps `payment`. The header was already kept
   * out of the transport's message where that message is built — see the
   * `DescribeUnreachable` in `request()` — and nothing appended here comes from
   * the response.
   */
  private failedAfterSending(
    error: unknown,
    path: string,
    authorization: HeldAuthorization,
    attempt: PaymentAttempt,
  ): unknown {
    if (typeof error === 'object' && error !== null) this.#heldFor.set(error, { path, authorization });
    if (error instanceof DescribeError) {
      error.message =
        `${error.message} — AFTER paying (settlement: ${attempt.settlement}` +
        `${attempt.receipt ? `, receipt ${attempt.receipt}` : ''}). ${adviceAfterPaying(attempt)}`;
    }
    return attachPayment(error, attempt);
  }

  /**
   * Read the 402 challenge from wherever it is.
   *
   * The header FIRST, then the body — and that order is measured, not
   * defensive: of 40 live x402 resources probed on 2026-08-20, 36 of 36 that
   * answered 402 carried the challenge in the header and none in the body
   * (`uvd-x402-sdk-typescript/src/utils/x402.ts`). describe.net serves BOTH
   * (verified 2026-08-30: `Payment-Required` base64 header AND a JSON body), so
   * either path works here — the order is for the ecosystem, not for us.
   */
  private async readChallenge(response: Response, path: string): Promise<X402Challenge> {
    const raw = response.headers.get('Payment-Required') ?? response.headers.get('X-Payment-Required');
    if (raw) {
      const trimmed = raw.trim();
      for (const decode of [() => atob(trimmed), () => trimmed]) {
        try {
          const parsed = JSON.parse(decode());
          if (parsed && typeof parsed === 'object') return parsed as X402Challenge;
        } catch {
          // not this encoding; try the next
        }
      }
    }
    const body = await this.readJson(response, path);
    if (body && typeof body === 'object') return body as X402Challenge;
    throw new DescribeUnparseable(`GET ${path} answered 402 with no readable challenge`);
  }

  /**
   * `DO_NOT_PAY` unless every recipient in the challenge is the pinned
   * treasury.
   *
   * Checks the top-level `recipient` AND every `accepts[].payTo`, because a
   * challenge that names the right treasury up top and a stranger in one of six
   * `accepts` entries is exactly the shape an attack would take: the caller's
   * chain selection decides which one gets paid. Case-insensitive, since EVM
   * addresses travel in mixed checksum case (the live challenge serves
   * `0xe4dc963c56979E0260fc146b87eE24F18220e545` while the path parameter is
   * lowercase).
   */
  private assertPayableTo(challenge: X402Challenge): void {
    const expected = this.expectedPayTo.toLowerCase();
    const offered: Array<string | undefined> = [
      typeof challenge.recipient === 'string' ? challenge.recipient : undefined,
      ...Object.values(challenge.recipients ?? {}),
      ...(challenge.accepts ?? []).map((a) =>
        typeof a?.payTo === 'string' ? (a.payTo as string) : undefined,
      ),
    ];

    const seen = offered.filter((a): a is string => typeof a === 'string' && a.length > 0);
    if (seen.length === 0) {
      throw new DescribePaymentRefused(this.expectedPayTo, undefined, challenge);
    }
    for (const address of seen) {
      if (address.toLowerCase() !== expected) {
        throw new DescribePaymentRefused(this.expectedPayTo, address, challenge);
      }
    }
  }
}
