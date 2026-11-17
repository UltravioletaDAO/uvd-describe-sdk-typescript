/**
 * The wire shapes — hand-written, and here is the argument for that.
 *
 * ## Why not generated from the OpenAPI
 *
 * The schema is live, complete (20 paths, `securitySchemes.x402`, every field
 * typed) and generating from it would tie these types to it for free. It was
 * measured and rejected for three reasons, in increasing order of weight:
 *
 * 1. **Surface.** This SDK wraps 4 of the 20 paths. `openapi.snapshot.json`
 *    carries 41 component schemas; generating produces every one of them, so a
 *    package whose whole public surface is six methods would ship ~40
 *    interfaces nobody reviewed. Unreviewed code in a package other people
 *    install is a liability, not a saving.
 *
 * 2. **A build dependency for a package that has none.** The whole dependency
 *    argument of this SDK is that a free-only consumer installs nothing. Adding
 *    a generator plus its runtime to make that true is a strange trade.
 *
 * 3. **And the real one: the schema cannot say what matters here.** It says
 *    `global_score: number | null`. It does NOT say that the `null` means "no
 *    evidence" and must never be coerced to `0` — which is the single most
 *    important fact about this API, the invariant the index is built around,
 *    and the thing every consumer gets wrong first. Generated types carry no
 *    docstring, so the schema's shape would be pinned and the product's thesis
 *    would be nowhere. In this package the comment IS the deliverable.
 *
 * ## What replaces generation
 *
 * The third way: hand-written types PLUS a test that compares them against the
 * schema, at two speeds.
 *
 *   * `types.schema.test.ts` runs in the normal loop, offline, against
 *     `schema/openapi.json` — describe.net's committed spec, vendored (until
 *     2026-09-28, `schema/openapi.snapshot.json`, a pinned copy of the live
 *     schema fetched 2026-08-30). It fails when a hand-written type drifts
 *     from the schema.
 *   * `npm run schema:check` re-fetches the live schema and diffs it against
 *     the vendored spec. It fails when the SERVER moves. Deliberate, networked, and
 *     never in the test loop (tests do not touch the network).
 *
 * Two gates because there are two different failures: we drifted, and they
 * moved. Generation conflates them into "the build broke" and tells you
 * nothing about which happened.
 */

import type { AuthorClass, Caveat, CaveatCode } from './caveats';

/** The eleven indexed chains are strings on the wire. Never an enum here: the index adds chains. */
export type Network = string;

/** ISO-8601 as served. `null` means "not recorded" — never "just now". */
export type Timestamp = string | null;

/**
 * The receipt headers describe.net's paywall has been emitting since
 * 2026-08-25 and that, as of 2026-08-30, NO client reads.
 *
 * `X-Payment-Receipt` is the settlement id; `X-Payment-Reused` says the call
 * was served against a receipt already settled rather than a fresh payment.
 * Surfacing them is the point: without them a caller who paid has no local
 * record of having paid, and cannot tell a re-served response from a second
 * charge. Present only on metered responses that actually went through payment.
 */
export interface PaymentEvidence {
  /**
   * The settlement transaction hash, or `null` — when none was served, when
   * what was served was not one (`malformedHashes` tells those two apart), or
   * when the seller answered the literal `pending` (`settlementPending` tells
   * THAT one apart).
   *
   * Validated with its own rule (`hashes.looksLikeSettlementReceipt`) because
   * this is the one field where `"pending"` is a legitimate value on the wire:
   * the live OpenAPI declares the header as the settlement transaction hash
   * *"or `pending` if settlement has not reported one"*. Treating it as
   * garbage would fire an alarm on the happy path of every fresh payment.
   *
   * ⚠️ Legitimate on the WIRE, never in this field — corrected 2026-08-31,
   * from Execution Market's INC-2026-08-26: until then `pending` passed
   * through here, i.e. a placeholder riding in the field meant for the hash,
   * which is exactly what gets archived as proof by anyone who stores this
   * value. Now the sentinel is translated to `null` + `settlementPending:
   * true` at the door, and no consumer ever has to string-compare against it.
   */
  receipt: string | null;
  /**
   * `true` only when `X-Payment-Receipt` was the literal `pending`: the seller
   * charged and settlement has not reported the hash yet. Not garbage (no
   * mark in `malformedHashes`, no alarm) and not a receipt either. Read the
   * state HERE — `receipt === 'pending'` can no longer be true, on purpose.
   */
  settlementPending: boolean;
  reused: boolean;
  /**
   * `['receipt']` when the header carried something that is neither a hash nor
   * `pending`. Empty in the normal case, and empty when no header came at all.
   *
   * ⚠️ This is the one malformed value that does NOT survive in a result's
   * `raw`, and the reason is structural: `raw` is the response BODY and this
   * arrived as a header. So the offending string is put in the `onFailure`
   * message instead — it is the only place it can be kept.
   */
  malformedHashes: string[];
}

