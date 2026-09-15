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
 *
 * ⚠️ Added to on 2026-09-15 (0.4.0), at the bottom of the file and with their own
 * capture date: two free payloads fetched live that day, and one metered payload
 * that could NOT be captured and says so in its own docstring. The 2026-08-30
 * payloads above stay as they were — they are now also the witness of an API
 * that did not declare `caveats_not_computed` yet.
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

// ---------------------------------------------------------------------------
// Added 2026-09-15 (0.4.0) — `caveats_not_computed` and `ratings[].author_class`
// ---------------------------------------------------------------------------

/**
 * `GET /wallets/0x715d…4e6d/chains`, captured 2026-09-15T03:51:52Z, byte for
 * byte — the free answer DECLARING what it did not evaluate.
 *
 * `caveats: []` next to seven names in `caveats_not_computed`, on a wallet with
 * 471 distinct raters. That pair is karma-hello's finding in one payload: the
 * empty list is not "clean", it is the silence of cuts nobody ran, and since
 * describe.net 2026-09-14 the answer says so by name. It is the wallet the
 * service's own handoff uses to verify the field live
 * (`describe-net/docs/handoffs/2026-09-14-dn-reputacion-chicas.md`).
 *
 * It also carries fields this SDK does not type (`weight`, both `freshness`
 * blocks of this route). Left in on purpose: that is what `raw` is for.
 */
export const WALLET_DECLARES_NOT_COMPUTED = {
  wallet: '0x715dc035ffb97dd7bb4095c6670138ba05bb4e6d',
  chains: [
    {
      network: 'base',
      agent_count: 3,
      agent_ids: ['2284', '2290', '29368'],
      final_score: 98.192639,
      total_reviews: 648,
      distinct_raters: 471,
      weight: 0.989989,
      freshness: {
        scope: {
          kind: 'wallet',
          direction: 'received',
          id: '0x715dc035ffb97dd7bb4095c6670138ba05bb4e6d',
          network: 'base',
          declared_type: null,
        },
        last_received_feedback_at: '2026-09-13T10:51:03Z',
        last_eligible_rating_at: '2026-09-13T10:51:03Z',
        dated_feedback_count: 648,
        undated_feedback_count: 0,
        timestamp_coverage: 'complete',
        eligible_dated_count: 648,
        eligible_undated_count: 0,
        eligible_timestamp_coverage: 'complete',
        refreshed_at: '2026-09-15T03:49:40.897482Z',
        indexer_checked_at: '2026-09-15T03:48:37.527788Z',
        freshness_version: 'freshness@1',
      },
    },
  ],
  caveats: [],
  caveats_not_computed: [
    'campaign-per-rater',
    'concentration-degraded',
    'few-raters',
    'no-score',
    'self-rated',
    'single-rater',
    'top-client-share',
  ],
  identity_count: 3,
  chains_with_identity: 1,
  chains_with_reputation: 1,
  total_reviews: 648,
  distinct_raters: 471,
  global_score: 98.192639,
  policy_version: 'credibility-weight-per-chain@1',
  source: 'chain_rankings_mv',
  refreshed_at: '2026-09-15T03:49:40.897482Z',
  freshness: {
    scope: {
      kind: 'wallet',
      direction: 'received',
      id: '0x715dc035ffb97dd7bb4095c6670138ba05bb4e6d',
      network: null,
      declared_type: null,
    },
    last_received_feedback_at: '2026-09-13T10:51:03Z',
    last_eligible_rating_at: '2026-09-13T10:51:03Z',
    dated_feedback_count: 648,
    undated_feedback_count: 0,
    timestamp_coverage: 'complete',
    eligible_dated_count: 648,
    eligible_undated_count: 0,
    eligible_timestamp_coverage: 'complete',
    refreshed_at: '2026-09-15T03:49:40.897482Z',
    indexer_checked_at: '2026-09-15T03:48:37.527788Z',
    freshness_version: 'freshness@1',
  },
};

