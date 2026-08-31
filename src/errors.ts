/**
 * The failure taxonomy — and, more importantly, WHICH failures are allowed to
 * disappear.
 *
 * ## Why the names are not new
 *
 * The three live consumers of describe.net each invented their own. Measured
 * on 2026-08-30, they agree on the POLICY (absence is not zero; degrade
 * without taking the caller down) and share not one MECHANISM:
 *
 *   * Execution Market raises typed exceptions
 *     (`timeout | http_5xx | unreachable | unparseable | partial_index`).
 *   * MeshRelay returns null and CACHES the failure, splitting `http_4xx` out
 *     of EM's catch-all bucket (`describenet.js:52-58`).
 *   * KarmaKadabra falls through to a second source (the facilitator).
 *
 * So there was no de-facto contract to copy — there were three answers to one
 * question, and this SDK had to pick one and defend it. It keeps EM's five
 * `kind` strings verbatim (they are the reference implementation, and the
 * Python SDK mirrors them) and adopts MeshRelay's `http_4xx` split, because an
 * SDK — unlike a reconciler job — has to tell its caller apart from the
 * network. Then it adds the two neither of them has, because neither pays.
 *
 * ## The two axes, and why one boolean was not enough
 *
 * `transient` answers "would retrying help?".
 * `serviceFault` answers "is this describe.net's fault?" — i.e. is this the
 * "describe está caído" that `failOpen` exists for (Saul, 2026-08-28).
 *
 * They are not the same question and collapsing them breaks in both
 * directions. A 422 `not_an_address` is neither: swallowing it under
 * `failOpen` would hide a caller's bug forever behind "this wallet has no
 * reputation" — the exact confusion `null`-never-`0` exists to prevent. A
 * garbled body from a 502-ing proxy IS describe's fault (so `failOpen` covers
 * it) but retrying it immediately is pointless, and MeshRelay measured that:
 * its retry set is `TIMEOUT | HTTP_5XX | UNREACHABLE` and deliberately excludes
 * `UNPARSEABLE` (`describenet.js:161-164`).
 *
 * ## The third axis, added 2026-08-30: was there money in flight?
 *
 * `serviceFault` decides what `failOpen` may swallow — but only on the FREE
 * routes. On a metered route the question never gets asked, because the answer
 * would be irrelevant: a swallowed failure after settlement is a spent
 * credential with no receipt (see `client.ts`, "the paid routes never fail
 * open"). So `DescribeError` gained an optional `payment`, and its mere
 * presence is the statement *"a signed envelope had already left this process
 * when this failed"*. Read it with `failedAfterPaying()`.
 */