/**
 * Every result of this SDK carries its composition seal.
 *
 * R2 and it is the product's thesis, not a convention: *"un score sin sus
 * calificadores es un rumor"*. There is deliberately NO method here that
 * returns a bare `number`, and adding one would erase the reason the index
 * exists. If you want the number alone you take it off the object by hand, and
 * that friction is the feature.
 *
 * `policyVersion` travels because a score is only comparable to another score
 * under the SAME policy: KarmaKadabra measured its flagship wallet going
 * 86.33 → 81.41 with MORE reviews, purely because the policy revised. Two
 * numbers from different `policy_version`s are not two measurements of one
 * thing.
 */
export interface Sealed {
  /** e.g. `equal-weight-per-chain@2`. Compare scores only within one value of this. */
  policyVersion: string | null;
  /** Advisory. Branch on `code`, render `text`. Never moves a score. */
  caveats: Caveat[];
  /** `public-data-subset` on free routes, `full` on metered ones. */
  caveatScope: string;
  /** Which route produced this — `chain_rankings_mv`, a matview name, etc. */
  source: string | null;
  /** When the index last recomputed the value. `null` = not recorded. */
  refreshedAt: Timestamp;
  /** The exact JSON as served, unmodified. See `raw` below. */
  raw: Record<string, unknown>;
}

/**
 * `raw` on every result is the passthrough rule made concrete.
 *
 * Tipar lo conocido, CONSERVAR lo que no. The measured lesson is
 * `Facet.direction`: a field the server was serving got dropped by a layer that
 * had not declared it, and the response came back 200, correctly shaped, with
 * the data gone. A typed field that this SDK version has not heard of yet is
 * still in `raw`, so a consumer is never blocked on our release cycle to read
 * something describe.net already publishes.
 */

// ---------------------------------------------------------------------------
// GET /wallets/{wallet}/chains — free, and the one every surface calls
// ---------------------------------------------------------------------------

/** One chain's row of a wallet's reputation. */
export interface WalletChainRow {
  network: Network;
  agentCount: number;
  agentIds: string[] | null;
  /**
   * 🔴 `null`, NEVER `0`. "No eligible ratings here" and "rated badly" are
   * different facts and the index refuses to collapse them. A `0` asserts the
   * second where the API asserted the first.
   */
  finalScore: number | null;
  totalReviews: number;
  distinctRaters: number;
}

/**
 * `GET /wallets/{wallet}/chains` — the free per-wallet answer.
 *
 * Verified live 2026-08-30 against an address with no identity
 * (`0xdEaD…BEEF`): **HTTP 200**, `chains: []`, `global_score: null`,
 * `distinct_raters: null`. That is a RESPONSE, not an error — the A2A gate of
 * the same service says it in its own voice: *"That is an answer, not an
 * error."* This SDK never throws for it (R1, R4).
 */
