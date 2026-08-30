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
  | 'payment_refused';

export class DescribeError extends Error {
  readonly kind: DescribeErrorKind;
  /** Would retrying help? Drives backoff, never `failOpen`. */
  readonly transient: boolean;
  /** Is this describe.net's fault? Drives `failOpen`, never retry. */
  readonly serviceFault: boolean;
  /** Present when a status was actually received. */
  readonly status?: number;

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
 * 404 — absence, wearing an exception's clothes only so it can unwind the
 * stack. `DescribeClient.guard` converts it to `null` before any caller sees
 * it, which is why this class is not exported from the package index: "a 404
 * never reaches the caller as an error" is structural here, not a convention
 * somebody has to remember.
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
 * Does `failOpen` cover this failure?
 *
 * The single predicate, so the rule lives in one place instead of being
 * re-derived at each call site. Saul's words were "pon un fallback si es que
 * describe está caído" — `serviceFault` is the typed form of "está caído", and
 * nothing else qualifies.
 */
export function failOpenCovers(error: unknown): error is DescribeError {
  return error instanceof DescribeError && error.serviceFault;
}
