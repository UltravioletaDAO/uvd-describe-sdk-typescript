/**
 * `freshness`: WHEN the subject was described, and why there are two dates.
 *
 * Twin of `tests/test_freshness.py` in the Python SDK — the two implement the
 * same core contract and neither changes it on its own. What this file defends
 * is that the SDK does not collapse the distinction the index just opened:
 * `activity.lastRatingAt` answers *how old is this score*;
 * `freshness.lastReceivedFeedbackAt` answers *was this subject described
 * recently*. When the last rating received was revoked the two differ, and a
 * consumer reading the first believing it is the second decides on a number
 * nobody explicitly lied about.
 */
import { describe, expect, it } from 'vitest';

import { parseWalletBreakdown } from './parse.js';

/**
 * The two dates DIFFER on purpose: the last real NewFeedback is from September
 * and the last one holding up the score is from August. If they were equal, a
 * parser reading the wrong key would pass anyway.
 */
const BREAKDOWN = {
  wallet: '0x97cd97cfe21799bacbf39d0a53469e5f82f30996',
  final_score: 86.653045,
  weighted_score: null,
  rater_weight_policy: 'log-diversity@1',
  chain_count: 1,
  total_reviews: 7548,
  per_chain: {},
  facets: {},
  self_rated: { count: 0, score: null, gap: null },
  concentration: null,
  confidence: null,
  activity: { first_rating_at: '2026-07-01T00:00:00Z', last_rating_at: '2026-08-30T00:00:00Z' },
  freshness: {
    scope: {
      kind: 'wallet',
      direction: 'received',
      id: '0x97cd97cfe21799bacbf39d0a53469e5f82f30996',
    },
    last_received_feedback_at: '2026-09-05T00:00:00Z',
    last_eligible_rating_at: '2026-08-30T00:00:00Z',
    dated_feedback_count: 7548,
    undated_feedback_count: 12,
    timestamp_coverage: 'partial',
    eligible_dated_count: 7548,
    eligible_undated_count: 0,
    eligible_timestamp_coverage: 'complete',
    refreshed_at: '2026-09-10T16:00:00Z',
    indexer_checked_at: '2026-09-10T16:48:00Z',
    freshness_version: 'freshness@1',
  },
  policy_version: 'equal-weight-per-chain@2',
  snapshot: null,
};

describe('freshness', () => {
  it('brings both dates, kept apart', () => {
    const b = parseWalletBreakdown(BREAKDOWN, null);
    expect(b.freshness?.lastReceivedFeedbackAt).toBe('2026-09-05T00:00:00Z');
    expect(b.freshness?.lastEligibleRatingAt).toBe('2026-08-30T00:00:00Z');
    expect(b.freshness?.lastReceivedFeedbackAt).not.toBe(b.freshness?.lastEligibleRatingAt);
  });

  it('keeps activity.lastRatingAt as the eligible alias', () => {
    // The server's compatibility promise, inherited: a consumer already reading
    // it must keep reading the same thing. This is what stops someone from
    // "improving" it into the received date.
    const b = parseWalletBreakdown(BREAKDOWN, null);
    expect(b.activity?.lastRatingAt).toBe(b.freshness?.lastEligibleRatingAt);
  });

  it('carries the whole scope, direction included', () => {
    const b = parseWalletBreakdown(BREAKDOWN, null);
    expect(b.freshness?.scope.kind).toBe('wallet');
    expect(b.freshness?.scope.direction).toBe('received');
    expect(b.freshness?.scope.id).toBe(BREAKDOWN.wallet);
  });

  it('ships partial coverage with its denominator', () => {
    // `partial` means the published date is a FLOOR. Without both addends a
    // consumer cannot know how much is missing, and painting "last description"
    // without saying dates are missing claims more than we know.
    const fr = parseWalletBreakdown(BREAKDOWN, null).freshness;
    expect(fr?.timestampCoverage).toBe('partial');
    expect(fr?.datedFeedbackCount).toBe(7548);
    expect(fr?.undatedFeedbackCount).toBe(12);
    // The eligible subset has its OWN denominator, and here it is complete.
    expect(fr?.eligibleTimestampCoverage).toBe('complete');
  });

  it('is null when absent, never an empty object', () => {
    const { freshness, ...sin } = BREAKDOWN;
    expect(freshness).toBeDefined();
    expect(parseWalletBreakdown(sin, null).freshness).toBeNull();
  });

  it('does not break the parse when the block is garbage', () => {
    // Freshness is advisory: it cannot bring down a paid response.
    const roto = { ...BREAKDOWN, freshness: '3 days ago' };
    const b = parseWalletBreakdown(roto, null);
    expect(b.freshness).toBeNull();
    expect(b.finalScore).toBe(BREAKDOWN.final_score);
  });

  it('never derives relative text', () => {
    // The API publishes UTC and nothing else, on purpose: a serialised
    // "3 days ago" freezes in the first cache. The edge derives it, with the
    // reader's clock. This test is that promise written as code.
    const fr = parseWalletBreakdown(BREAKDOWN, null).freshness!;
    expect(Object.keys(fr).filter((k) => /ago|relative/i.test(k))).toEqual([]);
  });
});