export interface WalletReputation extends Sealed {
  /** As served. EVM is normalised server-side; Solana base58 is case-SENSITIVE. */
  wallet: string;
  chains: WalletChainRow[];
  /**
   * Mean of the per-chain means — one chain, one vote. `null` when there is no
   * eligible rating anywhere. Full precision: format with `formatScore`.
   */
  globalScore: number | null;
  /**
   * `COUNT(DISTINCT client)` across every chain AND every identity, so a rater
   * who reviewed on two chains counts once.
   *
   * `null` when the index has nothing to count — and the difference from `0`
   * matters: MeshRelay measured that taking the per-chain MAXIMUM instead
   * reports 4 for a wallet with 3 raters on base and 4 different ones on
   * avalanche (7 distinct counterparties), and that SUMMING double-counts
   * whoever rated on more than one chain (karma-hello reads 9 globally while
   * the per-chain figures add to 11). Neither reconstruction is correct; this
   * field is.
   */
  distinctRaters: number | null;
  identityCount: number;
  chainsWithIdentity: number;
  chainsWithReputation: number;
  totalReviews: number;
  /**
   * The caveat codes that the paid decomposition evaluates and THIS free answer
   * did not — sorted, served since describe.net 2026-09-14
   * (`describenet/caveats.py:525-532`, `not_computed_public`, derived from the
   * same module that builds `caveats`). **Names, never outcomes**: whether any of
   * them fires for this wallet is exactly what stays paid.
   *
   * Seven codes on 2026-09-15, for a wallet with 471 raters and for `0xdead…beef`
   * alike — the declaration depends on what the route evaluates, not on the
   * subject. Read it live; the count is not a constant.
   *
   * 🔴 **Three states, and they stay three:**
   *
   * ```
   *   ['few-raters', …]  NOT evaluated here — read each one as UNVERIFIED, never as passed
   *   []                 the answer says it evaluated every wallet-scope cut
   *   null               nothing readable was declared: a server older than 2026-09-14,
   *                      a payload stored before then, or a value that is not a list
   *                      of non-empty strings. NOT `[]` — nothing was promised, and
   *                      `caveatScope` still says what was evaluated
   * ```
   *
   * The failure this field closes is karma-hello's (2026-08-31): a quality gate
   * built on this route passed every wallet, because `caveats: []` here is the
   * silence of cuts that were never run. Do not gate on it by hand —
   * `requireFullCaveats()` is the gate, and it reads the `null` correctly.
   */
  caveatsNotComputed: CaveatCode[] | null;
}

// ---------------------------------------------------------------------------
// GET /reputation/wallet/{wallet} — metered, $0.01
// ---------------------------------------------------------------------------

/** How lopsided the evidence is. `null` when there is not enough to say. */
export interface Concentration {
  distinctRaters: number;
  /** Share of ratings written by the single loudest client, 0..1. */
  topClientShare: number | null;
  topClient: string | null;
}

/** Wilson interval over distinct raters. Read `interval` before acting on `band`. */
export interface Confidence {
  /** `no_ratings` | `low` | `medium` | `high` — the server's own bands. */
  band: string;
  distinctRaters: number;
  interval: { lower: number; upper: number } | null;
  /** The cut points, published live so nobody re-types them. */
  thresholds: Record<string, number>;
  advice: string;
  confidencePolicy: string;
}

export interface SelfRated {
  count: number;
  score: number | null;
  /** Distance between the self-rating and everyone else's. */
  gap: number | null;
}

/**
 * First and last rating by ON-CHAIN time.
 *
 * `lastRatingAt` is the last **eligible** rating — the one that holds up the
 * score being shown. Since describe.net 2026-09-10 it is documented as a
 * compatibility alias of `Freshness.lastEligibleRatingAt` and keeps that exact
 * meaning for the life of v1. Read `WalletBreakdown.freshness` for the question
 * this pair never could answer: *was this subject described recently, whether
 * or not it counts?*
 */
export interface Activity {
  firstRatingAt: Timestamp;
  lastRatingAt: Timestamp;
}

/**
 * WHAT the dates are about. A date without a scope is a date that lies.
 *
 * `direction` is the field that matters most: `received` is reputation the
 * subject GOT, `emitted` is the ratings a wallet WROTE
 * (`GET /reputation/rater/{wallet}`). Reading the second as the first turns a
 * busy rater into a much-described subject.
 */
export interface FreshnessScope {
  kind: string | null;
  direction: string | null;
  id: string | null;
  network: string | null;
  declaredType: string | null;
}