/** The closed set. Consumers switch on `kind`, never on `message`. */
export type DescribeErrorKind =
  /** The request outlived the client timeout — includes provider cold starts. */
  | 'timeout'
  /** describe.net answered 5xx. Its fault, and retryable. */
  | 'http_5xx'
  /**
   * describe.net answered 4xx. Ours, not theirs: 422 `not_an_address` is the
   * common member. 429 (the shared 20 rps) also lands here and is the one 4xx
   * that IS transient — see `transient` on the instance, not on the kind.
   */
  | 'http_4xx'
  /**
   * The route answered 404. **This is data, not a failure** — and it is the
   * one entry of this union that never reaches a caller as a thrown error.
   *
   * R4 is absolute: no exception for "there is no data". A 404 says exactly
   * that, so the method returns its absence value (`null`) whether `failOpen`
   * is on or off — `failOpen` is about outages and this is about absence, two
   * different axes.
   *
   * It is still reported through `onFailure`, and that is deliberate: a
   * mistyped `baseUrl` makes every route 404, and a silent `null` forever
   * would be indistinguishable from "nobody in this index has any reputation".
   * `transient` is false and the kind names itself, so a caller who expects
   * misses can filter it in one line.
   *
   * As of 2026-08-30 no route this SDK wraps returns 404 for a valid input:
   * an unregistered wallet is a **200** with nulls, and a malformed one is a
   * **422**. It is here for the agent route and for whatever the API adds.
   */
  | 'not_found'
  /** Transport died before any status: DNS, connect, reset, CORS, offline. */
  | 'unreachable'
  /** A body arrived and could not be read into the typed shape. */
  | 'unparseable'
  /**
   * The index answered, but its coverage is partial for what was asked.
   *
   * This SDK never raises it — a partial index is served as a 200 whose
   * `chains[]` simply lacks rows, which is data. It exists so a caller that
   * DETECTS partial coverage (a chain it writes to that the index does not
   * scan) can classify it inside the same taxonomy instead of inventing a
   * sixth one. Kept for parity with EM's reference (`types.py:82-92`).
   */
  | 'partial_index'
  /**
   * A metered route answered 402 and this client has no `payer` configured.
   *
   * Protocol, not absence: the index is up and told us its price. Never
   * swallowed by `failOpen` — a caller who forgot to wire a payer must find
   * out, and the challenge is attached so they can read the price without
   * paying (asking is free, and is the intended first move).
   */
  | 'payment_required'
  /**
   * A 402 challenge named a `payTo` that is not the pinned treasury.
   *
   * `DO_NOT_PAY`. Never a retry, never `failOpen`-able: the one failure where
   * continuing quietly costs real USDC to a stranger.
   */
  | 'payment_refused'
  /**
   * A hash field arrived carrying something that is not a hash.
   *
   * 🔴 **Never thrown.** It travels only through `onFailure`, and the class that
   * carries it says so in its own first line — see {@link DescribeMalformedHash}.
   * Branch on this `kind`, never on a `catch` that will not fire.
   */
  | 'malformed_hash'
  /**
   * Partner mode is configured and the signature could not be produced AT ALL.
   *
   * The CALLER's configuration, not describe.net's: an unset env var, a signer
   * that refuses, a wallet that is locked. `serviceFault: false`, so `failOpen`
   * never swallows it — on a free route either. A partner client that silently
   * loses its signature is a partner client that silently starts paying, and
   * that is the whole failure this rail exists to make impossible.
   */
  | 'partner_unsigned'
  /**
   * We signed, and describe.net charged anyway.
   *
   * The signature was produced and sent, and the metered route still answered
   * 402 — so the gate did not exempt us. Measured causes, in the order they
   * happen in real life (`describe-net/describenet/partner.py`):
   *
   *   * the wallet is not in the allowlist (`partner.py:242`), i.e. nobody has
   *     added this partner yet — Execution Market is registered, KarmaKadabra
   *     and MeshRelay are NOT, as of 2026-08-30;
   *   * the signed `@authority` is not `api.describe.net` (`partner.py:84`) —
   *     which is what a custom `baseUrl` produces, including the raw
   *     execute-api host behind CloudFront, deliberately;
   *   * the keyid's chain is not 8453 (`partner.py:90`);
   *   * the clock is off by more than 30 s ahead or the signature is older than
   *     300 s (`partner.py:95-96`).
   *
   * `payment` is ABSENT and that is load-bearing: nothing was signed, nothing
   * was sent, nothing was spent. This error is the moment BEFORE the money.
   */
  | 'partner_rejected';

