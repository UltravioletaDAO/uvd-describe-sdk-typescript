#!/usr/bin/env node
/**
 * A real call to the real API — FREE routes only.
 *
 * 🔴 It never touches a metered route. `walletBreakdown` and `agent` cost real
 * USDC and a smoke script is not a place to spend it. There is no flag to turn
 * that on, on purpose: the safest way to not spend money by accident is to not
 * write the code that could.
 *
 * Separate from `npm test` for the same reason `schema:check` is: the test loop
 * does not touch the network. This is the deliberate one, run before a release.
 *
 *   node scripts/smoke-free.mjs      (or: npm run smoke)
 *
 * Requires `npm run build` first — it imports the built artifact, so it also
 * proves the ESM output actually loads.
 */

import { DescribeClient, formatScore } from '../dist/index.mjs';

const KNOWN = '0x97cd97cfe21799bacbf39d0a53469e5f82f30996';
const UNRATED = '0xdEaD00000000000000000000000000000000BEEF';

const failures = [];
const client = new DescribeClient({
  product: 'smoke-test',
  failOpen: false, // a smoke test wants the error, not a quiet null
  onFailure: (f) => failures.push(f),
});

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

console.log(`--- smoke: FREE routes against ${process.env.DESCRIBE_BASE_URL ?? 'https://api.describe.net'} ---\n`);

const health = await client.health();
check('health()', health.status === 'ok', `status=${health.status} policy=${health.policyVersion} build=${health.buildSha?.slice(0, 7)}`);
check('health carries live totals', health.agents > 0 && health.feedbackEntries > 0, `agents=${health.agents} feedback=${health.feedbackEntries}`);
check('health publishes reading_policy', typeof health.readingPolicy.min_raters === 'number', `min_raters=${health.readingPolicy.min_raters}`);
check('health lists chains', health.chains.length > 0, `${health.chains.length} chains`);

const rated = await client.wallet(KNOWN);
check('wallet() on a rated wallet', typeof rated.globalScore === 'number', `globalScore=${rated.globalScore} -> "${formatScore(rated.globalScore)}"`);
check('wallet() carries its seal', typeof rated.policyVersion === 'string' && Array.isArray(rated.caveats), `policy=${rated.policyVersion} caveats=${rated.caveats.length}`);

const unrated = await client.wallet(UNRATED);
check('R1: an unrated wallet is an ANSWER, not an error', unrated !== null, `wallet=${unrated?.wallet}`);
check('R1: its globalScore is null, never 0', unrated.globalScore === null, `globalScore=${JSON.stringify(unrated.globalScore)}`);
check('R1: formatScore(null) is null, never "0"', formatScore(unrated.globalScore) === null, `-> ${JSON.stringify(formatScore(unrated.globalScore))}`);

const board = await client.leaderboard();
check('leaderboard() is a bare array', Array.isArray(board) && board.length > 0, `${board.length} rows, rank1=${board[0]?.rank}`);
check('leaderboard is ordered by shrunk_score', board[0].shrunkScore >= board[board.length - 1].shrunkScore, `${board[0].shrunkScore} >= ${board[board.length - 1].shrunkScore}`);

const badge = client.badgeUrl(KNOWN);
const badgeRes = await fetch(badge);
check('badgeUrl() serves an SVG', badgeRes.ok && (badgeRes.headers.get('content-type') ?? '').includes('svg'), `${badgeRes.status} ${badgeRes.headers.get('content-type')}`);

// R4, live: a malformed address must be a caller error, not a quiet absence.
let threw = null;
try {
  await client.wallet('notawallet');
} catch (e) {
  threw = e;
}
check('R4: a malformed address throws a typed 4xx', threw?.kind === 'http_4xx' && threw?.status === 422, `kind=${threw?.kind} status=${threw?.status}`);

// R6, live: asking is free. A 402 with no payer must hand over the challenge
// WITHOUT paying — this is the one metered route touched, and it costs nothing.
let challenge = null;
try {
  await client.walletBreakdown(KNOWN);
} catch (e) {
  challenge = e;
}
check('R6: a metered route 402s with no payer configured', challenge?.kind === 'payment_required', `kind=${challenge?.kind}`);
check('R6: the challenge arrives readable and unpaid', typeof challenge?.challenge?.amount === 'string', `amount=${challenge?.challenge?.amount} ${challenge?.challenge?.token}`);

console.log(`\n${process.exitCode ? 'SMOKE FAILED' : 'smoke ok'} — ${failures.length} fail-open events (expected 0 with failOpen:false)`);
