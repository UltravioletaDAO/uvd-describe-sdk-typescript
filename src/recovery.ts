/**
 * What to do INSTEAD — the sentence `transient` cannot say.
 *
 * ## Where this came from, and it is not ours
 *
 * Contributed by **Execution Market** in `#agents` on **2026-08-30**, out of
 * their own 502 body gaining `detail.code`, `detail.retryable` and
 * `detail.recovery` with ten typed codes — *"para que lo codifiquen de su
 * lado"*. Their argument is the measurement that justifies this whole file:
 *
 * > *"SIETE de los diez son TERMINALES (`retryable: false`). Eso es lo que más
 * > les sirve: hoy su flota no puede distinguir 'reintenta' de 'no insistas', y
 * > contra `AUTHORIZATION_EXPIRED` reintentar es quemar llamadas contra una
 * > ventana cerrada hace **317 HORAS**."*
 *
 * 317 hours of retries against a door that closed is the cost of having only
 * the boolean. Measured on our side the same day, before this file existed:
 * `grep -rc recovery src/` was **0** in both SDKs, while `transient` and
 * `serviceFault` were already on every error. So we had exactly half of it — we
 * could say whether retrying helps, and had no way at all to say what to do
 * when it does not. A boolean that says "no" leaves the caller stuck; a
 * sentence that names another door lets them keep going.
 *
 * 🔴 **What was deliberately NOT absorbed: their ten codes.**
 * `AUTHORIZATION_EXPIRED`, escrow, release-to-worker, payout wallets — that is
 * Execution Market's API, and this SDK does not wrap it. It wraps describe.net,
 * which holds no escrow and expires no authorization of its own. A consumer
 * branching on `AUTHORIZATION_EXPIRED` against this index would be writing dead
 * code against a domain we do not touch. The **pattern** is the contribution;
 * the table below is ours and had to be re-derived failure by failure.
 *
 * ## Why a sentence, and not a second enum
 *
 * The machine-readable axis already exists and is `kind` — plus `transient`
 * ("would retrying help?") and `serviceFault` ("is this describe.net's
 * fault?"). A `recoveryCode` enum would be a SECOND taxonomy over the same
 * failures, kept in sync by hand, and consumers would start branching on it
 * instead of on `kind`; the day the two disagree, the branch that fires is the
 * wrong one. What was missing is not another thing to switch on, it is the
 * paragraph a human (or an agent reading its own exception) needs in order to
 * do something else.
 *
 * 🔴 So: **branch on `kind`, read `recovery`.** Never parse it, never match on
 * it — same contract the caveats carry, where `code` is frozen and the text is
 * free to be re-written (`caveats.ts`, and describe.net's own rule: *"EL TEXTO
 * puede cambiar sin aviso; EL CODE jamás"*). The stability a test needs comes
 * from the strings living HERE, once, exported: pin `RECOVERY.payment_required`
 * and the assertion cannot rot into a prose match.
 *
 * ## 🔴 The rule that keeps an empty one honest
 *
 * **A recovery that does not work is worse than no recovery**, because it sends
 * the caller to do something useless with confidence — which is the same shape
 * as the 317 hours, one level up. So a `null` here is a decision that was made,
 * not a field somebody forgot: `timeout` has one and its reasoning is written
 * at the entry.
 *
 * And a recovery is never "retry" in other words — `transient` already says
 * that, and repeating it would be the second copy of a fact this package keeps
 * in one place. Every entry names something ELSE: another route, another field,
 * another mode, or the condition on the caller's side that has to be fixed.
 *
 * ## 🔴 Every string in this file is a literal, and that IS the redaction guard
 *
 * Execution Market's other warning of the same day: an unclassified error *"can
 * carry an RPC URL with its API key inside"*, and they added a test with a fake
 * secret that fails if it leaks. The service side of the house has had that
 * guard for a while — `describe-net/describenet/chain/rpc.py::_redact` replaces
 * the endpoint with `<rpc-url>` in anything about to be logged or raised,
 * because the key lives in the URL path.
 *
 * The SDK equivalent is structural rather than a filter: **this module holds
 * nothing but frozen literals and interpolates nothing.** `recoveryFor()` picks
 * one by key; no call site builds a recovery out of a message, a URL, a cause,
 * or any other string that came from outside this file. A filter can be
 * forgotten at one call site; a table has no call site to forget.
 *
 * That boundary is drawn where it is on purpose, and the neighbouring field is
 * the contrast: `DescribeUnreachable`'s `message` DOES quote `String(error)`,
 * because a transport failure with the cause stripped out is undebuggable. The
 * message is forensic and belongs to whoever is reading the exception; the
 * recovery is advice this package WROTE and is the string most likely to be
 * copied into a log line, a ticket or a Slack message. `recovery.test.ts`
 * mounts a fetch that throws a URL carrying a fake key and asserts the recovery
 * comes back byte-identical to the table.
 *
 * ## 🔴 Parity: what a recovery text is allowed to name
 *
 * The Python SDK ships the same field with the same name and the SAME text, so
 * a consumer who moves stacks does not read two different pieces of advice for
 * one failure. That is only possible if a text names things BOTH SDKs share:
 * HTTP routes, headers, wire fields, env vars, chain ids, and the numbers the
 * service publishes. It may NOT name a language-specific spelling — this
 * package's `jitterMs` is the Python package's `jitter` and it is in SECONDS
 * (see the README's parity note), so a text naming it would have to be either
 * different or wrong. Options are therefore described by what they do, and the
 * caller finds the spelling in their own SDK, one line away.
 */