/**
 * What this SDK can honestly say about the USDC when a metered call fails.
 *
 * ## Why an object and not a boolean
 *
 * A bare `DescribeTimeout` cannot tell "it died before we paid" (you spent
 * nothing) from "it died after" (you may have spent and got nothing back).
 * Those are different conversations — the first is a retry, the second is a
 * reconciliation — and the exception has to carry which one it is.
 *
 * ## The rule, and it is the whole point of this type
 *
 * **`error.payment` exists ⇔ a signed `X-PAYMENT` envelope had already left
 * this process.** Its ABSENCE on a metered failure is therefore itself an
 * answer: nothing was transmitted, so nothing could have settled. That covers
 * the 402 with no payer, the `DO_NOT_PAY` refusal, the 404 (which arrives
 * before any challenge is even read), and a payer that threw while signing —
 * an EIP-3009 authorization that never leaves the payer moves no money, because
 * money moves when the SELLER submits it, not when the buyer signs it.
 *
 * ## `settlement`, and the one thing it will not do is guess
 *
 * `'settled'` is asserted only against proof in hand: `X-Payment-Receipt`, whose
 * value is the settlement transaction hash (or the literal `"pending"`). Read on
 * 2026-08-30 in the service's own middleware —
 * `describe-net/describenet/paywall.py:1031-1065` — the paywall settles inside
 * `authorize()` **before** `call_next(request)` runs the handler, and then
 * attaches the receipt headers to whatever response comes back. A non-2xx
 * response with a receipt is therefore a settlement that happened, stated by the
 * seller.
 *
 * `'unknown'` is everything else, and it is honest rather than pessimistic. Two
 * measured holes forbid upgrading it to a verdict:
 *
 *   1. **A 500 can be settled and carry no receipt.** If the handler raises,
 *      Starlette's `ServerErrorMiddleware` — which sits OUTSIDE the paywall
 *      middleware, verified 2026-08-30: `api.py:2110` is the only
 *      `add_middleware` for it and `api.py` registers no exception handler —
 *      answers 500 without the header line ever running. The money moved in
 *      `authorize()` regardless.
 *   2. **A dead socket proves nothing.** `fetch` rejects the same way whether
 *      the connection died before the request bytes were written or while the
 *      response was coming back.
 *
 * So: `'settled'` means *we hold the hash*. `'unknown'` means *ask the chain* —
 * never *"nothing happened"*. If you need the stronger answer, the receipt of a
 * later successful call and the on-chain transfer to the treasury are where it
 * lives; this SDK will not infer it for you.
 */
export interface PaymentAttempt {
  /** `'settled'` only with a receipt in hand. See the header of this type. */
  settlement: 'settled' | 'unknown';
  /** `X-Payment-Receipt` — the settlement tx hash, or `"pending"`. */
  receipt: string | null;
  /** `X-Payment-Reused: true` means an earlier receipt was replayed, no new charge. */
  reused: boolean | null;
  /** The status of the answer that failed, when an answer arrived at all. */
  status?: number;
  /** What the challenge asked for. Copied, never re-priced. */
  amount?: string;
  token?: string;
  /** The recipient we verified against the pinned treasury before signing. */
  payTo?: string;
}

export class DescribeError extends Error {
  readonly kind: DescribeErrorKind;
  /** Would retrying help? Drives backoff, never `failOpen`. */
  readonly transient: boolean;
  /** Is this describe.net's fault? Drives `failOpen`, never retry. */
  readonly serviceFault: boolean;
  /** Present when a status was actually received. */
  readonly status?: number;
  /**
   * Set **only** when a signed envelope was already in flight. Not readonly for
   * one reason: the failure is built deep in the transport, which knows nothing
   * about payment, and `attachPayment()` stamps it on the way out. Treat it as
   * readonly — nothing in this package writes it twice.
   */
  payment?: PaymentAttempt;

  constructor(
    kind: DescribeErrorKind,
    message: string,
    opts: { transient: boolean; serviceFault: boolean; status?: number; cause?: unknown } = {
      transient: false,
      serviceFault: false,
    },
  ) {
    super(message, { cause: opts.cause });
    this.name = 'DescribeError';
    this.kind = kind;
    this.transient = opts.transient;
    this.serviceFault = opts.serviceFault;
    this.status = opts.status;
  }
}

export class DescribeTimeout extends DescribeError {
  constructor(message: string, cause?: unknown) {
    super('timeout', message, { transient: true, serviceFault: true, cause });
    this.name = 'DescribeTimeout';
  }
}

export class DescribeUnreachable extends DescribeError {
  constructor(message: string, cause?: unknown) {
    super('unreachable', message, { transient: true, serviceFault: true, cause });
    this.name = 'DescribeUnreachable';
  }
}

export class DescribeUnparseable extends DescribeError {
  constructor(message: string, cause?: unknown) {
    // serviceFault: they answered and the answer was unreadable — that is on
    // them, so failOpen covers it. NOT transient: MeshRelay measured that
    // retrying an unparseable body buys nothing (`describenet.js:161-164`).
    super('unparseable', message, { transient: false, serviceFault: true, cause });
    this.name = 'DescribeUnparseable';
  }
}

