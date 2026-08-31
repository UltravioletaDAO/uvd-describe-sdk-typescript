/**
 * A short random pause before a read, so a fleet does not arrive as one spike.
 *
 * ## Where this comes from, and what not having it cost
 *
 * Contributed by **KarmaKadabra**, `#agents` on MeshRelay, **2026-08-30**. They
 * operate the largest fleet against this index — 27 agents — and their sentence
 * is the whole specification:
 *
 * > *"27 agentes despiertan al MISMO tiempo por EventBridge y pegan simultáneo
 * > contra su límite de rps COMPARTIDO con los otros consumidores. Sin jitter,
 * > un enjambre es un DDoS educado."*
 *
 * They sleep `random.uniform(0, 0.4)` before every read
 * (`karmakadabra/lib/reputation_scan.py:123`). Verified before writing a line:
 * `grep -riE 'jitter|random|sleep' src/` in **both** SDKs returned zero hits on
 * 2026-08-30. Neither of us had it.
 *
 * Two halves of what follows are theirs and two are ours, and the line matters
 * because provenance is the reason to trust a number: **measured at
 * KarmaKadabra** are the 0.4 s and the non-cryptographic uniform draw.
 * **Designed here** are everything about it being a parameter at all — the
 * default being ON, `0` switching it off, and a garbage value falling back to
 * the default rather than to off. KarmaKadabra has no jitter option; they have
 * a literal.
 *
 * The word that makes it the library's problem and not the fleet's is
 * **COMPARTIDO**. describe.net's rate limit has no per-partner bucket (already
 * written down in `config.ts`), so the agent that pays for an unjittered swarm
 * is not the swarm's owner — it is the other consumer whose read gets the 429,
 * and who has no lever to fix it. That is the shape of an externality, and a
 * default that leaves the cost on someone with no lever is the wrong default.
 *
 * ## 🔴 Jitter is NOT backoff, and the day someone adds a retry this matters
 *
 * They look alike (both sleep) and they answer opposite questions. **Jitter
 * disperses a herd that has not asked for anything yet**; it goes before a
 * request and its size is about how many of us there are. **Backoff yields to a
 * service that has already said no**; it goes before a RETRY and its size is
 * about how hard it just refused. So a retry — this package has none,
 * deliberately, see `client.ts` — takes backoff, never this.
 *
 * ## 🔴 It goes before EVERY request, not once per public call
 *
 * ⚠️ **This is a correction of the rule this file was first written with, and
 * the old one is left here because it is the intuitive reading and the next
 * person to touch this will want to "optimise" back to it.** The first version
 * said *"once per public call, before the FIRST request"*. It sounds
 * equivalent. It is not: a call that fires N requests would disperse one and
 * let the other N−1 out in a pack — the exact problem this contribution came to
 * fix, reintroduced through the back door.
 *
 * KarmaKadabra's own call site settles it, and it was read rather than assumed
 * (2026-08-30): the sleep lives INSIDE `_scan_describenet()`, the function that
 * performs the GET (`reputation_scan.py:123`), and that function runs **twice**
 * on the real path — `:242` for the EVM address, `:245` for the Solana one. So
 * their jitter is per REQUEST, and the reason they wrote next to it
 * (`:121-122`) is per-PROCESS: it is anti-thundering-herd between agents that
 * wake together against a shared ceiling, not a spacer inside one call.
 *
 * The paid replay sleeps too, and that is the same correction. It was going to
 * be the one exception here, on the argument that delaying a signed envelope
 * widens the window in which a crash loses a receipt. Measured against the
 * numbers, that argument does not hold: the challenge this client answers
 * carries `maxTimeoutSeconds: 120`, so 400 ms is a third of a percent of the
 * envelope's own validity, while the herd argument applies to the replay in
 * full — 27 agents that get their 402 in the same second replay in the same
 * second. One rule with no exception, and nothing in the money path is
 * measurably worse for it.
 *
 * ## 🔴 `Math.random`, and never `crypto.getRandomValues`
 *
 * This is dispersion, not a secret. Nothing about the delay needs to be
 * unguessable: an adversary who predicts that this process will wait 213 ms
 * learns nothing worth knowing, and cannot use it. Reaching for a CSPRNG here
 * would be worse than useless — it tells the next reader that unpredictability
 * is a security property of this value, which invites them to "harden" a
 * sleep. `Math.random` is uniform enough for spreading arrivals, is available
 * in every runtime this package targets (browser included), and costs nothing.
 */

/**
 * How long to wait, in milliseconds: a uniform draw from `[0, maxMs)`.
 *
 * Pure, so it is tested exhaustively without a clock. `random` is injectable for
 * exactly that reason and for no other — production always passes `Math.random`.
 *
 * Garbage in gives the caller's own configured default nothing to stand on, so
 * this function's contract is narrow: it clamps rather than throws. A `maxMs`
 * that is not a finite positive number yields `0`, because a library that dies
 * at read time over a mistyped option is worse than one that does not sleep.
 * The decision about what a garbage OPTION means (fall back to the default, not
 * to off) belongs one level up, in `DescribeClient` — see `jitterMs` there.
 */
export function jitterDelayMs(maxMs: number, random: () => number = Math.random): number {
  if (!Number.isFinite(maxMs) || maxMs <= 0) return 0;
  const draw = random();
  if (!Number.isFinite(draw) || draw < 0) return 0;
  return Math.min(draw, 1) * maxMs;
}

/**
 * The only timer in this package.
 *
 * `setTimeout` and not a busy loop, obviously — but also not `unref()`d: a
 * process that exits while a read is pending would have dropped that read
 * anyway, and `unref` is Node-only, which would break the browser target this
 * package keeps.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
