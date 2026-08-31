/**
 * Wire JSON → typed shape.
 *
 * Three rules, and each one is a bug that already happened somewhere:
 *
 * 1. **`null` survives.** `optNumber` returns `null` for `null` and NEVER `0`.
 *    Every `|| 0` in a parser is an invariant-7 violation waiting for its first
 *    unrated wallet.
 * 2. **Unknown fields survive.** Every result keeps `raw`. The server may add a
 *    field tomorrow and a consumer must not wait for our release to read it.
 * 3. **A body that is not the shape we asked for is `unparseable`, not
 *    garbage-in-silence.** The failure that has to be impossible here is a
 *    response that parses "successfully" into an object full of zeros.
 * 4. **A hash field that is not a hash is dropped and MARKED, never passed
 *    through.** Added 2026-08-30 from KarmaKadabra's *"el 200 sin tx"*. The
 *    typed field goes `null` — nobody builds an explorer link out of garbage —
 *    and its wire name goes into the `malformedHashes` of the object that owns
 *    it, so that **absent** (`null`, list empty) stays distinguishable from
 *    **malformed** (`null`, name in the list). It is rule 1 one level down: the
 *    absence of a value and a value that is nonsense are different facts, and
 *    collapsing them is the failure this file exists to prevent. See
 *    `hashes.ts`, and `client.ts` for how the fact reaches the caller.
 */

import { CAVEAT_SCOPE_FREE, CAVEAT_SCOPE_METERED, type Caveat } from './caveats';
import { DescribeUnparseable } from './errors';
import { hashField } from './hashes';
import type {
  Activity,
  AgentReputation,
  Concentration,
  Confidence,
  Facet,
  HealthChain,
  IndexHealth,
  LeaderboardRow,
  Ownership,
  PaymentEvidence,
  Rating,
  SelfRated,
  Snapshot,
  WalletBreakdown,
  WalletChainRow,
  WalletReputation,
} from './types';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `null` in, `null` out. The single most load-bearing line of this file.
 *
 * A missing score is `null`; a present score is a number. There is no third
 * branch, and in particular there is no branch that produces `0`.
 *
 * Verified discriminant on 2026-08-30 by mounting the bad state: replacing the
 * body below with `Number(v ?? 0)` turns three tests in `client.test.ts`
 * ("R1 — null never 0") red, including the one that asserts an unrated wallet
 * stays distinguishable from a wallet actually scored zero. A green suite with
 * this function broken is not reachable, which is the only reason to trust the
 * green one.
 */
function optNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function optString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function strArray(v: unknown): string[] | null {
  return Array.isArray(v) ? v.map(String) : null;
}

/**
 * Caveats, keeping BOTH halves.
 *
 * EM's Python reference keeps only the `code` (`types.py:269-273`) so nobody
 * can render the volatile prose. That is right for a reconciler and wrong for
 * an SDK: a UI has to print SOMETHING, and if we drop `text` every consumer
 * re-writes the eight strings by hand — the duplication this package exists to
 * remove, and in the one field the index says may change without notice. So we
 * carry both and the docs say which is the contract (`caveats.ts`).
 *
 * An entry that is not `{code, text}` is dropped rather than guessed at: a
 * caveat we cannot name is a caveat we cannot let anyone branch on.
 */
function parseCaveats(v: unknown): Caveat[] {
  if (!Array.isArray(v)) return [];
  const out: Caveat[] = [];
  for (const entry of v) {
    if (isObj(entry) && typeof entry.code === 'string') {
      out.push({ code: entry.code, text: typeof entry.text === 'string' ? entry.text : '' });
    }
  }
  return out;
}

function parseFacets(v: unknown): Record<string, Facet> {
  if (!isObj(v)) return {};
  const out: Record<string, Facet> = {};
  for (const [key, raw] of Object.entries(v)) {
    if (!isObj(raw)) continue;
    out[key] = {
      score: optNumber(raw.score),
      count: num(raw.count),
      distinctRaters: num(raw.distinct_raters),
      revokedCount: num(raw.revoked_count),
      outOfDomainCount: num(raw.out_of_domain_count),
      selfRatedCount: num(raw.self_rated_count),
      direction: optString(raw.direction),
      directionCategory: optString(raw.direction_category),
      directionMeaning: optString(raw.direction_meaning),
    };
  }
  return out;
}

function parseSelfRated(v: unknown): SelfRated | null {
  if (!isObj(v)) return null;
  return { count: num(v.count), score: optNumber(v.score), gap: optNumber(v.gap) };
}

function parseConcentration(v: unknown): Concentration | null {
  if (!isObj(v)) return null;
  return {
    distinctRaters: num(v.distinct_raters),
    topClientShare: optNumber(v.top_client_share),
    topClient: optString(v.top_client),
  };
}