/**
 * A hash field arrived with something that is not a hash.
 *
 * Contributed by **KarmaKadabra** (`#agents`, 2026-08-30), out of the finding
 * they call *"el 200 sin tx"*: *"si nosotros no chequeáramos el tx, habríamos
 * contado 14 ratings que no existen"*. A 200 that did not do the thing is worse
 * than a 503, because the client takes it for good.
 *
 * 🔴 **THIS IS NEVER THROWN. Do not write a `catch` for it.** It travels only as
 * the `error` of a {@link DescribeFailure} handed to `onFailure`, and it exists
 * as a class for one mechanical reason: that channel is typed
 * `DescribeError`, so reusing the channel the consumer is ALREADY watching —
 * which is what KarmaKadabra asked for — requires the fact to BE a
 * `DescribeError`. Branch on `kind === 'malformed_hash'` or on `instanceof`,
 * never on a `try/catch` that will not fire.
 *
 * ⚠️ There is a tension with this taxonomy and it is declared rather than
 * papered over: `partial_index` is also documented as never raised, and it is
 * kept only for parity with Execution Market's reference. Publishing exceptions
 * nobody throws invites dead `catch` blocks. What separates the two is what the
 * class is FOR: `partial_index` exists so someone can catch it and nobody will,
 * this one exists to ride a channel that is already typed, and its first line
 * shouts as much. If `onFailure` ever accepts something wider than a
 * `DescribeError`, this class stops being necessary.
 *
 * Why the failure does NOT take the read down: the rest of the response is very
 * likely useful, and killing a whole reputation breakdown over an accessory
 * field would be worse than the bug being hunted — especially on a metered
 * route, where the read has already been paid for. The typed field is left
 * `null` so nobody builds an explorer link out of garbage, and the raw value
 * survives in the result's `raw`, which is where it gets investigated.
 *
 * 🔴 **Absent and malformed are NOT the same thing, and the result keeps them
 * apart** (R1, one level below where it usually lives):
 *
 * ```
 *   rating.txHash === null, malformedHashes empty      → IT DID NOT COME
 *   rating.txHash === null, 'tx_hash' in malformedHashes → GARBAGE CAME
 * ```
 *
 * `fields` carries the location of each one, with an index when it is inside a
 * list: `['ratings[3].tx_hash', 'snapshot.inputs_digest']`. Wire names, not
 * ours, because this string ends up in a ticket to whoever runs the index.
 *
 * `serviceFault` is **false** even though the bad data is describe.net's: this
 * flag drives `failOpen`, and a read that succeeded has nothing to fail open
 * INTO. `transient` is false for the same kind of reason — the same request will
 * bring the same bad field back.
 */
export class DescribeMalformedHash extends DescribeError {
  /** Qualified paths of the fields that arrived malformed, in order. */
  readonly fields: string[];
  constructor(message: string, fields: string[]) {
    super('malformed_hash', message, { transient: false, serviceFault: false });
    this.name = 'DescribeMalformedHash';
    this.fields = [...fields];
  }
}

/**
 * 404 — absence.
 *
 * ⚠️ **CORRECTED 2026-08-30, and the old text is left below because somebody
 * will come looking for it.** It used to say: *"`DescribeClient.guard` converts
 * it to `null` before any caller sees it, which is why this class is not
 * exported from the package index: 'a 404 never reaches the caller as an error'
 * is structural here"*. That stopped being true when the metered methods lost
 * their `| null` return: `walletBreakdown()` and `agent()` have no absence value
 * left to degrade INTO, so on those two routes a 404 arrives as this exception,
 * and the class is now exported so `instanceof` works.
 *
 * On the free routes nothing changed — still `null`, still announced through
 * `onFailure`, still regardless of `failOpen`.
 *
 * Absence did not become a failure; it changed clothes. It keeps
 * `transient: false`, `serviceFault: false`, and — the load-bearing part — **no
 * `payment`**: a metered 404 is checked before the challenge is even read, so
 * nothing was signed and nothing was spent to learn that there is nothing there.
 */
export class DescribeNotFound extends DescribeError {
  constructor(message: string) {
    super('not_found', message, { transient: false, serviceFault: false, status: 404 });
    this.name = 'DescribeNotFound';
  }
}