import type { DescribeErrorKind } from './errors';

/**
 * The keys of the table.
 *
 * Every `kind`, plus `rate_limited` — the one place where a kind is not fine
 * enough. A 429 and a 422 are both `http_4xx`, and their recoveries are
 * opposites: one says *this is your input, fix it*, the other says *this is not
 * your request at all, spread your fleet*. Merging them would produce a
 * paragraph that is wrong for both, which is exactly the mush this file exists
 * to avoid. The split lives in `recoveryFor()`, on the same `status === 429`
 * condition that already decides `transient` in `DescribeHTTPError`.
 */
export type RecoveryKey = DescribeErrorKind | 'rate_limited';

/**
 * The frozen table. One entry per {@link RecoveryKey}, `null` where there is
 * honestly no other door.
 *
 * The `Record` annotation is half the guard: a `kind` added to the union
 * without an entry here does not compile. The other half is
 * `recovery.test.ts`, which walks every kind at runtime.
 */
export const RECOVERY: Readonly<Record<RecoveryKey, string | null>> = Object.freeze({
  /**
   * 🔴 **The honest empty, and it is a measured decision — do not fill it in.**
   *
   * A timeout has exactly two levers. The first is retrying, which `transient:
   * true` already announces and which a recovery may not repeat. The second is
   * the client timeout, and the numbers in `config.ts::DEFAULT_TIMEOUT_MS` say
   * raising it past the default buys nothing that can ever arrive: the
   * provider's API Gateway integration ceiling is **29 s** and the default here
   * is 30 000 ms. Telling a caller to raise it would be advice that provably
   * does not work — the exact failure this file's own rule forbids.
   *
   * (The opposite mistake — a timeout set BELOW the 15,2 s cold start, which
   * turned a cold index into a fake outage for Execution Market once — is a
   * configuration fact and already lives, once, in `config.ts`. It is not
   * re-typed here.)
   *
   * What separates this from its neighbour `http_5xx`, which DOES have a
   * recovery: a 5xx is evidence that the service is alive and one query is not,
   * so another route is worth trying. A timeout is no evidence at all.
   */
  timeout: null,

  http_5xx:
    'They answered, so the process is alive and one query is not — which makes a different door ' +
    'worth more than the same one again. `GET /wallets/{wallet}/chains` is free and serves the ' +
    'coarse version of the same question (which ERC-8004 identities the wallet has, and the score, ' +
    'review count and distinct raters of each) through another query path. It costs nothing to ' +
    'find out; if the whole index is down it fails too, and on the free routes that arrives as a ' +
    'null rather than as this.',

  http_4xx:
    'Fix the request before repeating it: a 4xx is your input, not their outage. A 422 is never ' +
    'absence — an unregistered wallet answers 200 with nulls, so `not_an_address` means the string ' +
    'is not an address at all (a Solana base58 wallet is case-sensitive and this client sends it ' +
    'verbatim), and `GET /leaderboard` answers 422 to ANY query parameter because paging moved to ' +
    'the metered `/leaderboard/page`. To turn a loose id into a question that exists, ask the free ' +
    '`GET /search/{query}` first.',

  rate_limited:
    'Not your request: describe.net rate-limits the whole ecosystem out of one bucket with no ' +
    'per-partner share, so a 429 is usually somebody else spiking. Retrying tighter makes it ' +
    'worse — spread the fleet instead (this client already sleeps a random jitter before every ' +
    'request; widening it is the lever) and read the `RateLimit-Policy` response header for the ' +
    'live budget rather than any number written in a document. The cached free routes ' +
    '(`GET /health`, `/pricing`, `/leaderboard`, `/stats/*`) are served from CloudFront and a hit ' +
    'does not spend the budget at all.',

  not_found:
    'Nothing failed and nothing was charged: the index is saying there is nothing there. The one ' +
    'case worth acting on is an agent id, because an id alone does not name a row — resolve the ' +
    'pair for free with `GET /search/{query}` (measured by the service on 2026-08-23: 26.736 of ' +
    '62.814 ids live on two or more chains, and in 100 % of those the owning wallet is a different ' +
    'one on each). If EVERY route 404s, the base URL is pointing somewhere else.',

  unreachable:
    'The request never reached describe.net: nothing was asked, nothing was signed, nothing was ' +
    'charged. This one is on your side of the socket — DNS, egress or proxy, TLS interception, a ' +
    'browser CORS block, or a base URL whose host does not exist — and it is the thing to check ' +
    'before blaming the index, which never saw the request.',

  unparseable:
    'Ask WHAT answered rather than asking again: an HTML error page from a proxy, a captive portal ' +
    'or a gateway arrives exactly like this and is not the index talking. Retrying is measured to ' +
    'buy nothing (MeshRelay excludes this from its retry set on purpose). If the body really did ' +
    'come from describe.net, the door that changes the answer is another one: ' +
    '`GET /wallets/{wallet}/chains` is free and serves the coarse version of the same question.',

  partial_index:
    'Read the coverage before reading the absence as a verdict: a chain the index does not scan ' +
    'produces no rows, and that looks identical to an agent nobody rated. `GET /chains` (free) ' +
    'lists what is indexed and `GET /health` (free) carries the per-chain totals and how current ' +
    'each one is. If the chain you write to is missing there, no re-reading of this answer will ' +
    'fix it — that is a question for whoever runs the index.',

  payment_required:
    'Nothing was charged: asking the price is free, and asking first is the intended move. Three ' +
    'doors out. (1) Wire a payer — this SDK ships the x402 adapter behind its own subpath, so a ' +
    'free-only consumer installs nothing. (2) Enter the partner rail with a wallet on ' +
    'describe.net\'s allowlist and the metered routes stop charging. (3) Answer the cheaper ' +
    'question for free — the challenge names it itself: `free_preview.endpoint` is the free route ' +
    'about THIS subject (a wallet lands on `GET /wallets/{wallet}/chains`) and `see_also` lists ' +
    'every other free door. If there is nothing there, there is nothing to buy.',

  payment_refused:
    'Do NOT retry, and do NOT widen the expected payee to make this pass: the challenge that named ' +
    'a stranger arrived over the same network that could be lying to you, so it cannot be the ' +
    'evidence that clears itself. Verify out of band — describe.net publishes the treasury in its ' +
    'OpenAPI (`GET /openapi.json`, free, where `payTo` must equal that address) and on its own ' +
    'site. If a rotation is real, upgrade this SDK or set the expected payee yourself once you ' +
    'have confirmed the new address through a channel that is not this response.',

  malformed_hash:
    'Nothing to retry: the same request serves the same bad field, and nothing else in the answer ' +
    'was touched. Read the mark rather than the `null` — the object that lost the field carries a ' +
    'malformed-hash list naming it, the notice carries the field\'s wire path, and the value as ' +
    'served is still in `raw`, which is what belongs in the ticket to whoever runs the index. A ' +
    '`null` with an EMPTY list is the other thing entirely: the field has not been written yet, ' +
    'which is documented and normal.',

  partner_unsigned:
    'Fix the signer, not the request — and do not "fix" it by dropping partner mode, because an ' +
    'anonymous client is a client that PAYS. The measured common cause is a trailing newline: ' +
    '`KEY=$(cat file)` keeps it, which is why the key is shape-checked before it can reach the ' +
    'signer. The environment variable is `DESCRIBE_PARTNER_PRIVATE_KEY`. The signer\'s own error ' +
    'travels as this exception\'s cause and is never copied into any message here — read it there.',

  partner_rejected:
    'Fix the rail; do not reach for the payer by reflex. In the order these actually happen: the ' +
    'wallet is not on describe.net\'s allowlist yet (send them the signing address this error ' +
    'carries — it is public, which is the point of an allowlist of addresses instead of a token); ' +
    'the base URL is not `https://api.describe.net`, so the signed authority cannot match (a raw ' +
    'execute-api host does this); the keyid chain is not 8453; or the clock drifted (more than ' +
    '30 s ahead, or a signature older than 300 s). The attached challenge says what it would have ' +
    'cost, and paying anyway is an explicit opt-in, never a fallback.',
});

/**
 * The recovery for one failure, or `null` when there honestly is none.
 *
 * Called from exactly one place — the `DescribeError` constructor — so every
 * error in this package gets its recovery from the same table by construction,
 * and a subclass cannot forget to pass one or invent one of its own.
 *
 * `status` is read for one case only: 429 is the single 4xx that is not the
 * caller's bug, and it takes the `rate_limited` entry. Same condition that
 * already decides `transient` one file over.
 */
export function recoveryFor(kind: DescribeErrorKind, status?: number): string | null {
  if (kind === 'http_4xx' && status === 429) return RECOVERY.rate_limited;
  return RECOVERY[kind];
}