/**
 * `GET /wallets/0xdEaD…bEeF/chains` (the all-`deadbeef` address), same capture —
 * no identity anywhere, and the SAME seven names. The declaration depends on
 * what the route evaluates, never on the subject.
 */
export const WALLET_UNRATED_DECLARES_NOT_COMPUTED = {
  wallet: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  chains: [],
  caveats: [],
  caveats_not_computed: [
    'campaign-per-rater',
    'concentration-degraded',
    'few-raters',
    'no-score',
    'self-rated',
    'single-rater',
    'top-client-share',
  ],
  identity_count: 0,
  chains_with_identity: 0,
  chains_with_reputation: 0,
  total_reviews: 0,
  distinct_raters: null,
  global_score: null,
  policy_version: 'credibility-weight-per-chain@1',
  source: 'chain_rankings_mv',
  refreshed_at: '2026-09-15T03:49:40.897482Z',
  freshness: {
    scope: {
      kind: 'wallet',
      direction: 'received',
      id: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      network: null,
      declared_type: null,
    },
    last_received_feedback_at: null,
    last_eligible_rating_at: null,
    dated_feedback_count: 0,
    undated_feedback_count: 0,
    timestamp_coverage: 'none',
    eligible_dated_count: 0,
    eligible_undated_count: 0,
    eligible_timestamp_coverage: 'none',
    refreshed_at: '2026-09-15T03:49:40.897482Z',
    indexer_checked_at: '2026-09-15T03:48:37.527788Z',
    freshness_version: 'freshness@1',
  },
};

/**
 * A `GET /reputation/agent/{network}/{agent_id}` 200 body with one row of each
 * author class.
 *
 * ⚠️ NOT captured, and this says so instead of hiding it: the route is metered
 * ($0.02) and no test in this repository may spend USDC, so no live row could be
 * fetched. The rows are SHAPED from the live schema instead —
 * `components.schemas.Rating` of `https://api.describe.net/openapi.json`, read
 * 2026-09-15, every required field present (the snapshot in `schema/` holds that
 * copy). The one real value is the facilitator row's `client`: the public EOA the
 * index classifies as `facilitator-authored` (`describenet/rating_roles.py`,
 * `FACILITATOR_AUTHORS`). The agent id, the other `client`, the hashes and the
 * values are shaped, not real. The caveat text is the server's own literal
 * (`describenet/caveats.py:614`, `_facilitator_caveat`).
 */
export const AGENT_WITH_AUTHOR_CLASSES = {
  network: 'base',
  agent_id: '42',
  current_owner: '0x7a3b9c2d4e5f60718293a4b5c6d7e8f901234567',
  declared_type: null,
  score: 90.0,
  review_count: 2,
  revoked_count: 0,
  out_of_domain_count: 0,
  ratings: [
    {
      client: '0x103040545AC5031A11E8C03dd11324C7333a13C7',
      author_class: 'facilitator-authored',
      feedback_index: 1,
      value: 90,
      value_decimals: 0,
      normalized_value: 90.0,
      tag1: 'trust',
      tag2: null,
      is_revoked: false,
      is_self: false,
      tx_hash: `0x${'1a'.repeat(32)}`,
      block_number: 34000000,
      log_index: 7,
      feedback_uri: null,
      feedback_hash: `0x${'00'.repeat(32)}`,
      revoked_tx: null,
    },
    {
      client: '0x2b6c1d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8',
      author_class: 'rater-authored',
      feedback_index: 1,
      value: 90,
      value_decimals: 0,
      normalized_value: 90.0,
      tag1: 'trust',
      tag2: null,
      is_revoked: false,
      is_self: false,
      tx_hash: `0x${'2b'.repeat(32)}`,
      block_number: 34000100,
      log_index: 3,
      feedback_uri: null,
      feedback_hash: `0x${'00'.repeat(32)}`,
      revoked_tx: null,
    },
  ],
  caveats: [
    {
      code: 'facilitator-authored',
      text:
        'Hay ratings en `ratings[]` con `author_class: facilitator-authored`: los ' +
        'firmó la wallet del facilitador que los relayó, así que su `client` NO ' +
        'es la contraparte que calificó. Todos comparten ese mismo `client`, y ' +
        'cualquier conteo por calificador —`concentration.distinct_raters`, ' +
        '`top_client_share`— los junta en UNA sola persona aunque detrás pueda ' +
        'haber varias. Filtrá por `author_class` antes de leer quién calificó.',
    },
  ],
  policy_version: 'credibility-weight-per-chain@1',
};