export class DescribeHTTPError extends DescribeError {
  constructor(status: number, message: string) {
    const server = status >= 500;
    super(server ? 'http_5xx' : 'http_4xx', message, {
      // 429 is the one 4xx worth retrying: the 20 rps ceiling is shared with
      // every other UVD consumer, so it says "someone else is loud right now",
      // not "your request is wrong".
      transient: server || status === 429,
      // A 4xx is the caller's fault and must NOT vanish into failOpen — except
      // 429, which is the shared limit and reads exactly like a brief outage.
      serviceFault: server || status === 429,
      status,
    });
    this.name = 'DescribeHTTPError';
  }
}

/** The parsed 402, as served. Kept raw: we read it, we never re-price it. */
export interface X402Challenge {
  /** Human price, e.g. `"0.01"`. From the challenge — never typed by us. */
  amount?: string;
  /** Default recipient. Checked against the pinned treasury before paying. */
  recipient?: string;
  recipients?: Record<string, string | undefined>;
  token?: string;
  supportedChains?: number[];
  accepts?: Array<Record<string, unknown>>;
  /** Everything else the challenge carried, untouched (passthrough rule). */
  [key: string]: unknown;
}

export class DescribePaymentRequired extends DescribeError {
  readonly challenge: X402Challenge;
  constructor(message: string, challenge: X402Challenge) {
    super('payment_required', message, { transient: false, serviceFault: false, status: 402 });
    this.name = 'DescribePaymentRequired';
    this.challenge = challenge;
  }
}

export class DescribePaymentRefused extends DescribeError {
  readonly challenge: X402Challenge;
  readonly expected: string;
  readonly offered: string | undefined;
  constructor(expected: string, offered: string | undefined, challenge: X402Challenge) {
    super(
      'payment_refused',
      `DO_NOT_PAY: the 402 challenge asks to pay ${offered ?? '(no recipient)'}, ` +
        `not the pinned treasury ${expected}. Nothing was signed.`,
      { transient: false, serviceFault: false, status: 402 },
    );
    this.name = 'DescribePaymentRefused';
    this.challenge = challenge;
    this.expected = expected;
    this.offered = offered;
  }
}

/**
 * Partner mode is on and the signature could not be produced.
 *
 * ## Why this THROWS instead of quietly paying, on every route
 *
 * The alternative is the one thing a partner rail must never do. Without a
 * signature the request is an ordinary anonymous request: describe.net answers
 * 402 on a metered route and the configured payer settles it, in USDC, silently
 * — the consumer keeps getting answers and only finds out at the invoice. Saul
 * asked for a rail where our own products read for free; a rail that degrades
 * into paying is not that rail, it is a bill.
 *
 * So this is a CALLER-fault error (`serviceFault: false`), which means
 * `failOpenCovers()` is `false` for it and `failOpen: true` does not swallow it
 * — not even on the free routes, where the signature costs nothing and buys
 * nothing. That is deliberate and not an oversight: a partner whose signer is
 * broken on `/health` has the same broken signer on
 * `/reputation/wallet/{w}` thirty seconds later, and the free call is the
 * cheapest possible place to find out.
 *
 * It carries no `payment` — nothing was sent, so nothing could have settled.
 *
 * 🔴 `cause` is the signer's own error and this class never reads it, never
 * reformats it and never puts it in `message`. A signer that fails on a
 * malformed key can have key material inside its exception (measured: see
 * `partner/index.ts`, the ethers `invalid BytesLike value` finding), and this
 * SDK will not be the thing that copies it into a log line.
 */
export class DescribePartnerUnsigned extends DescribeError {
  /** The signing address, when the signer published one. Public by design. */
  readonly address: string | undefined;
  constructor(path: string, address: string | undefined, cause: unknown) {
    super(
      'partner_unsigned',
      `Partner mode is configured but signing GET ${path} failed` +
        `${address ? ` for ${address}` : ''}. This is a CALLER configuration ` +
        'failure, and it is raised rather than downgraded on purpose: without a ' +
        'signature this client is an anonymous client, and an anonymous client ' +
        'PAYS. Read `error.cause` for the signer\'s own error.',
      { transient: false, serviceFault: false, cause },
    );
    this.name = 'DescribePartnerUnsigned';
    this.address = address;
  }
}

