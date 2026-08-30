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
 * **No retry.** Same reason, plus a measured one: MeshRelay retries a transient
 * failure at most ONCE, "hammering a permanent failure is how EM turned one
 * error into a four-hour storm" (`describenet.js:150-151`). A retry policy
 * inside a library multiplies against whatever the caller already has.
 * `DescribeError.transient` is exported so a caller can build the policy they
 * want on a fact instead of on a string match.
 */

import {
  DEFAULT_BASE_URL,
  DEFAULT_SITE_URL,
  DEFAULT_TIMEOUT_MS,
  TREASURY_EVM,
  userAgent,
} from './config';
import {
  attachPayment,
  DescribeError,
  DescribeHTTPError,
  DescribeNotFound,
  DescribePaymentRefused,
  DescribePaymentRequired,
  DescribeTimeout,
  DescribeUnparseable,
  DescribeUnreachable,
  failOpenCovers,
  type PaymentAttempt,
  type X402Challenge,
} from './errors';
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
   * Where a swallowed failure goes. Called before `null` is returned, always —
   * and **only** then. The invariant reads in one line: `onFailure` fires if and
   * only if a method hands back `null` instead of an answer. A failure that
   * reaches you as a throw is not announced here, because you are already
   * holding it; the paid routes therefore never call this at all.
   *
   * Leaving this unset with `failOpen: true` is the one configuration this
   * package will not defend: it converts "describe is down" into "this wallet
   * has no reputation" with nothing written down anywhere. It is allowed
   * because a hard requirement would be a `throw` in the constructor of a
   * read-only client, but the README says it plainly and so does this comment.
   */
  onFailure?: (failure: DescribeFailure) => void;
  /** Pay metered routes. Without it, a 402 throws `DescribePaymentRequired`. */
  payer?: X402Payer;
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
  private readonly payer?: X402Payer;
  private readonly expectedPayTo: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: DescribeClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ua = userAgent(config.product);
    this.failOpen = config.failOpen ?? true;
    this.onFailure = config.onFailure;
    this.payer = config.payer;
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
    const { body, payment } = await this.getPaidJson(path);
    return parseWalletBreakdown(body, payment);
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
    const { body, payment } = await this.getPaidJson(path);
    return parseAgentReputation(body, payment);
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

  private async request(path: string, headers: Record<string, string> = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET', // never HEAD: every route but /openapi.json answers 405 to it
        headers: { Accept: 'application/json', 'User-Agent': this.ua, ...headers },
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
  ): Promise<{ body: unknown; payment: PaymentEvidence | null }> {
    const first = await this.request(path);

    if (first.ok) {
      // Free-tier or already-settled. No charge, so no evidence to report.
      return { body: await this.readJson(first, path), payment: null };
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
      settlement: receipt ? 'settled' : 'unknown',
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

    return {
      body,
      payment: { receipt, reused: (reused ?? '').toLowerCase() === 'true' },
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