/**
 * WHEN this subject was last described. Two dates, because two questions.
 *
 * - `lastReceivedFeedbackAt` — the last real NewFeedback in scope, whether or
 *   not it feeds the score.
 * - `lastEligibleRatingAt` — the last rating that holds up the number shown.
 *
 * When the most recent rating was revoked the two differ, and **that difference
 * is the information**: there was recent activity and the score does not
 * reflect it.
 *
 * NEITHER is `refreshedAt`, which is when the index recomputed its own view and
 * says nothing about the subject.
 *
 * `timestampCoverage` is `none` | `unknown` | `partial` | `complete` over
 * `dated + undated`. **`none` and `unknown` are different facts**: nothing to
 * date versus dates we do not have yet.
 *
 * NO RELATIVE TEXT, deliberately. The API publishes UTC and nothing else, so
 * "3 days ago" is derived at the edge with the reader's clock — a serialised
 * relative string freezes in the first cache.
 */
export interface Freshness {
  scope: FreshnessScope;
  lastReceivedFeedbackAt: Timestamp;
  lastEligibleRatingAt: Timestamp;
  datedFeedbackCount: number;
  undatedFeedbackCount: number;
  timestampCoverage: string | null;
  eligibleDatedCount: number;
  eligibleUndatedCount: number;
  eligibleTimestampCoverage: string | null;
  refreshedAt: Timestamp;
  indexerCheckedAt: Timestamp;
  freshnessVersion: string | null;
}

/** One facet (`tag1`), as declared on-chain. */
export interface Facet {
  score: number | null;
  count: number;
  distinctRaters: number;
  revokedCount: number;
  outOfDomainCount: number;
  selfRatedCount: number;
  /**
   * ⚠️ `tag1` is FREE TEXT on-chain. The longest facet in this index is 471
   * characters — a paragraph about gardening used as a label. Escape
   * everything that comes from the chain before it reaches a DOM.
   */
  direction: string | null;
  directionCategory: string | null;
  directionMeaning: string | null;
}

/** A citable computation: same `inputsDigest`, same numbers. */
export interface Snapshot {
  id: number;
  /**
   * A bare `sha256` hexdigest — 64 hex, **no `0x`** (`aggregate.py:1920`).
   *
   * `null` when it did not come **or** when what came was not a digest;
   * `malformedHashes` is what tells those apart. It is nullable rather than `''`
   * on purpose: this is the field that makes an answer citable, and an empty
   * string here would be a citation to nothing wearing the clothes of a
   * citation.
   */
  inputsDigest: string | null;
  policyVersion: string;
  computedAt: string;
  /**
   * `['inputs_digest']` when the digest arrived malformed. Empty means "nothing
   * arrived malformed" — it says nothing about what arrived.
   */
  malformedHashes: string[];
}

/**
 * `GET /reputation/wallet/{wallet}` — metered ($0.01; $0.05 with a citable
 * snapshot). The decomposition: who rated, how many times, how concentrated.
 */
export interface WalletBreakdown extends Sealed {
  wallet: string;
  finalScore: number | null;
  weightedScore: number | null;
  raterWeightPolicy: string;
  chainCount: number;
  totalReviews: number;
  /** Keyed by network. Values keep the server's shape. */
  perChain: Record<string, unknown>;
  facets: Record<string, Facet>;
  selfRated: SelfRated | null;
  concentration: Concentration | null;
  confidence: Confidence | null;
  activity: Activity | null;
  /**
   * WHEN, with its scope. Additive: `activity` above keeps its exact meaning.
   * `null` when the server does not publish the block yet — never an empty
   * object, so "not published" and "no dates" stay distinguishable.
   */
  freshness: Freshness | null;
  snapshot: Snapshot | null;
  /** What was actually paid, if anything was. */
  payment: PaymentEvidence | null;
}

// ---------------------------------------------------------------------------
// GET /reputation/agent/{network}/{agent_id} — metered, $0.02
// ---------------------------------------------------------------------------

