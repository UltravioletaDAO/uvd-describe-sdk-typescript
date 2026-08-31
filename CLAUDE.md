# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

> This file is the map, not the source. The source is the docstrings: every
> module here opens by defending **why** it is built this way, with the
> measurement that decided it. Before touching `client.ts`, `errors.ts`,
> `types.ts` or `caveats.ts`, read their first 40 lines — they are written for
> you.

---

## What this is

The TypeScript client for [describe.net](https://describe.net), the ERC-8004
reputation index. It **reads**. It never writes on-chain, never signs, never
holds a key, and never computes a score of its own.

The service it wraps lives in `Z:\ultravioleta\dao\describe-net` (a separate
repo, deliberately: a fix to this client's types must not drag the service's
deploy — zip → 2 Lambdas → Terraform → site — behind it).

## Commands

| Command | What it does |
|---|---|
| `npm install` | 209 packages, ~14 s. All dev — the package itself ships **zero** runtime deps |
| `npm test` | vitest, **offline**. **168 tests in ~1,8 s** (re-measured 2026-08-30 after absorbing the three ecosystem contributions; were 111 in ~0,9 s before them, 93 before the partner rail of the same day, 84 before the paid-route fix). ~0,5 s of the increase is real timers: the jitter's placement can only be asserted from outside, so four tests sleep on purpose (three in `client.test.ts`, one in `jitter.test.ts`). Every client in the suite is built through a `testClient()` helper that sets `jitterMs: 0` — copy that line into your own suite |
| `npm run typecheck` | `tsc --noEmit` — **excludes `*.test.ts`**. The gate that covers the tests is `npx tsc --noEmit -p tsconfig.eslint.json`, and it is what proves `walletBreakdown()` / `agent()` are not nullable (the test file assigns them to a non-nullable type with no `!`). Run it if you touch a public signature |
| `npm run lint` | eslint |
| `npm run build` | tsup → cjs + esm + dts, two entries |
| `npm run smoke` | **real** call to the live API. FREE routes only. Needs `npm run build` first |
| `npm run schema:check` | re-fetch the live OpenAPI, diff against the snapshot |
| `npm run schema:refresh` | write the new snapshot (then run the tests) |

One test file: `npx vitest run src/client.test.ts`.

🔴 **`npm test` never touches the network, and that is a rule, not an accident.**
A suite that goes red because someone's wifi dropped teaches people to ignore
red. The two networked checks are separate commands and separate CI jobs on
purpose. If you add a test that fetches, you have broken this.

🔴 **No test may spend USDC.** `smoke-free.mjs` touches exactly one metered
route and only to receive its 402 — asking is free. There is no flag to make it
pay, deliberately.

## Architecture

```
                       config.ts  (the ONLY place a calibrable value lives)
                            │
  index.ts ──> client.ts ──┼──> parse.ts ──> types.ts
   (public)    (fetch,      │     (wire→typed)   (hand-written + schema gate)
                failOpen,   ├──> errors.ts   (the taxonomy + failOpenCovers)
                402 flow,   ├──> caveats.ts  (the 8 frozen codes)
                jitter)     ├──> format.ts   (R8: 83.0 -> "83")
                            ├──> jitter.ts   (the sleep before every request)
                            ├──> hashes.ts   (is this shaped like a hash?)
                            └──> raters.ts   (distinct raters, without the two
                                              wrong reconstructions)

  x402/index.ts     pays a 402. Knows uvd-x402-sdk by `import type` ONLY, so the
                    built JS imports NOTHING.
  partner/index.ts  does NOT pay: signs ERC-8128 as an allowlisted wallet. The
                    ONE entry with a real runtime import, and it is exactly
                    `uvd-x402-sdk/erc8128` — asserted in CI, not promised.
```

### Who owns what

| Module | Owns, exclusively |
|---|---|
| `config.ts` | Every calibrable number and the pinned treasury. Nothing else re-types them |
| `errors.ts` | The failure taxonomy, the predicate that decides what `failOpen` swallows (`failOpenCovers`, free routes only) and the one that says whether a signed envelope was already in flight (`failedAfterPaying` / `PaymentAttempt`) |
| `caveats.ts` | The eight codes, as an exported contract. Open union, never closed |
| `format.ts` | How a score is written down. Two functions, no state |
| `jitter.ts` | The draw and the only `setTimeout` in the package. Pure `(maxMs, random) → ms`, so its bounds are tested without a clock. KarmaKadabra's 0,4 s, `Math.random` and **never** a CSPRNG |
| `hashes.ts` | Whether a string is shaped like an on-chain id — the UNION of EVM hex, Solana base58 and a bare digest, plus the receipt's `pending`. Also the rule about which fields are NOT checked (`build_sha`) and why |
| `raters.ts` | One function. Its docstring is the deliverable: the per-chain maximum understates and the per-chain sum double-counts, both measured |
| `parse.ts` | Wire JSON → typed. The only place a `null` could be lost, so it is the place to look when one is |
| `client.ts` | HTTP, timeouts, fail-open, the 402 dance, the treasury check |
| `x402/index.ts` | The payer adapter. Type-only import — nothing at runtime |
| `partner/index.ts` | The partner rail: chain id, nonce, and a forward to `uvd-x402-sdk`'s ERC-8128 signer. **Zero cryptography of its own**, and the only guard it adds is the private-key shape check, which exists because ethers leaks an unredacted key on the malformed-input path (measured — read the docstring) |

## Invariants — breaking any of these is the bug this package exists to prevent

1. **`null` is never `0`.** Every `|| 0` in `parse.ts` is an invariant violation
   waiting for its first unrated wallet. `optNumber` is the only path a score
   may take.
2. **No function returns a bare score.** Adding a `getScore(): number` erases
   the product's thesis. Every result carries `policyVersion` + `caveats[]`.
3. **The three absences stay distinct**: a returned object with a `null` score
   (no evidence), a `null` return (we could not ask), and a throw (your bug or a
   402). Collapsing any two is the failure mode.
4. **Everything swallowed is announced.** `onFailure` fires for the two things
   that would otherwise disappear without a trace: a `null` handed back instead
   of an answer (fired *before* the `null`, free routes only) and a hash field
   dropped because it was not a hash (`kind: 'malformed_hash'`, metered routes).
   Move the first below the return and "describe is down" silently becomes "this
   wallet has no reputation"; drop the second and a 200 that did not do the thing
   reads as a 200.
   ⚠️ **Restated 2026-08-30 and the old wording is left because someone will look
   for it**: it read *"fires if and only if a `null` is returned… the metered
   methods never call it"*. That described the only case that existed rather than
   the rule, which is that nothing vanishes quietly — and a field that vanished
   out of a 200 is exactly as invisible as a silent fail-open. What has NOT
   changed: a failure that reaches the caller as a throw is never announced here,
   and the metered routes still never fail open (4b). A consumer who pages only
   on outages filters one line: `if (f.kind === 'malformed_hash') return;`.
4b. 🔴 **The paid routes never fail open.** `walletBreakdown()` and `agent()`
   return `WalletBreakdown` / `AgentReputation`, not `| null`, and throw on
   every failure **including with `failOpen: true` explicitly set**. The line is
   *was there money in flight*, not *how many methods*. ⚠️ This corrects 0.1.0,
   which ran them through `guard()` → `failOpenCovers()`: measured 2026-08-30
   against a dead port, a timeout on a metered route returned `null` while the
   paywall settles **before** running the query
   (`describe-net/describenet/paywall.py:1031-1047`) — a spent credential with
   no receipt. A failure with a signed envelope already in flight carries
   `error.payment` (`PaymentAttempt`); its **absence** states that nothing was
   transmitted. `failedAfterPaying()` is the predicate.
4c. 🔴 **The partner rail never degrades into paying.** With `partner`
   configured, a signer that throws is `DescribePartnerUnsigned` (raised on the
   FREE routes too, `failOpen` or not) and a 402 that arrives anyway is
   `DescribePartnerRejected`, raised **before** `payer.pay()` so nothing is
   spent. Both are `serviceFault: false`, which is what keeps `failOpenCovers()`
   away from them. `partnerFallsBackToPaying: true` is the explicit opt-out.
   Same shape as 4b with the sign flipped: there, money that ALREADY moved may
   not be swallowed; here, money that is ABOUT to move may not be spent by
   accident. Injected both bugs on 2026-08-30 and the tests went red — the
   fall-through one resolved with data instead of rejecting, the
   sign-inside-the-try one resolved to `null` on a free route.
5. **We never sign a PAYMENT, and we never sign at all in this package.** No
   EIP-3009, no key, no envelope — and, since the partner rail, no RFC 9421
   canonicalisation either: `partner/index.ts` picks a chain id and a nonce and
   forwards to `uvd-x402-sdk/erc8128`. Upstream-first. If the payment SDK lacks
   something, it is added THERE and consumed here. Never patched in this repo.
   ⚠️ The one thing `partner/index.ts` does add is an input guard, and it is not
   an exception to this rule: it validates the private-key SHAPE before handing
   it over, because ethers 6.17.0 puts an unredacted key in its exception on the
   malformed-input path (measured 2026-08-30). Refusing to pass garbage
   downstream is not reimplementing what is downstream.
6. **The treasury check runs before the payer is called**, over the top-level
   recipient *and* every `accepts[]` entry.
7. **Each built entry imports exactly its declared set.** Asserted in CI, not
   promised. ⚠️ Reworded 2026-08-30; it read *"The built entries have zero
   runtime imports"*, and for `index` and `x402/index` it still means exactly
   that — the whole reason a free-only consumer installs nothing. The partner
   rail added a third entry that genuinely needs the payment SDK at runtime, and
   the check did **not** get an exemption for it: `partner/index` declares
   `['uvd-x402-sdk/erc8128']` and CI fails both if something else appears there
   AND if that import disappears, which is what `external` breaking and the
   dependency getting bundled would look like.
8. **A 404 never reaches a caller as an exception — on the FREE routes.**
   ⚠️ Corrected 2026-08-30; the old text read *"A 404 never reaches a caller as
   an exception. `DescribeNotFound` is not exported from `index.ts` for exactly
   this reason: the rule is structural"*. It stopped being true when the metered
   methods lost their `| null`: with no absence value left, a 404 on
   `walletBreakdown()` / `agent()` arrives as a throw, and the class **is** now
   exported so `instanceof` works. It is still absence, not failure — same
   `not_found`, `transient: false`, `serviceFault: false`, and **no `payment`**,
   because a 404 is read before the challenge is and costs nothing.
9. **`SDK_VERSION` equals `package.json`.** A test asserts it. A User-Agent that
   lies about its version is worse than none.
10. **A hash field is checked by SHAPE, and absent ≠ malformed.** Added
   2026-08-30 from KarmaKadabra's *"el 200 sin tx"*. A value that is not shaped
   like an on-chain id becomes `null`, its wire name goes into the owning
   object's `malformedHashes`, and `onFailure` says so (4). It never throws: one
   accessory field must not destroy an answer that was paid for. It never passes
   through either — that is the bug. **Read the list, not the `null`**: a `null`
   with an empty list means the index has not written it yet, which is documented
   and normal.
   🔴 The predicate is the UNION of what the index really emits, never one EVM
   regex — Solana serves base58 in the same `tx_hash` column
   (`solana_indexer.py:436` → the INSERT at `indexer.py:153-157`), so an
   EVM-only check would flag every Solana rating in the index. **The false
   positive is the expensive direction**: an alarm that screams about good data
   gets ignored, and then it is silent on the day it is right. Same rule decides
   what is NOT checked: `build_sha` can legitimately read `<sha>-dirty`
   (`scripts/build_lambda_zip.py:64`), so nothing validates it. Validate the ids
   a caller carries somewhere to verify; leave alone the strings that describe a
   build.

## Measured traps

**`Boolean([])` is `true` in JavaScript.** describe.net's free routes carry
`security: []` — an explicit "no scheme applies" — not a missing `security`. The
obvious `Boolean(op.security)` check marks all 13 free routes as **paid**. This
one bit during the first test run of this repo (2026-08-30): `types.schema.test.ts`
went red on `/health`, `/leaderboard` and `/badge/{w}.svg`. The predicate has to
be LENGTH.

Reproduce: `node -e "console.log(Boolean([]))"` → `true`.
What separates it from its neighbour: Python's `bool([])` is `False`, so the
same check written in the recon phase read *correctly* and the JS one did not —
if a schema fact disagrees between a Python note and this repo, this is the first
thing to suspect.

**🔴 ethers redacts a bad private key on ONE path and prints it verbatim on the
other.** Measured 2026-08-30 with `ethers` 6.17.0 (what `uvd-x402-sdk` 2.75.0
pulls in). A key that is well-formed hex but not a valid scalar reaches the
`SigningKey` check and comes back redacted; a key that is not valid hex — a
trailing newline, a stray space, a typo — fails EARLIER, inside `getBytes`,
and its message contains the whole value.

Reproduce (this prints a synthetic key, never a real one):
```bash
node -e "const {ethers}=require('ethers');
try{new ethers.Wallet('0x'+'ab'.repeat(32)+'\n')}catch(e){console.log(e.message)}"
# invalid BytesLike value (argument="value", value="0xabab…ab\n", …)   ← the key
node -e "const {ethers}=require('ethers');
try{new ethers.Wallet('0x'+'11'.repeat(20))}catch(e){console.log(e.message)}"
# invalid private key (argument="privateKey", value="[REDACTED]", …)
```
Why it matters: the leaky case is the LIKELY one. `KEY=$(cat file)` keeps the
newline. `partnerFromEnv()` therefore trims and checks
`^(0x)?[0-9a-fA-F]{64}$` before the key reaches the SDK, so the only thing that
can reach ethers is 64 hex characters and the only branch it can take is the
redacted one. Reported upstream; deliberately not patched there from this repo.

What separates it from its neighbour: both errors say "invalid" and both name a
private key. The one that leaks says `BytesLike` and `argument="value"`; the
safe one says `private key` and `argument="privateKey"`. If you are reading a
log to decide whether a key was exposed, that word is the whole answer.

**`process.exit(0)` right after `fetch` crashes on Windows.** Measured on Node
v23.11.0, 2026-08-30: `refresh-schema.mjs` printed `OK` and then died with
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
c:\ws\deps\uv\src\win\async.c, line 76`, reporting **exit 127**. A CI trusting
the status code would call a passing check a failure forever. Fix: set
`process.exitCode` and let Node drain undici's sockets.
What separates it from its neighbour: the output says `OK` and the exit code
says failure. If the two disagree, it is teardown, not the check.

**🔴 A hash validator that only knows `0x` + 64 hex flags an entire chain.**
Measured 2026-08-30 from both ends. From the writer:
`describe-net/describenet/solana_indexer.py:436` puts a base58 **signature**
into the `tx_hash` column of the INSERT at `indexer.py:153-157` — the same
column the EVM indexer fills with `0x…`, because Solana writes to the same
tables on purpose. From the wire: `GET /feed?network=solana&limit=4` served
87- and 88-character strings with no prefix. So `hashes.ts` validates the UNION
of the shapes and its tests use signatures pulled off the live feed, never
synthetic ones.

Reproduce: `curl -s "https://api.describe.net/feed?network=solana&limit=2"` and
read `tx_hash`.
What separates it from its neighbour: this failure is a FALSE POSITIVE — the
alarm fires on good data, forever, until somebody learns to ignore it, and then
it is silent on the day it is right. Its neighbour is the same shape one field
over and lands on the opposite verdict: `build_sha` is deliberately NOT
validated, because `describe-net/scripts/build_lambda_zip.py:64` stamps
`sha + ("-dirty" if sucio else "")` and a legitimate deploy can publish
`<40 hex>-dirty`. Before adding a field to the checked set, ask what its
WEIRDEST legitimate value looks like — not what its normal one does.

**`/leaderboard` takes no parameters.** `?limit=2` answers **422**
`leaderboard_takes_no_params`. Paging is the metered `/leaderboard/page`.

**An unregistered wallet is a 200, not a 404.** `chains: []`,
`global_score: null`, `distinct_raters: null`. A malformed one is a **422**
`not_an_address`. So the two failures a caller confuses — "no such wallet" and
"that is not a wallet" — arrive as completely different statuses.

## Conventions

- **Docstrings defend the decision with the measurement that produced it.** The
  *why* and the *failure mode*, not the *what*. If you correct an old claim,
  **leave the correction written next to it** — do not delete it.
- **Every figure is read live or carries its date.** Never type a total of the
  index into a comment without one.
- **Commits in Spanish**, conventional (`feat(scope):`), with the measured
  evidence in the body and the trailer
  `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **Never `git add -A`** — stage by file.
- **Never hardcode a private key**, not even in an example. `process.env` only.
- A test that proves nothing unless it can go red is not a test: mount the bad
  state and confirm. Several tests here are named `MOUNTS THE BAD STATE` and
  that is what they do.

## Open questions — do not resolve these alone

- **The name.** `uvd-describe-sdk` is a hypothesis. Saul never named it.
- **One repo or two.** Saul said "**un** repositorio" (singular). This is one of
  two (TS + Python), following the house precedent of one repo per language
  (`uvd-x402-sdk-typescript` / `uvd-x402-sdk-python`). He has to ratify the
  deviation.
- ⚠️ ~~🔴 **The "riel gratis" for our own products.** On 2026-08-14 Saul said
  Execution Market, MeshRelay and KarmaKadabra should read for free while third
  parties pay x402. The service has no accounts and no API keys — *"el pago es
  la autenticación"* — so there is no way to tell them apart. **Do not invent a
  partner header.** It is a question for Saul.~~ **RESUELTA 2026-08-30, y la
  vieja queda escrita porque su prohibición sigue vigente.** Saul la contestó en
  el servicio, no acá: `describe-net/describenet/partner.py` es una allowlist de
  DIRECCIONES PÚBLICAS más una firma ERC-8128 por request. Nadie inventó un
  header — este SDK habla el gate que ya existía. La prohibición no se levantó:
  sigue prohibido inventar un mecanismo de identidad acá; lo que se hace es
  implementar el del servicio. Si el gate cambia, cambia allá primero.
  Implementado en `src/partner/`, subpath `uvd-describe-sdk/partner`.
- **Whether the three consumers will adopt this.** They work today against the
  raw API. Nobody has asked them.

## What is NOT published

As of 2026-08-30: nothing. No GitHub repo, no npm package, no tag. The publish
workflow is prepared and unarmed. Saul gives that go-ahead separately.

If you get there: this package has **never** been published, which makes it the
one moment where npm trusted publishing (OIDC, no stored token) can be set up
*before* a long-lived token ever exists. Read the comment in
`.github/workflows/publish.yml` — the sibling Python repo carries a comment
claiming it uses OIDC while its code passes a token, and that mistake should not
be inherited a third time.