// ---------------------------------------------------------------------------
// Added 2026-09-15 (0.4.1) — `thin-chain` on the free route
// ---------------------------------------------------------------------------

/**
 * `GET /wallets/0x7052…402b/chains`, captured 2026-09-15T04:54:23Z, byte for
 * byte — a FREE answer that fires `thin-chain`.
 *
 * Three scored chains (arbitrum 2 raters, avalanche 1, base 1) and two identities
 * with no ratings (celo, polygon), which do not count as chains for the cut. The
 * free route evaluates `burn-address` and `thin-chain`, so neither is in
 * `caveats_not_computed`: the same seven names as the payloads above.
 */
export const WALLET_FREE_THIN_CHAIN = {
  wallet: '0x7052ca449702e5ffafbe3dc63b74c7b7d8af402b',
  chains: [
    {
      network: 'arbitrum',
      agent_count: 1,
      agent_ids: ['1257'],
      final_score: 88.75,
      total_reviews: 32,
      distinct_raters: 2,
      weight: 0.295727,
      freshness: {
        scope: {
          kind: 'wallet',
          direction: 'received',
          id: '0x7052ca449702e5ffafbe3dc63b74c7b7d8af402b',
          network: 'arbitrum',
          declared_type: null,
        },
        last_received_feedback_at: '2026-09-11T04:31:04Z',
        last_eligible_rating_at: '2026-09-11T04:31:04Z',
        dated_feedback_count: 32,
        undated_feedback_count: 0,
        timestamp_coverage: 'complete',
        eligible_dated_count: 32,
        eligible_undated_count: 0,
        eligible_timestamp_coverage: 'complete',
        refreshed_at: '2026-09-15T04:49:41.197723Z',
        indexer_checked_at: '2026-09-15T04:48:38.291834Z',
        freshness_version: 'freshness@1',
      },
    },
    {
      network: 'avalanche',
      agent_count: 1,
      agent_ids: ['1806'],
      final_score: 94.0,
      total_reviews: 6,
      distinct_raters: 1,
      weight: 0.173521,
      freshness: {
        scope: {
          kind: 'wallet',
          direction: 'received',
          id: '0x7052ca449702e5ffafbe3dc63b74c7b7d8af402b',
          network: 'avalanche',
          declared_type: null,
        },
        last_received_feedback_at: '2026-09-11T16:10:41Z',
        last_eligible_rating_at: '2026-09-11T16:10:41Z',
        dated_feedback_count: 6,
        undated_feedback_count: 0,
        timestamp_coverage: 'complete',
        eligible_dated_count: 6,
        eligible_undated_count: 0,
        eligible_timestamp_coverage: 'complete',
        refreshed_at: '2026-09-15T04:49:41.197723Z',
        indexer_checked_at: '2026-09-15T04:48:38.567134Z',
        freshness_version: 'freshness@1',
      },
    },
    {
      network: 'base',
      agent_count: 1,
      agent_ids: ['59622'],
      final_score: 86.2,
      total_reviews: 5,
      distinct_raters: 1,
      weight: 0.173521,
      freshness: {
        scope: {
          kind: 'wallet',
          direction: 'received',
          id: '0x7052ca449702e5ffafbe3dc63b74c7b7d8af402b',
          network: 'base',
          declared_type: null,
        },
        last_received_feedback_at: '2026-07-25T07:09:45Z',
        last_eligible_rating_at: '2026-07-25T07:09:45Z',
        dated_feedback_count: 5,
        undated_feedback_count: 0,
        timestamp_coverage: 'complete',
        eligible_dated_count: 5,
        eligible_undated_count: 0,
        eligible_timestamp_coverage: 'complete',
        refreshed_at: '2026-09-15T04:49:41.197723Z',
        indexer_checked_at: '2026-09-15T04:48:37.661958Z',
        freshness_version: 'freshness@1',
      },
    },
    {
      network: 'celo',
      agent_count: 1,
      agent_ids: ['9724'],
      final_score: null,
      total_reviews: 0,
      distinct_raters: 0,
      weight: null,
      freshness: {
        scope: {
          kind: 'wallet',
          direction: 'received',
          id: '0x7052ca449702e5ffafbe3dc63b74c7b7d8af402b',
          network: 'celo',
          declared_type: null,
        },
        last_received_feedback_at: null,
        last_eligible_rating_at: null,
        dated_feedback_count: 0,
        undated_feedback_count: 0,
        timestamp_coverage: 'none',
        eligible_dated_count: 0,
        eligible_undated_count: 0,
        eligible_timestamp_coverage: 'none',
        refreshed_at: '2026-09-15T04:49:41.197723Z',
        indexer_checked_at: '2026-09-15T04:48:38.703406Z',
        freshness_version: 'freshness@1',
      },
    },
    {
      network: 'polygon',
      agent_count: 1,
      agent_ids: ['626'],
      final_score: null,
      total_reviews: 0,
      distinct_raters: 0,
      weight: null,
      freshness: {
        scope: {
          kind: 'wallet',
          direction: 'received',
          id: '0x7052ca449702e5ffafbe3dc63b74c7b7d8af402b',
          network: 'polygon',
          declared_type: null,
        },
        last_received_feedback_at: null,
        last_eligible_rating_at: null,
        dated_feedback_count: 0,
        undated_feedback_count: 0,
        timestamp_coverage: 'none',
        eligible_dated_count: 0,
        eligible_undated_count: 0,
        eligible_timestamp_coverage: 'none',
        refreshed_at: '2026-09-15T04:49:41.197723Z',
        indexer_checked_at: '2026-09-15T04:48:38.095398Z',
        freshness_version: 'freshness@1',
      },
    },
  ],
  caveats: [
    {
      code: 'thin-chain',
      text: 'CADENAS FLACAS: avalanche (1 calificador, peso 0.17), base (1 calificador, peso 0.17), arbitrum (2 calificadores, peso 0.30). El peso de una cadena en el score global es `calificadores / (calificadores + m)` con el m congelado en la política, así que una cadena sostenida por una sola persona pesa poco pero NUNCA cero: sigue moviendo el número. Leé la composición por cadena antes que el global.',
    },
  ],
  caveats_not_computed: [
    'campaign-per-rater',
    'concentration-degraded',
    'few-raters',
    'no-score',
    'self-rated',
    'single-rater',
    'top-client-share',
  ],
  identity_count: 5,
  chains_with_identity: 5,
  chains_with_reputation: 3,
  total_reviews: 43,
  distinct_raters: 2,
  global_score: 89.478888,
  policy_version: 'credibility-weight-per-chain@1',
  source: 'chain_rankings_mv',
  refreshed_at: '2026-09-15T04:49:41.197723Z',
  freshness: {
    scope: {
      kind: 'wallet',
      direction: 'received',
      id: '0x7052ca449702e5ffafbe3dc63b74c7b7d8af402b',
      network: null,
      declared_type: null,
    },
    last_received_feedback_at: '2026-09-11T16:10:41Z',
    last_eligible_rating_at: '2026-09-11T16:10:41Z',
    dated_feedback_count: 43,
    undated_feedback_count: 0,
    timestamp_coverage: 'complete',
    eligible_dated_count: 43,
    eligible_undated_count: 0,
    eligible_timestamp_coverage: 'complete',
    refreshed_at: '2026-09-15T04:49:41.197723Z',
    indexer_checked_at: '2026-09-15T04:48:37.661958Z',
    freshness_version: 'freshness@1',
  },
};
