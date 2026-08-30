/**
 * Fixtures captured from the LIVE API on 2026-08-30, byte for byte.
 *
 * Not invented shapes. Every payload here was fetched from
 * `https://api.describe.net` that day and pasted in — because a fixture a
 * developer wrote from the schema tests the developer's reading of the schema,
 * which is the thing most likely to be wrong. `build_sha` on the health payload
 * is `737bc1e…`, so a future reader can tell exactly which deploy answered.
 *
 * Not reachable from either build entry, so nothing here ships.
 */

/** `GET /wallets/0x97cd…0996/chains` — a wallet WITH reputation. */
export const WALLET_WITH_SCORE = {
  wallet: '0x97cd97cfe21799bacbf39d0a53469e5f82f30996',
  chains: [
    {
      network: 'monad',
      agent_count: 1,
      agent_ids: ['182'],
      final_score: 100.0,
      total_reviews: 7548,
      distinct_raters: 7548,
    },
  ],
  caveats: [],
  identity_count: 1,
  chains_with_identity: 1,
  chains_with_reputation: 1,
  total_reviews: 7548,
  distinct_raters: 7548,
  global_score: 100.0,
  policy_version: 'equal-weight-per-chain@2',
  source: 'chain_rankings_mv',
  refreshed_at: '2026-08-30T20:50:02.839788Z',
};

/**
 * `GET /wallets/0xdEaD…BEEF/chains` — the R1 witness, and the most important
 * fixture in this file.
 *
 * An address with no ERC-8004 identity anywhere. The API answers **HTTP 200**
 * with `chains: []`, `global_score: null` and `distinct_raters: null`. It is a
 * RESPONSE, not an error, and it is what the A2A gate of the same service means
 * by *"That is an answer, not an error."*
 */
export const WALLET_UNRATED = {
  wallet: '0xdead00000000000000000000000000000000beef',
  chains: [],
  caveats: [],
  identity_count: 0,
  chains_with_identity: 0,
  chains_with_reputation: 0,
  total_reviews: 0,
  distinct_raters: null,
  global_score: null,
  policy_version: 'equal-weight-per-chain@2',
  source: 'chain_rankings_mv',
  refreshed_at: '2026-08-30T20:50:02.839788Z',
};

/** `GET /wallets/notawallet/chains` -> HTTP 422. The caller's bug, not an absence. */
export const NOT_AN_ADDRESS_422 = {
  detail: { error: 'not_an_address', wallet: 'notawallet' },
};

/** `GET /leaderboard?limit=2` -> HTTP 422. The route takes no parameters. */
export const LEADERBOARD_TAKES_NO_PARAMS_422 = {
  detail: {
    error: 'leaderboard_takes_no_params',
    params: ['limit'],
    paged_route: 'GET /leaderboard/page',
  },
};

/** `GET /leaderboard` — a bare array, no envelope. First two rows of 100. */
export const LEADERBOARD = [
  {
    rank: 1,
    wallet: '0x97cd97cfe21799bacbf39d0a53469e5f82f30996',
    final_score: 100.0,
    shrunk_score: 99.982977,
    distinct_raters: 7548,
    chain_count: 1,
    total_reviews: 7548,
    networks: ['monad'],
    declared_types: [null],
  },
  {
    rank: 2,
    wallet: '0x0000000000000000000000000000000000000001',
    final_score: 76.25,
    shrunk_score: 62.5,
    distinct_raters: 3,
    chain_count: 2,
    total_reviews: 3,
    networks: ['celo', 'base'],
    declared_types: [null, null],
  },
];

