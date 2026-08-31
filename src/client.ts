/**
 * `DescribeClient` — six methods, four of which touch the network.
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
 * `wallet()`, `leaderboard()` and `health()` are free, so absence (2) costs
 * nothing and a `null` is the kindest answer: without it every consumer writes
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
  DEFAULT_BASE_URL,
  DEFAULT_JITTER_MS,
  DEFAULT_SITE_URL,
  DEFAULT_TIMEOUT_MS,
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
  type X402Challenge,
} from './errors';
import { looksLikeSettlementReceipt, malformedHashReport } from './hashes';
import { jitterDelayMs, sleep } from './jitter';
import {
  parseAgentReputation,
  parseHealth,
  parseLeaderboard,
  parseWalletBreakdown,
  parseWalletReputation,
} from './parse';
import type {
  AgentReputation,
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

  constructor(config: DescribeClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ua = userAgent(config.product);
    this.failOpen = config.failOpen ?? true;
    this.onFailure = config.onFailure;
    // Garbage falls back to the DEFAULT, never to off, and never throws here: a
    // mistyped option must not silently drop a protection the rest of the
    // ecosystem relies on, and a library that dies in its constructor over one
    // is worse than one that ignores it. Only a real 0 disables the jitter.
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
    const { body, payment, servedReceipt } = await this.getPaidJson(path);
    const result = parseWalletBreakdown(body, payment);
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
    const { body, payment, servedReceipt } = await this.getPaidJson(path);
    const result = parseAgentReputation(body, payment);
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
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET', // never HEAD: every route but /openapi.json answers 405 to it
        headers: { Accept: 'application/json', 'User-Agent': this.ua, ...signed, ...headers },
        signal: controller.signal,
      });
    } catch (error) {
      // An AbortError here is ours (the timer), not the caller's: this
      // controller is created in this function and handed to nobody.
      const name = (error as { name?: string } | null)?.name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new DescribeTimeout(`GET ${path} timed out after ${this.timeoutMs} ms`, error);
      }
      throw new DescribeUnreachable(`GET ${path} unreachable: ${String(error)}`, error);
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
      throw new DescribeHTTPError(response.status, `GET ${path} -> HTTP ${response.status}`);
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
   */
  private async getPaidJson(
    path: string,
  ): Promise<{ body: unknown; payment: PaymentEvidence | null; servedReceipt: string | null }> {
    const first = await this.request(path);

    if (first.ok) {
      // Free-tier or already-settled. No charge, so no evidence to report.
      return { body: await this.readJson(first, path), payment: null, servedReceipt: null };
    }

    if (first.status === 404) {
      // Absence, and free: nothing was paid to learn it. The metered route is
      // the one where a 404 is most likely (an agent id that does not exist),
      // and charging for it would be charging for "there is nothing here".
      throw new DescribeNotFound(`GET ${path} -> HTTP 404`);
    }

    if (first.status !== 402) {
      throw new DescribeHTTPError(first.status, `GET ${path} -> HTTP ${first.status}`);
    }

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
    const header = await this.payer.pay(challenge);

    // ─────────── BELOW THIS LINE A SIGNED ENVELOPE IS IN FLIGHT ───────────
    const terms = {
      amount: typeof challenge.amount === 'string' ? challenge.amount : undefined,
      token: typeof challenge.token === 'string' ? challenge.token : undefined,
      payTo: typeof challenge.recipient === 'string' ? challenge.recipient : undefined,
    };

    let second: Response;
    try {
      second = await this.request(path, { 'X-PAYMENT': header });
    } catch (error) {
      // No answer at all — timeout or dead socket. `fetch` rejects identically
      // whether the request bytes were written or not, so this is exactly the
      // case that CANNOT be narrowed: `unknown`, said out loud.
      throw attachPayment(error, { settlement: 'unknown', receipt: null, reused: null, ...terms });
    }

    const receipt = second.headers.get('X-Payment-Receipt');
    const reused = second.headers.get('X-Payment-Reused');
    const attempt: PaymentAttempt = {
      // A receipt is the settlement transaction hash, put there by the seller:
      // proof, not inference. Its absence proves nothing — an unhandled 500 is
      // rendered above the paywall middleware and never gets the header.
      //
      // ⚠️ Since 2026-08-30 the header must also LOOK like a settlement id (a
      // hash, or the `pending` the OpenAPI declares) before it may be called
      // proof. `'settled'` means *we hold the hash*, and a string that is not
      // one is not one. The value is still carried in `receipt` — on this path
      // it is forensic evidence, not a typed field — and `'unknown'` is the
      // honest verdict: ask the chain.
      settlement: receipt !== null && looksLikeSettlementReceipt(receipt) ? 'settled' : 'unknown',
      receipt,
      reused: reused === null ? null : reused.toLowerCase() === 'true',
      status: second.status,
      ...terms,
    };

    if (!second.ok) {
      // 🔴 Money may already be gone here: the authorization was signed and the
      // paywall settles BEFORE running the query. The status is preserved so a
      // caller can tell "they refused the payment" (4xx) from "we paid and
      // their query blew up" (5xx) — different conversations to have with them.
      throw attachPayment(
        new DescribeHTTPError(
          second.status,
          `GET ${path} -> HTTP ${second.status} AFTER paying (settlement: ${attempt.settlement}` +
            `${receipt ? `, receipt ${receipt}` : ''}). Read \`error.payment\` before retrying: ` +
            'the same receipt unlocks only this byte-identical resource.',
        ),
        attempt,
      );
    }

    let body: unknown;
    try {
      body = await this.readJson(second, path);
    } catch (error) {
      // The worst of the set and the easiest to forget: a 200 whose body is
      // garbage. It settled — the receipt is right there — and the caller got
      // nothing for it. Swallowing THIS was the old behaviour.
      throw attachPayment(error, attempt);
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
    // not a hash. `'settled'` means *we hold the hash*, and we do not.
    const receiptOk = receipt !== null && looksLikeSettlementReceipt(receipt);
    return {
      body,
      payment: {
        receipt: receiptOk ? receipt : null,
        reused: (reused ?? '').toLowerCase() === 'true',
        malformedHashes: receipt !== null && !receiptOk ? ['receipt'] : [],
      },
      servedReceipt: receipt,
    };
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