/**
 * One rating, at the grain. `tag1`/`tag2` are on-chain free text: escape them.
 *
 * 🔴 **Its three hash fields arrive shape-validated** (`txHash`, `feedbackHash`,
 * `revokedTx`) — KarmaKadabra's contribution of 2026-08-30, from *"el 200 sin
 * tx"*. Anything that is not a hash is dropped to `null` and its wire name goes
 * into `malformedHashes`. **Absent and malformed are not the same thing**: read
 * the list, not the `null`. See `hashes.ts`.
 */
export interface Rating {
  client: string;
  /**
   * Who SIGNED this row, as a class — served since describe.net 2026-09-14
   * (`describenet/api.py:962`, `rating_roles.author_class_of`).
   *
   * - `facilitator-authored` — `client` is a known relayer (today the x402
   *   facilitator's EVM wallet) that wrote the rating on behalf of the real
   *   rater. **`client` is NOT the counterparty**: every such row shares one
   *   `client`, so any per-rater count — `concentration.distinctRaters`,
   *   `topClientShare` — merges all of them into one voice. Filter on this
   *   before reading `client` as "who rated".
   * - `rater-authored` — `client` is not a relayer the index knows about. 🔴 It
   *   does NOT prove who signed; it is the absence of a known relayer.
   * - `null` — no class was served (a server older than 2026-09-14, or a stored
   *   payload). Unknown, and deliberately NOT defaulted to `rater-authored`:
   *   that would assert the one thing the index says it cannot.
   *
   * An unknown string arrives VERBATIM — the union is open, like `CaveatCode`,
   * and `isKnownAuthorClass()` says whether this SDK has heard of it. Per row
   * only: neither the index nor this SDK computes any score or count by class.
   */
  authorClass: AuthorClass | null;
  feedbackIndex: number;
  value: number;
  valueDecimals: number;
  normalizedValue: number | null;
  tag1: string | null;
  tag2: string | null;
  isRevoked: boolean;
  isSelf: boolean;
  /**
   * The transaction that wrote this rating — `0x` + 64 hex on the EVM chains, a
   * base58 signature on Solana. `null` means it did not come **or** it came
   * malformed; `malformedHashes` separates them. The schema's own note: *"null
   * until the log scan reaches this entry, not null forever"*, so a hole here is
   * normal and is not reported.
   */
  txHash: string | null;
  blockNumber: number | null;
  logIndex: number | null;
  feedbackUri: string | null;
  /** Host of `feedbackURI`. What the ISSUER declared — advisory, never a score. */
  issuerHost: string | null;
  issuer: string | null;
  issuerOrg: string | null;
  /**
   * The content hash the rater committed to. `bytes32`, so `0x` + 64 hex — and
   * **NULL on purpose on Solana** (`solana_indexer.py`), so absence here is
   * correct and is not reported.
   *
   * ⚠️ A well-shaped hash is not a meaningful one: an EVM rater that declared
   * nothing writes 32 zero bytes, which passes the shape check as
   * `0x0000…0000`. This SDK will not decide that for you — a shape check says
   * "this could be a hash", never "this hash means something".
   */
  feedbackHash: string | null;
  /** The transaction that killed this rating, if it was revoked. Same shapes. */
  revokedTx: string | null;
  /**
   * Which of the three hash fields above arrived with something that is not a
   * hash. Empty in the normal case.
   *
   * 🔴 Branch on this, not on `txHash === null`.
   */
  malformedHashes: string[];
}

/** Whether reputation was inherited across an identity transfer. */
export interface Ownership {
  ownerUpdatedBlock: number;
  identityTransferred: boolean | null;
  inheritedReviewCount: number;
  inheritedScore: number | null;
  currentEraReviewCount: number;
  currentEraScore: number | null;
  undeterminedReviewCount: number;
  inheritedShare: number | null;
}

/**
 * Which slice of an agent's ratings one answer carries — `ratings_page`, REQUIRED
 * in `AgentScore` together with `ratings_total` since describe-net #94
 * (`c0a97fa`, 2026-10-17; the schema's own description dates P3 2026-10-16).
 *
 * Read the two nullable fields, not `returned`: per the schema's own
 * descriptions, an answer that did not page reads `limit: null` and
 * `nextOffset: null`, and `ratings` is then the whole list.
 */