/**
 * We signed as a partner and describe.net asked for money anyway.
 *
 * ## The case this class exists for, and it is the important one
 *
 * A partner client that gets a 402 has lost its free rail. If it falls through
 * to the payer, the fall is invisible: same answers, same latency, same shape —
 * and USDC leaving a wallet that budgeted none. The alternative failure (a loud
 * throw) costs one broken read and a fixable configuration; the silent one costs
 * money for as long as nobody looks.
 *
 * So partner mode does NOT pay by default. `partnerFallsBackToPaying: true`
 * turns it back on as an explicit, typed decision by the caller — the flag
 * exists so that "pay anyway" is something someone WROTE, never something that
 * happened.
 *
 * The challenge is attached unpaid, so a caller who decides to pay after all can
 * read exactly what it would have cost. And `payment` is absent: this is thrown
 * before `payer.pay()` is ever reached, so nothing was signed and nothing moved.
 */
export class DescribePartnerRejected extends DescribeError {
  readonly challenge: X402Challenge;
  /** The address we signed with. Public by design — the allowlist is public. */
  readonly address: string | undefined;
  constructor(path: string, address: string | undefined, challenge: X402Challenge) {
    super(
      'partner_rejected',
      `GET ${path} answered 402 even though this client signed it as a partner` +
        `${address ? ` with ${address}` : ''}. The free rail is NOT active: the ` +
        'address may not be in describe.net\'s allowlist, the signed @authority ' +
        'may not be api.describe.net (a custom baseUrl does that), the keyid ' +
        'chain may not be 8453, or the clock may be off. NOTHING WAS PAID — ' +
        'this throw is what stops a partner from silently spending USDC. Read ' +
        '`error.challenge` for the price, or set `partnerFallsBackToPaying: true` ' +
        'to pay on purpose.',
      { transient: false, serviceFault: false, status: 402 },
    );
    this.name = 'DescribePartnerRejected';
    this.challenge = challenge;
    this.address = address;
  }
}

/**
 * Does `failOpen` cover this failure?
 *
 * The single predicate, so the rule lives in one place instead of being
 * re-derived at each call site. Saul's words were "pon un fallback si es que
 * describe está caído" — `serviceFault` is the typed form of "está caído", and
 * nothing else qualifies.
 *
 * ⚠️ **Corrected 2026-08-30 — this predicate answers a smaller question than it
 * used to.** It was the ONLY gate: every method ran its failure through it, so
 * `walletBreakdown()` and `agent()` returned `null` on any `serviceFault`,
 * including a timeout that arrived AFTER settlement. That is a spent credential
 * with no receipt, and the caller never learned they had paid. The rule now has
 * a term this predicate cannot see — *was there money in flight* — so the
 * metered methods never call it at all. It is still exported, and calling it
 * yourself on a paid failure answers a question you should not be asking: use
 * `failedAfterPaying()` instead.
 */
export function failOpenCovers(error: unknown): error is DescribeError {
  return error instanceof DescribeError && error.serviceFault;
}

/**
 * Did this failure happen with a signed envelope already in flight?
 *
 * `true` means the money MAY have moved and you should reconcile; read
 * `error.payment` for the receipt (proof) or the `'unknown'` that says the SDK
 * cannot tell. `false` means nothing was transmitted — a 402 with no payer, a
 * `DO_NOT_PAY`, a 404, a payer that declined, or any failure on a free route.
 */
export function failedAfterPaying(
  error: unknown,
): error is DescribeError & { payment: PaymentAttempt } {
  return error instanceof DescribeError && error.payment !== undefined;
}

/**
 * Stamp a failure with what we know about the payment, on its way out.
 *
 * Internal: `client.ts` is the only caller, because it is the only place that
 * knows where the envelope was when things broke. Non-`DescribeError` throws
 * pass through untouched — a payer that throws its own `Error` is not ours to
 * annotate, and it never got as far as sending anything anyway.
 */
export function attachPayment(error: unknown, attempt: PaymentAttempt): unknown {
  if (error instanceof DescribeError) error.payment = attempt;
  return error;
}