/** `GET /health` — trimmed to one chain; the rest of the shape is verbatim. */
export const HEALTH = {
  status: 'ok',
  policy_version: 'equal-weight-per-chain@2',
  ordering_policy: 'bayes-shrinkage-distinct-raters@1',
  rater_weight_policy: 'one-voice-per-counterparty+bounded-trust@1',
  confidence_policy: 'wilson-raters@1',
  confidence_thresholds: { no_ratings: 0, low: 1, medium: 3, high: 6 },
  reading_policy: {
    min_raters: 3,
    campaign_per_rater: 20,
    top_share: 0.5,
    self_gap: null,
    combine: 'independent',
    facet_min_distinct_agents: 4,
  },
  build_sha: '737bc1e2964599f533415a6a1910aa5ddbbc29cd',
  agents: 470193,
  feedback_entries: 552416,
  indexer_period_seconds: 3600,
  chains: [
    {
      network: 'arbitrum',
      last_scanned_block: 500064997,
      head_at_last_sync: 500065009,
      started_at: '2026-08-11T16:25:31.996475Z',
      updated_at: '2026-08-30T20:48:38.100848Z',
      last_error: null,
      newest_signature: null,
      oldest_signature: null,
      backfill_complete: false,
      next_sync_at: '2026-08-30T21:48:38.100848Z',
    },
  ],
};

/**
 * The live 402 challenge body of `GET /reputation/wallet/{w}`, trimmed to the
 * fields that decide anything (the real one carries ~4 KB of Spanish prose
 * describing the free tier). `payTo` is identical on all six `accepts[]`
 * entries; two are kept so a mismatch test has somewhere to hide a stranger.
 */
export const CHALLENGE_402 = {
  error: 'payment_required',
  recipient: '0xe4dc963c56979E0260fc146b87eE24F18220e545',
  recipients: { evm: '0xe4dc963c56979E0260fc146b87eE24F18220e545' },
  amount: '0.01',
  token: 'USDC',
  supportedChains: [8453, 43114, 42161, 10, 137, 42220],
  x402Version: 2,
  scheme: 'exact',
  resource: 'GET /reputation/wallet/0x97cd97cfe21799bacbf39d0a53469e5f82f30996',
  maxTimeoutSeconds: 120,
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '10000',
      payTo: '0xe4dc963c56979E0260fc146b87eE24F18220e545',
      maxTimeoutSeconds: 120,
      extra: { name: 'USD Coin', version: '2' },
    },
    {
      scheme: 'exact',
      network: 'eip155:43114',
      asset: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      amount: '10000',
      payTo: '0xe4dc963c56979E0260fc146b87eE24F18220e545',
      maxTimeoutSeconds: 120,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
  price_usd: '0.01',
  pricing: { version: 'cost-tiered@5', tier: 'wallet-lookup' },
};

/** A minimal but shaped `GET /reputation/wallet/{w}` 200 body. */
export const WALLET_BREAKDOWN = {
  wallet: '0x97cd97cfe21799bacbf39d0a53469e5f82f30996',
  final_score: 83.0,
  weighted_score: 81.412,
  rater_weight_policy: 'one-voice-per-counterparty+bounded-trust@1',
  chain_count: 1,
  total_reviews: 7548,
  per_chain: { monad: { score: 83.0, review_count: 7548, agent_ids: ['182'] } },
  facets: {
    'dexter:reputation': {
      score: 83.0,
      count: 7548,
      distinct_raters: 7548,
      revoked_count: 0,
      out_of_domain_count: 0,
      self_rated_count: 0,
      direction: 'about',
      direction_category: 'subject',
      direction_meaning: 'the rating is about the subject',
    },
  },
  self_rated: { count: 0, score: null, gap: null },
  concentration: { distinct_raters: 7548, top_client_share: 0.0004, top_client: '0xabc' },
  confidence: {
    band: 'high',
    distinct_raters: 7548,
    interval: { lower: 82.1, upper: 83.9 },
    thresholds: { no_ratings: 0, low: 1, medium: 3, high: 6 },
    advice: 'read `interval` before acting',
    confidence_policy: 'wilson-raters@1',
  },
  activity: { first_rating_at: '2026-08-11T00:00:00Z', last_rating_at: '2026-08-30T00:00:00Z' },
  caveats: [{ code: 'top-client-share', text: 'Un solo cliente escribió más de la mitad.' }],
  policy_version: 'equal-weight-per-chain@2',
  snapshot: null,
};