export interface RatingsPage {
  /** Index of the first rating returned, from 0. */
  offset: number;
  /** The page size asked for, or `null` when the request did not page. Never `0`. */
  limit: number | null;
  /** How many ratings this answer carries. */
  returned: number;
  /**
   * The `offset` of the next page, or `null` when this one reaches the end.
   * ⚠️ Each page is its own PAID request at the same price — a loop over this
   * field is a loop over payments.
   */
  nextOffset: number | null;
}

/** `GET /reputation/agent/{network}/{agent_id}` — metered ($0.02). */
export interface AgentReputation extends Sealed {
  network: Network;
  agentId: string;
  /**
   * The wallet that owns this identity TODAY (`agents.current_owner`), never
   * the minter of the `Registered` event — that is almost always the
   * facilitator, and attributing by it would file the whole index under one
   * address.
   */
  currentOwner: string | null;
  /**
   * ⚠️ NOT a type. 283 770 of 470 064 agents (60,4 %, measured 2026-08-30) are
   * `unknown`, and the second largest "type" is the URL of the EIP schema —
   * with its typo variant. ERC-8004 has no type field. Never treat it as
   * verification. Read it live from `GET /stats/types`.
   */
  declaredType: string | null;
  agentUri: string | null;
  indexedIdentity: boolean;
  score: number | null;
  reviewCount: number;
  revokedCount: number;
  outOfDomainCount: number;
  selfRated: SelfRated | null;
  facets: Record<string, Facet>;
  concentration: Concentration | null;
  ownership: Ownership | null;
  confidence: Confidence | null;
  ratings: Rating[];
  /**
   * How many ratings the agent has IN ALL (`ratings_total`; typed here since
   * 0.7.0, required upstream since describe-net #94). Without paging it is the
   * length of the list the server sent — which `ratings` matches unless a row
   * was not an object and got dropped; with paging it is the size of the list
   * `ratings` is one page of. A non-integer is not a declaration: `null`.
   *
   * 🔴 `null` when the answer did not declare it — a server older than P3, or a
   * payload stored before then — and deliberately NOT `ratings.length`: that
   * reconstruction is right only for an answer that did not page, and a stored
   * payload does not say how it was asked for. Never `0` either: an agent with
   * no ratings DECLARES `0`, which is a different fact from not declaring.
   */
  ratingsTotal: number | null;
  /**
   * Which slice of the full list `ratings` is (`ratings_page`). `agent()` sends
   * no `limit`/`offset`, so on a live answer this is the whole list; it is typed
   * because the parsers are exported for STORED payloads, and a stored page must
   * not read as a whole agent — `limit !== null` says it was a page.
   *
   * `null` when the answer did not declare it, never a synthesised "whole
   * list": that is the one thing a payload that said nothing cannot prove.
   */
  ratingsPage: RatingsPage | null;
  payment: PaymentEvidence | null;
}

// ---------------------------------------------------------------------------
// GET /reputation/by-resource — free, asked by the URL of a paid endpoint
// ---------------------------------------------------------------------------

/**
 * The identity a collector's row links to: by id, never by owner.
 * `agent(network, agentId)` takes exactly these two — and is PAID, while rows
 * repeat the same agent: deduplicate by the PAIR before following the links
 * (see `byResource()`).
 */
export interface ResourceAgent {
  network: Network;
  /** A decimal uint256 on EVM chains, a base58 asset id on Solana — an identity, never the collector's address. */
  agentId: string;
}

/**
 * What `GET /wallets/{wallet}/exists` counts, without the wallet. **Counts, not
 * a score**: `totalReviews` is volume, not agreement.
 */
export interface ResourceReviews {
  /** `false` next to an identity is registered-but-unrated — a different fact from unregistered. */
  hasReputation: boolean;
  totalReviews: number;
  /** 🔴 `null` means "not in the ranking", NEVER `0` — same rule as `WalletReputation.distinctRaters`. */
  distinctRaters: number | null;
  chainsWithReputation: number;
  /** The last rating that counts toward the score. `null` = not known, never a stand-in date. */
  lastEligibleRatingAt: Timestamp;
}