function parseConfidence(v: unknown): Confidence | null {
  if (!isObj(v)) return null;
  const iv = v.interval;
  return {
    band: String(v.band ?? ''),
    distinctRaters: num(v.distinct_raters),
    interval: isObj(iv) ? { lower: num(iv.lower), upper: num(iv.upper) } : null,
    thresholds: isObj(v.thresholds) ? (v.thresholds as Record<string, number>) : {},
    advice: String(v.advice ?? ''),
    confidencePolicy: String(v.confidence_policy ?? ''),
  };
}

function parseActivity(v: unknown): Activity | null {
  if (!isObj(v)) return null;
  return { firstRatingAt: optString(v.first_rating_at), lastRatingAt: optString(v.last_rating_at) };
}

function parseSnapshot(v: unknown): Snapshot | null {
  if (!isObj(v)) return null;
  const malformed: string[] = [];
  return {
    id: num(v.id),
    // A bare sha256 hexdigest, no `0x` (`aggregate.py:1920`). This one is worth
    // validating precisely because it is the citable field: two snapshots with
    // the same digest are supposed to say the same thing, and a comparison
    // between two garbage strings can agree by accident.
    inputsDigest: hashField(v, 'inputs_digest', malformed),
    policyVersion: String(v.policy_version ?? ''),
    computedAt: String(v.computed_at ?? ''),
    malformedHashes: malformed,
  };
}

function parseOwnership(v: unknown): Ownership | null {
  if (!isObj(v)) return null;
  return {
    ownerUpdatedBlock: num(v.owner_updated_block),
    identityTransferred: typeof v.identity_transferred === 'boolean' ? v.identity_transferred : null,
    inheritedReviewCount: num(v.inherited_review_count),
    inheritedScore: optNumber(v.inherited_score),
    currentEraReviewCount: num(v.current_era_review_count),
    currentEraScore: optNumber(v.current_era_score),
    undeterminedReviewCount: num(v.undetermined_review_count),
    inheritedShare: optNumber(v.inherited_share),
  };
}

/**
 * One rating, with its THREE hash fields shape-validated.
 *
 * KarmaKadabra's contribution (2026-08-30): a `tx_hash` that is not a hash is a
 * 200 that did not do the thing, and *"si nosotros no chequeáramos el tx,
 * habríamos contado 14 ratings que no existen"*. Anything that is not a hash
 * becomes `null` and its wire name goes into the rating's `malformedHashes` —
 * never an exception, because one bad accessory field must not destroy a
 * decomposition the caller paid for. See `hashes.ts` for the four legitimate
 * shapes and for why an EVM-only regex would have flagged all of Solana.
 */
function parseRatings(v: unknown): Rating[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((r) => {
    const malformed: string[] = [];
    return {
      client: String(r.client ?? ''),
      feedbackIndex: num(r.feedback_index),
      value: num(r.value),
      valueDecimals: num(r.value_decimals),
      normalizedValue: optNumber(r.normalized_value),
      tag1: optString(r.tag1),
      tag2: optString(r.tag2),
      isRevoked: r.is_revoked === true,
      isSelf: r.is_self === true,
      txHash: hashField(r, 'tx_hash', malformed),
      blockNumber: optNumber(r.block_number),
      logIndex: optNumber(r.log_index),
      feedbackUri: optString(r.feedback_uri),
      issuerHost: optString(r.issuer_host),
      issuer: optString(r.issuer),
      issuerOrg: optString(r.issuer_org),
      feedbackHash: hashField(r, 'feedback_hash', malformed),
      revokedTx: hashField(r, 'revoked_tx', malformed),
      malformedHashes: malformed,
    };
  });
}

// ---------------------------------------------------------------------------

/** `GET /wallets/{wallet}/chains`. Requires `wallet` — everything else may be absent. */
export function parseWalletReputation(payload: unknown): WalletReputation {
  if (!isObj(payload) || typeof payload.wallet !== 'string') {
    throw new DescribeUnparseable('wallet-chains response is missing its essential shape (wallet)');
  }
  const rows = Array.isArray(payload.chains) ? payload.chains : [];
  const chains: WalletChainRow[] = rows.filter(isObj).map((row) => ({
    network: String(row.network ?? ''),
    agentCount: num(row.agent_count),
    agentIds: strArray(row.agent_ids),
    finalScore: optNumber(row.final_score),
    totalReviews: num(row.total_reviews),
    distinctRaters: num(row.distinct_raters),
  }));

  return {
    wallet: payload.wallet,
    chains,
    globalScore: optNumber(payload.global_score),
    distinctRaters: optNumber(payload.distinct_raters),
    identityCount: num(payload.identity_count),
    chainsWithIdentity: num(payload.chains_with_identity),
    chainsWithReputation: num(payload.chains_with_reputation),
    totalReviews: num(payload.total_reviews),
    policyVersion: optString(payload.policy_version),
    caveats: parseCaveats(payload.caveats),
    caveatScope: CAVEAT_SCOPE_FREE,
    source: optString(payload.source),
    refreshedAt: optString(payload.refreshed_at),
    raw: payload,
  };
}

