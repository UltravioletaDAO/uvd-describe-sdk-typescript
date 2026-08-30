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
| `npm test` | vitest, **offline**. 84 tests in ~0,7 s |
| `npm run typecheck` | `tsc --noEmit` |
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
                402 flow)   ├──> caveats.ts  (the 8 frozen codes)
                            └──> format.ts   (R8: 83.0 -> "83")

  x402/index.ts   the ONLY file that knows uvd-x402-sdk exists.
                  `import type` only, so the built JS imports NOTHING.
```

### Who owns what

| Module | Owns, exclusively |
|---|---|
| `config.ts` | Every calibrable number and the pinned treasury. Nothing else re-types them |
| `errors.ts` | The failure taxonomy AND the single predicate that decides what `failOpen` swallows |
| `caveats.ts` | The eight codes, as an exported contract. Open union, never closed |
| `format.ts` | How a score is written down. Two functions, no state |
| `parse.ts` | Wire JSON → typed. The only place a `null` could be lost, so it is the place to look when one is |
| `client.ts` | HTTP, timeouts, fail-open, the 402 dance, the treasury check |
| `x402/index.ts` | The payer adapter. Type-only import — nothing at runtime |

## Invariants — breaking any of these is the bug this package exists to prevent

1. **`null` is never `0`.** Every `|| 0` in `parse.ts` is an invariant violation
   waiting for its first unrated wallet. `optNumber` is the only path a score
   may take.
2. **No function returns a bare score.** Adding a `getScore(): number` erases
   the product's thesis. Every result carries `policyVersion` + `caveats[]`.
3. **The three absences stay distinct**: a returned object with a `null` score
   (no evidence), a `null` return (we could not ask), and a throw (your bug or a
   402). Collapsing any two is the failure mode.
4. **A fail-open is announced.** `onFailure` fires *before* `null` is returned.
   Move it below the return and "describe is down" silently becomes "this
   wallet has no reputation".
5. **We never sign.** No EIP-3009, no key, no envelope. The payment is
   `uvd-x402-sdk`'s, always — upstream-first. If it lacks something, it is
   added THERE and consumed here. Never patched in this repo.
6. **The treasury check runs before the payer is called**, over the top-level
   recipient *and* every `accepts[]` entry.
7. **The built entries have zero runtime imports.** Asserted in CI, not
   promised. It is the whole reason a free-only consumer installs nothing.
8. **A 404 never reaches a caller as an exception.** `DescribeNotFound` is not
   exported from `index.ts` for exactly this reason: the rule is structural.
9. **`SDK_VERSION` equals `package.json`.** A test asserts it. A User-Agent that
   lies about its version is worse than none.

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

**`process.exit(0)` right after `fetch` crashes on Windows.** Measured on Node
v23.11.0, 2026-08-30: `refresh-schema.mjs` printed `OK` and then died with
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
c:\ws\deps\uv\src\win\async.c, line 76`, reporting **exit 127**. A CI trusting
the status code would call a passing check a failure forever. Fix: set
`process.exitCode` and let Node drain undici's sockets.
What separates it from its neighbour: the output says `OK` and the exit code
says failure. If the two disagree, it is teardown, not the check.

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
- 🔴 **The "riel gratis" for our own products.** On 2026-08-14 Saul said
  Execution Market, MeshRelay and KarmaKadabra should read for free while third
  parties pay x402. The service has no accounts and no API keys — *"el pago es
  la autenticación"* — so there is no way to tell them apart. **Do not invent a
  partner header.** It is a question for Saul.
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