/**
 * One collector of a resource — one row per `accepts[]` entry, and **with no
 * address in it**: there is no field where one would fit, upstream or here.
 *
 * ⚠️ A row is NOT a counterparty. Measured live 2026-11-17 on describe.net's
 * own listing (`https://api.describe.net/reputation/wallet`): six rows, one per
 * chain of its 402, with the same agent and the same counts in every one.
 * Count rows and you count networks; follow each row's `agent` and you pay for
 * the same read once per row.
 */
export interface ResourceCollector {
  /**
   * The CAIP-2 network of that `accepts[]` entry (`eip155:8453`, …), or `null`
   * when it is not one the payment SDK knows: whoever registered the URL wrote
   * it, and a free-form value can carry anything.
   */
  network: string | null;
  /**
   * `erc8004_identity` · `no_erc8004_identity` · `not_indexed`. Open, like
   * `CaveatCode`: a value this SDK has not heard of arrives verbatim.
   *
   * 🔴 `no_erc8004_identity` is NOT bad reputation — it is the common case for
   * bazaar endpoints. `not_indexed` means the collector is neither EVM nor
   * Solana, so nothing was asked and `hasIdentity` is `null`.
   */
  identityStatus: 'erc8004_identity' | 'no_erc8004_identity' | 'not_indexed' | (string & {});
  /** `null` when nothing was asked (`not_indexed`), never `false`. */
  hasIdentity: boolean | null;
  /** ERC-8004 identities the collector holds across the indexed chains. `null` when nothing was asked, never `0`. */
  identityCount: number | null;
  /**
   * ONE identity to link — not necessarily the most-reviewed one; `identityCount`
   * says whether there are more. `null` unless both `network` and `agentId`
   * arrived as non-empty strings: half a link is no link.
   */
  agent: ResourceAgent | null;
  /** `null` when there is neither an identity nor ratings: no reviews to count, which is not reviews that count against it. */
  reviews: ResourceReviews | null;
}

/** One URL asked, with what the facilitator's bazaar said about it. The URL itself does not come back. */
export interface ResourceReputation {
  /**
   * `found` · `not_in_bazaar` · `lookup_truncated` · `quarantined` ·
   * `bazaar_unavailable`. Open, like `CaveatCode`.
   *
   * ⚠️ Only `found` describes collectors. `lookup_truncated` is NOT proof of
   * absence (paging the bazaar is not a consistent snapshot), `quarantined`
   * listings never have their collectors described, and `bazaar_unavailable`
   * means ask again — none of the four is "this endpoint has no reputation".
   */
  status: 'found' | 'not_in_bazaar' | 'lookup_truncated' | 'quarantined' | 'bazaar_unavailable' | (string & {});
  /** The prober's last view of a `found` listing (`alive`, `degraded`, …). `null` when not found or not reported. */
  listingHealth: 'alive' | 'degraded' | 'auth_gated' | 'unknown' | 'unprobeable' | (string & {}) | null;
  /**
   * Whether the prober CAN compare the collectors with the live endpoint.
   * **Necessary, not sufficient** (its last probe can be days old); `false`
   * means they are only what whoever registered the URL declared. `null` when
   * not found.
   */
  collectorsCheckable: boolean | null;
  collectors: ResourceCollector[];
  /** Collectors past the per-resource cap that were not looked up. */
  collectorsOmitted: number;
  /** When describe.net read the bazaar for this URL (reads are cached). `null` when the bazaar did not answer. */
  bazaarReadAt: Timestamp;
}

/**
 * `GET /reputation/by-resource` — free. Who collects at an x402 resource, and
 * their reputation, asked by its URL.
 *
 * **Not `Sealed`, on purpose**: there is no score in it to seal. It carries
 * counts and an identity to link; the score is one `agent()` away, sealed. A
 * `policyVersion: null` + `caveats: []` added here for symmetry would be the
 * silence karma-hello's gate mistook for "evaluated, nothing found" (see
 * `caveatsNotComputed`).
 *
 * 🔴 **The order is the only key.** describe.net does not echo the URL —
 * `resources[i]` answers the i-th URL asked — so `byResource()` refuses an
 * answer whose row count is not the number of URLs it sent, and
 * `parseByResource()` refuses a row it cannot read instead of dropping it: one
 * dropped row shifts every row after it onto the wrong URL.
 */