/** `GET /reputation/wallet/{wallet}` — metered. */
export function parseWalletBreakdown(
  payload: unknown,
  payment: PaymentEvidence | null,
): WalletBreakdown {
  if (!isObj(payload) || typeof payload.wallet !== 'string') {
    throw new DescribeUnparseable('wallet-breakdown response is missing its essential shape (wallet)');
  }
  return {
    wallet: payload.wallet,
    finalScore: optNumber(payload.final_score),
    weightedScore: optNumber(payload.weighted_score),
    raterWeightPolicy: String(payload.rater_weight_policy ?? ''),
    chainCount: num(payload.chain_count),
    totalReviews: num(payload.total_reviews),
    perChain: isObj(payload.per_chain) ? payload.per_chain : {},
    facets: parseFacets(payload.facets),
    selfRated: parseSelfRated(payload.self_rated),
    concentration: parseConcentration(payload.concentration),
    confidence: parseConfidence(payload.confidence),
    activity: parseActivity(payload.activity),
    snapshot: parseSnapshot(payload.snapshot),
    payment,
    policyVersion: optString(payload.policy_version),
    caveats: parseCaveats(payload.caveats),
    caveatScope: CAVEAT_SCOPE_METERED,
    source: optString(payload.source),
    refreshedAt: optString(payload.refreshed_at),
    raw: payload,
  };
}

/** `GET /reputation/agent/{network}/{agent_id}` — metered. */
export function parseAgentReputation(
  payload: unknown,
  payment: PaymentEvidence | null,
): AgentReputation {
  if (!isObj(payload) || payload.agent_id === undefined) {
    throw new DescribeUnparseable('agent response is missing its essential shape (agent_id)');
  }
  return {
    network: String(payload.network ?? ''),
    agentId: String(payload.agent_id),
    currentOwner: optString(payload.current_owner),
    declaredType: optString(payload.declared_type),
    agentUri: optString(payload.agent_uri),
    indexedIdentity: payload.indexed_identity === true,
    score: optNumber(payload.score),
    reviewCount: num(payload.review_count),
    revokedCount: num(payload.revoked_count),
    outOfDomainCount: num(payload.out_of_domain_count),
    selfRated: parseSelfRated(payload.self_rated),
    facets: parseFacets(payload.facets),
    concentration: parseConcentration(payload.concentration),
    ownership: parseOwnership(payload.ownership),
    confidence: parseConfidence(payload.confidence),
    ratings: parseRatings(payload.ratings),
    payment,
    policyVersion: optString(payload.policy_version),
    caveats: parseCaveats(payload.caveats),
    caveatScope: CAVEAT_SCOPE_METERED,
    source: optString(payload.source),
    refreshedAt: optString(payload.refreshed_at),
    raw: payload,
  };
}

/**
 * `GET /leaderboard` — a bare JSON array (verified live 2026-08-30: 100 rows,
 * no envelope). NOT `{rows: [...]}`, which is what a reader expecting a
 * paginated shape would assume.
 */
export function parseLeaderboard(payload: unknown): LeaderboardRow[] {
  if (!Array.isArray(payload)) {
    throw new DescribeUnparseable('leaderboard response is not an array');
  }
  return payload.filter(isObj).map((row) => ({
    rank: num(row.rank),
    wallet: String(row.wallet ?? ''),
    finalScore: optNumber(row.final_score),
    shrunkScore: optNumber(row.shrunk_score),
    distinctRaters: num(row.distinct_raters),
    chainCount: num(row.chain_count),
    totalReviews: num(row.total_reviews),
    networks: Array.isArray(row.networks) ? row.networks.map(String) : [],
    declaredTypes: Array.isArray(row.declared_types)
      ? row.declared_types.map((t) => (typeof t === 'string' ? t : null))
      : [],
    raw: row,
  }));
}

/** `GET /health`. */
export function parseHealth(payload: unknown): IndexHealth {
  if (!isObj(payload) || typeof payload.status !== 'string') {
    throw new DescribeUnparseable('health response is missing its essential shape (status)');
  }
  const chains: HealthChain[] = (Array.isArray(payload.chains) ? payload.chains : [])
    .filter(isObj)
    .map((row) => ({
      network: String(row.network ?? ''),
      lastScannedBlock: optNumber(row.last_scanned_block),
      updatedAt: optString(row.updated_at),
      nextSyncAt: optString(row.next_sync_at),
      lastError: optString(row.last_error),
      raw: row,
    }));

  return {
    status: payload.status,
    policyVersion: String(payload.policy_version ?? ''),
    orderingPolicy: String(payload.ordering_policy ?? ''),
    raterWeightPolicy: String(payload.rater_weight_policy ?? ''),
    confidencePolicy: String(payload.confidence_policy ?? ''),
    confidenceThresholds: isObj(payload.confidence_thresholds)
      ? (payload.confidence_thresholds as Record<string, number>)
      : {},
    readingPolicy: isObj(payload.reading_policy) ? payload.reading_policy : {},
    buildSha: optString(payload.build_sha),
    agents: num(payload.agents),
    feedbackEntries: num(payload.feedback_entries),
    indexerPeriodSeconds: optNumber(payload.indexer_period_seconds),
    chains,
    raw: payload,
  };
}
