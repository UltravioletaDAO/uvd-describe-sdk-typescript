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
 * ## Note on the public surface
 *
 * There is no function here that returns a bare score. `formatScore` takes a
 * number you already pulled off a sealed result, and every result carries
 * `policyVersion` and `caveats[]`. That is deliberate: *un score sin sus
 * calificadores es un rumor*, and a `getScore(): number` would erase the reason
 * the index exists. Reach into the object by hand — the friction is the point.
 */

export { DescribeClient } from './client';
export type { DescribeClientConfig, DescribeFailure, X402Payer } from './client';

export {
  DescribeError,
  DescribeHTTPError,
  DescribePaymentRefused,
  DescribePaymentRequired,
  DescribeTimeout,
  DescribeUnparseable,
  DescribeUnreachable,
  failOpenCovers,
} from './errors';
export type { DescribeErrorKind, X402Challenge } from './errors';

export {
  CAVEAT_CODES,
  CAVEAT_SCOPE_FREE,
  CAVEAT_SCOPE_METERED,
  hasCaveat,
  isKnownCaveatCode,
} from './caveats';
export type { Caveat, CaveatCode, KnownCaveatCode } from './caveats';

export { formatScore, roundScore } from './format';

export {
  DEFAULT_BASE_URL,
  DEFAULT_SITE_URL,
  DEFAULT_TIMEOUT_MS,
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