export interface ByResourceReputation {
  /** One per URL asked, IN ORDER. */
  resources: ResourceReputation[];
  /** The public bazaar endpoint the collectors were read from. Repeat any lookup against it. */
  bazaar: string | null;
  /** The materialized view the counts come from. */
  source: string | null;
  /** When that view was last recomputed. `null` = not recorded, never "just now". */
  refreshedAt: Timestamp;
  /** The exact JSON as served. */
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GET /leaderboard — free (first page only; `/leaderboard/page` is metered)
// ---------------------------------------------------------------------------

/**
 * ⚠️ The leaderboard does NOT order by average. It orders by `shrunkScore`
 * (Bayesian shrinkage over distinct raters), which is why row 1 can show a
 * lower `finalScore` than row 2. Ordering by `finalScore` client-side
 * reproduces the bug the shrinkage exists to prevent: a wallet with one
 * 100-point rating outranking one with two hundred.
 */
export interface LeaderboardRow {
  rank: number;
  wallet: string;
  finalScore: number | null;
  shrunkScore: number | null;
  distinctRaters: number;
  chainCount: number;
  totalReviews: number;
  networks: Network[];
  declaredTypes: Array<string | null>;
  /** The row exactly as served. */
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// GET /health — the authority on index totals
// ---------------------------------------------------------------------------

export interface HealthChain {
  network: Network;
  lastScannedBlock: number | null;
  updatedAt: Timestamp;
  /** When this chain is next due. The freshness pointer worth polling against. */
  nextSyncAt: Timestamp;
  lastError: string | null;
  raw: Record<string, unknown>;
}

/**
 * `GET /health` — free, and the ONLY authority on the index's totals.
 *
 * "Toda cifra o se lee viva o lleva fecha": never type a total of this index
 * into a UI, a README or a doc. Read it here. That is also why
 * `readingPolicy` and `confidenceThresholds` come through as maps rather than
 * as constants of this package — they are the server's calibrable values,
 * published live precisely so no consumer re-types them (invariante 10).
 *
 * Slowest free endpoint (~1,6 s measured, 2,4 s on 2026-08-30) and deliberately
 * uncached at the edge — never probe it with a sub-3 s timeout.
 */
export interface IndexHealth {
  status: string;
  policyVersion: string;
  orderingPolicy: string;
  raterWeightPolicy: string;
  confidencePolicy: string;
  /**
   * The frozen `M` of the per-chain credibility weight, `Z_k = R_k/(R_k+M)`.
   *
   * REQUIRED in the server schema since `credibility-weight-per-chain@1`
   * (2026-09-04) and untyped here until now — `types.schema.test.ts` caught it
   * the moment the snapshot was refreshed. It ships live because the number is
   * frozen and versioned: recomputing a `finalScore` by hand needs THIS M, not
   * a copy of it that went stale.
   */
  credibilityM: number | null;
  /**
   * WHEN the index as a whole last received a description. The only free,
   * account-less, parameter-less place to read whether describe.net is still
   * taking in descriptions or merely still refreshing its views — the two look
   * identical from the outside, which is the confusion `Freshness` closes.
   *
   * `null` against a server that does not publish it yet.
   */
  freshness: Freshness | null;
  /** e.g. `{no_ratings: 0, low: 1, medium: 3, high: 6}` — live, never re-typed. */
  confidenceThresholds: Record<string, number>;
  /** e.g. `{min_raters: 3, campaign_per_rater: 20, top_share: 0.5, ...}`. */
  readingPolicy: Record<string, unknown>;
  /** Which commit is serving. Useful when a shape changes under you. */
  buildSha: string | null;
  agents: number;
  feedbackEntries: number;
  indexerPeriodSeconds: number | null;
  chains: HealthChain[];
  raw: Record<string, unknown>;
}
