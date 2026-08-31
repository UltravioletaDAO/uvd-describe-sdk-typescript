/**
 * uvd-describe-sdk — read reputation from describe.net.
 *
 * The ERC-8004 reputation index of Ultravioleta DAO, across 11 chains. Free
 * lookups need no dependency and no credential; metered lookups pay their 402
 * through `uvd-x402-sdk`, which lives behind the `uvd-describe-sdk/x402`
 * subpath so a free-only consumer installs nothing.
 *
 * ```ts
 * import { DescribeClient, formatScore } from 'uvd-describe-sdk';
 *
 * const describe = new DescribeClient({
 *   product: 'my-app',
 *   onFailure: (f) => console.warn('describe.net:', f.kind, f.path),
 * });
 *
 * const rep = await describe.wallet('0x97cd…0996');
 * if (rep === null) {
 *   // describe.net could not be reached. NOT "this wallet has no reputation".
 * } else if (rep.globalScore === null) {
 *   // No eligible rating. That IS the answer — never render it as 0.
 * } else {
 *   console.log(formatScore(rep.globalScore), rep.policyVersion, rep.caveats);
 * }
 * ```
 *
 * ## Three ways in, and only one of them costs anything
 *
 * Free routes need nothing. Metered routes are paid through `uvd-x402-sdk` via
 * `uvd-describe-sdk/x402`, or read for FREE through `uvd-describe-sdk/partner`
 * if your wallet is on describe.net's partner allowlist — a signature per
 * request, no token, no secret held by the service. See `PartnerSigner`.
 *
 * ## The free routes degrade, the paid routes do not
 *
 * `wallet()`, `leaderboard()` and `health()` return `null` when describe.net
 * cannot be reached (that is `failOpen`, on by default, always announced
 * through `onFailure`). `walletBreakdown()` and `agent()` return no `null` at
 * all and throw instead — including with `failOpen: true` — because between
 * signing a payment and reading the answer there is a window where the USDC has
 * already moved, and a `null` there hides a spend from the caller. Use
 * `failedAfterPaying(error)` to tell "it broke before I paid" from "it broke
 * after".
 *
 * ## Note on the public surface
 *
 * There is no function here that returns a bare score. `formatScore` takes a
 * number you already pulled off a sealed result, and every result carries
 * `policyVersion` and `caveats[]`. That is deliberate: *un score sin sus
 * calificadores es un rumor*, and a `getScore(): number` would erase the reason
 * the index exists. Reach into the object by hand — the friction is the point.
 */

export { DescribeClient } from './client';
export type {
  DescribeClientConfig,
  DescribeFailure,
  PartnerSigner,
  X402Payer,
} from './client';

export {
  DescribeError,
  DescribeHTTPError,
  /**
   * 🔴 Exported to be RECOGNISED, never to be caught: it is never thrown. It
   * arrives as the `error` of an `onFailure` notice whose `kind` is
   * `malformed_hash`, saying a hash field was dropped because it was not a hash.
   */
  DescribeMalformedHash,
  /**
   * ⚠️ Exported since 2026-08-30 and it used to be deliberately absent: with the
   * metered methods no longer nullable, a 404 on `walletBreakdown()` / `agent()`
   * DOES reach the caller as a throw, so `instanceof` has to be possible. On the
   * free routes it still never does.
   */
  DescribeNotFound,
  /**
   * The two partner-rail failures. Both are exported because both are meant to
   * be caught by `instanceof`: `DescribePartnerUnsigned` is "fix your config",
   * `DescribePartnerRejected` is "your free rail is off and we did NOT pay for
   * you". Neither is ever swallowed by `failOpen`.
   */
  DescribePartnerRejected,
  DescribePartnerUnsigned,
  DescribePaymentRefused,
  DescribePaymentRequired,
  DescribeTimeout,
  DescribeUnparseable,
  DescribeUnreachable,
  failedAfterPaying,
  failOpenCovers,
} from './errors';
export type { DescribeErrorKind, PaymentAttempt, X402Challenge } from './errors';

/**
 * The recovery table — what to do INSTEAD of the failure you are holding.
 *
 * Absorbed from **Execution Market** (`#agents`, 2026-08-30). Every
 * `DescribeError` already carries its own text in `error.recovery`; the table
 * is exported so a test can pin one without matching on prose, and so a router
 * that has not failed yet can read the advice up front. `recoveryFor()` is the
 * same lookup for a `kind` you hold without an instance.
 *
 * 🔴 Read it, never branch on it: `kind` is the enum.
 */
export { RECOVERY, recoveryFor } from './recovery';
export type { RecoveryKey } from './recovery';

export {
  CAVEAT_CODES,
  CAVEAT_SCOPE_FREE,
  CAVEAT_SCOPE_METERED,
  hasCaveat,
  isKnownCaveatCode,
} from './caveats';
export type { Caveat, CaveatCode, KnownCaveatCode } from './caveats';

export { formatScore, roundScore } from './format';

/**
 * The distinct-rater helper, from MeshRelay. Read its docstring before using the
 * number: summing the per-chain counts double-counts and taking the maximum
 * underestimates, both measured, and this function does neither.
 */
export { resolveDistinctRaters } from './raters';

/**
 * The hash-shape contract, from KarmaKadabra's *"el 200 sin tx"*.
 *
 * Exported because the check belongs to the CONTRACT and not to each consumer —
 * that was their whole point. `malformedHashReport` locates what a parsed result
 * dropped; the two predicates are there for a payload you validate yourself.
 */
export {
  looksLikeOnchainId,
  looksLikeSettlementReceipt,
  malformedHashReport,
  SETTLEMENT_PENDING,
} from './hashes';

export {
  DEFAULT_BASE_URL,
  DEFAULT_JITTER_MS,
  DEFAULT_SITE_URL,
  DEFAULT_TIMEOUT_MS,
  PARTNER_CHAIN_ID,
  PARTNER_KEY_ENV,
  SDK_NAME,
  SDK_VERSION,
  TREASURY_EVM,
  userAgent,
} from './config';

export type {
  Activity,
  AgentReputation,
  Concentration,
  Confidence,
  Facet,
  HealthChain,
  IndexHealth,
  LeaderboardRow,
  Network,
  Ownership,
  PaymentEvidence,
  Rating,
  Sealed,
  SelfRated,
  Snapshot,
  Timestamp,
  WalletBreakdown,
  WalletChainRow,
  WalletReputation,
} from './types';

/**
 * The parsers, exported for one reason: a consumer who already has a describe
 * payload (from the MCP tools, the A2A gate, or a snapshot in their own
 * database) can get the same typed shape without a second HTTP call.
 *
 * EM stores a snapshot in its own table and MeshRelay caches raw JSON — both
 * re-derive shapes from stored payloads today. This is the seam that lets them
 * stop.
 */
export {
  parseAgentReputation,
  parseHealth,
  parseLeaderboard,
  parseWalletBreakdown,
  parseWalletReputation,
} from './parse';
