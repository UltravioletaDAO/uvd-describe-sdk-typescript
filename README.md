# uvd-describe-sdk

Read reputation from [describe.net](https://describe.net) — the ERC-8004 reputation
index of Ultravioleta DAO, across 11 chains.

```bash
npm install uvd-describe-sdk
```

**Zero runtime dependencies.** The free routes need no package, no credential and
no account. Metered routes pay their 402 through
[`uvd-x402-sdk`](https://www.npmjs.com/package/uvd-x402-sdk), which lives behind
the `uvd-describe-sdk/x402` subpath and is an *optional* peer — install it only
if you pay.

---

## Sixty seconds

```ts
import { DescribeClient, formatScore } from 'uvd-describe-sdk';

const describe = new DescribeClient({
  product: 'my-app',                                    // shows up in their logs
  onFailure: (f) => console.warn('describe.net:', f.kind, f.path),
});

const rep = await describe.wallet('0x97cd97cfe21799bacbf39d0a53469e5f82f30996');

if (rep === null) {
  // describe.net could not be reached. This is NOT "no reputation".
} else if (rep.globalScore === null) {
  // No eligible rating. That IS the answer — never render it as 0.
} else {
  console.log(formatScore(rep.globalScore));   // "100"
  console.log(rep.policyVersion);              // "equal-weight-per-chain@2"
  console.log(rep.caveats);                    // [{ code, text }, ...]
}
```

And the version with no JavaScript at all, which is most of what most pages need:

```html
<img src="https://api.describe.net/badge/0x97cd…0996.svg" alt="describe.net reputation">
```

---

## The API

| Method | Cost | Route | If describe.net is down |
|---|---|---|---|
| `wallet(address)` | **free** | `GET /wallets/{w}/chains` | `null` + `onFailure` |
| `leaderboard()` | **free** | `GET /leaderboard` | `null` + `onFailure` |
| `health()` | **free** | `GET /health` | `null` + `onFailure` |
| `badgeUrl(address)` | **no network** | builds a `/badge/{w}.svg` URL | cannot fail |
| `profileUrl(address)` | **no network** | builds a describe.net profile URL | cannot fail |
| `walletBreakdown(address)` | $0.01 | `GET /reputation/wallet/{w}` | **throws, always** |
| `agent(network, agentId)` | $0.02 | `GET /reputation/agent/{n}/{id}` | **throws, always** |

Prices are documentation with a date on them (2026-08-30). What gets paid is
what the live 402 challenge says — this package never types a price into a code
path.

🔴 **The two metered methods return no `null` at all** — not for an outage, not
for a 404, and not even when you set `failOpen: true` yourself. See
[Failures](#failures): the line is not how many methods, it is whether there was
money in flight.

---

## The four things that will bite you

### 1. `null` is never `0`

"There is no evidence" and "they were rated badly" are different facts and the
index refuses to collapse them. A wallet with no ERC-8004 identity answers
**HTTP 200** with `global_score: null` — verified live against `0xdEaD…BEEF`.

```ts
const rep = await describe.wallet(unknownWallet);
rep.globalScore          // null
formatScore(rep.globalScore)   // null — never "0", never "—"
```

Rendering that as `0` publishes "worst possible reputation" for "nobody has
rated this yet". Choosing what absence *looks* like is your job, per surface —
which is why `formatScore` hands you `null` instead of picking for you.

### 2. Three different absences

```ts
const rep = await describe.wallet(w);

rep === null            // we could not ask       (failOpen; onFailure fired)
rep.globalScore === null // they answered: no evidence
                         // a throw = your request was wrong, or a 402 arrived
```

A fail-open that says nothing turns the first into the second. That is why
`onFailure` exists and why you should always pass it. The invariant, in one
line: **`onFailure` fires if and only if a method hands you `null` instead of an
answer.** On the metered routes it therefore never fires — they have no `null`.

### 3. Branch on `caveat.code`, never on `caveat.text`

The index declares it: **the text may change without notice — the code never
will.** It already happened: a threshold was re-worded on 2026-08-25 and every
consumer matching on prose broke silently that day.

```ts
import { hasCaveat, CAVEAT_CODES } from 'uvd-describe-sdk';

if (hasCaveat(rep, 'burn-address')) { /* nobody controls this address */ }
if (hasCaveat(rep, 'few-raters'))   { /* thin evidence */ }
```

The eight codes are exported and typed: `no-score`, `concentration-degraded`,
`single-rater`, `few-raters`, `top-client-share`, `campaign-per-rater`,
`self-rated`, `burn-address`. The union stays **open**, so a ninth code the
server adds tomorrow will not be a type error in code you already shipped.

⚠️ On free routes `caveats: []` means *no **public-data** caveat*, not "clean" —
the evidence-quality cuts need the grain and ride the metered routes. Check
`rep.caveatScope` (`public-data-subset` vs `full`) before calling anything
clean.

### 4. One display format, ecosystem-wide

**Two decimals, trailing zeros trimmed.** `86.65`, `84.7`, `87` — never `82.0`.

```ts
formatScore(86.653045)  // "86.65"
formatScore(83.0)       // "83"      <- the witness case
```

Decided by measurement on 2026-08-29, after the three consumers rendered the
same number three ways (`86.653045`, `86.7`, `86`). Over 47 real scores,
rounding to 0 decimals merges 23 pairs of *different* agents into identical
strings. `83.0 → "83"` is the one value that tells the candidate rules apart —
`toFixed(2)` gives `"83.00"`, `toFixed(1)` gives `"83.0"`.

The API keeps serving full precision. Compute with the number, format at the
pixel.

---

## Failures

```ts
const describe = new DescribeClient({
  failOpen: true,                  // the default
  onFailure: ({ kind, path, transient }) => metrics.increment(kind),
});
```

`failOpen: true` (Saul, 2026-08-28: *"pon un fallback si es que describe está
caído"*) returns `null` for a **describe.net-side** failure on a **free route**
and announces it. It does **not** swallow your own bugs, and it does **not**
apply to the metered routes at all:

| `kind` | free routes | metered routes | `transient` | what it is |
|---|---|---|---|---|
| `timeout` | fail-open | **throws** | yes | their cold start (measured 15,2 s) or a slow index |
| `http_5xx` | fail-open | **throws** | yes | their fault |
| `unreachable` | fail-open | **throws** | yes | DNS, reset, offline, CORS |
| `unparseable` | fail-open | **throws** | no | they answered, unreadably. Retrying buys nothing |
| `http_4xx` | **throws** | **throws** | only 429 | **your** request. 422 `not_an_address` is the common one |
| `not_found` | `null`, announced | **throws** | no | absence. Free routes have a `null` to degrade into; metered ones do not |
| `payment_required` | — | **throws** | no | metered route, no `payer` configured. Carries the challenge |
| `payment_refused` | — | **throws** | no | `DO_NOT_PAY` — the challenge named a treasury that is not ours |

With `failOpen: false` the free routes throw instead. `not_found` on a free
route never throws either way: `failOpen` is about *their outage*, absence is a
different axis.

### 🔴 Why the metered routes never fail open

Because the line is **money**, not symmetry.

`walletBreakdown()` and `agent()` sign a payment and then wait for an answer. In
that window the USDC has already moved — describe.net's paywall settles *before*
it runs your query. Handing back `null` there tells you *"there was nothing to
fetch"* about a call that just spent your money, and nothing distinguishes the
two. That is not degrading gracefully; it is a spent credential with no receipt.

⚠️ **This is a correction of what 0.1.0 shipped**, left written down because it
is the reason the rule exists: those two methods used to return `WalletBreakdown
| null` and swallow every service failure. Measured against a dead port on
2026-08-30, a timeout on a metered route returned `null`.

A loud failure after paying is recoverable — retry, log, or claim. A silent
`null` is not. So no flag can buy the right to swallow it, `failOpen: true`
included: availability is your preference, a settled payment is a fact.

```ts
import { failedAfterPaying } from 'uvd-describe-sdk';

try {
  const detail = await describe.walletBreakdown(wallet);
} catch (err) {
  if (failedAfterPaying(err)) {
    // A signed envelope had already left. err.payment tells you how bad:
    //   settlement: 'settled'  -> proof: err.payment.receipt is the tx hash
    //   settlement: 'unknown'  -> the SDK cannot tell. Reconcile, do not assume
    reconcile(err.payment.receipt, err.payment.amount, err.payment.token);
  } else {
    // Nothing was transmitted: a 402 with no payer, a DO_NOT_PAY, a 404, a
    // payer that declined. You spent nothing — retry freely.
  }
}
```

`settlement` is never `'not settled'`, and that omission is deliberate: an
unhandled 500 is rendered above the paywall middleware and carries no receipt
even though the money moved, and `fetch` rejects identically whether the request
bytes were written or not. `'unknown'` means *ask the chain*, not *nothing
happened*.

---

## Paying

```ts
import { DescribeClient } from 'uvd-describe-sdk';
import { payerFromX402Client } from 'uvd-describe-sdk/x402';
import { X402Client } from 'uvd-x402-sdk';

const x402 = new X402Client();
await x402.connectWithPrivateKey(process.env.PAYER_PRIVATE_KEY!, 'base');

const describe = new DescribeClient({
  product: 'my-app',
  payer: payerFromX402Client(x402),
});

const detail = await describe.walletBreakdown(wallet);   // never null — it throws
detail.payment;   // { receipt: 'rcpt_…', reused: false }
```

🔴 **The key comes from the environment.** Never a literal, not even "just for a
test" — bots scan public repos for `0x` + 64 hex and drain in minutes.

What happens under the hood, in order:

1. Ask with no header. **Asking is free and is the intended first move.**
2. Read the challenge (header first, then body).
3. **Verify who we are about to pay.** The `payTo` of the top-level recipient
   *and of every `accepts[]` entry* must be the pinned treasury. One stranger
   anywhere in the list refuses the whole challenge and signs nothing.
4. Hand the challenge to your payer. This SDK never signs, never builds an
   EIP-3009 authorization, never touches a key.
5. Replay the identical request with `X-PAYMENT`, and surface
   `X-Payment-Receipt` / `X-Payment-Reused` as `result.payment`.

Step 4 is the line that changes what a failure means. Everything before it costs
nothing if it fails; everything after it may have cost real USDC, and those
failures carry `error.payment` so you never have to guess which side you landed
on.

Bring your own wallet with `payerFrom(challenge => Promise<string>)` — a browser
wallet, a custodial signer, a queue that asks a human. No `uvd-x402-sdk` needed.

**Free first.** The 402 challenge says it in its own words: *"si ahí no hay
nada, no hay nada que comprar"*. Call `wallet()` before you buy the
decomposition.

---

## What this package deliberately does not do

**No `getScore(): number`.** Every result carries `policyVersion`, `caveats[]`
and its source. *Un score sin sus calificadores es un rumor* — a bare-number
helper would erase the reason the index exists. Take the number off the object
by hand; the friction is the point.

**No cache.** MeshRelay has one (a `Map`, 12-minute TTL) because its refresh
route is reachable from the internet and an uncached lookup would let a stranger
burn a rate limit that has no per-partner bucket. Execution Market and
KarmaKadabra have none. A TTL baked in here would hand you a staleness you did
not choose:

```ts
// MeshRelay's shape, if you need it: async refresh, sync read, never both.
const cache = new Map<string, { rep: WalletReputation | null; at: number }>();
const key = (w: string) => (/^0x[a-fA-F0-9]{40}$/.test(w) ? w.toLowerCase() : w);
//          EVM is case-insensitive, Solana base58 is NOT. Never lower() blindly.
```

**No retry.** MeshRelay retries a transient failure at most *once*: "hammering a
permanent failure is how EM turned one error into a four-hour storm." Build the
policy you want on `error.transient`, which is a fact rather than a string
match.

**No writes.** This SDK reads. It never rates anyone, signs nothing on-chain and
holds no key.

---

## Configuration

| Option | Default | Why that value |
|---|---|---|
| `baseUrl` | `https://api.describe.net` | |
| `timeoutMs` | `30_000` | Above their 15,2 s cold start, above the 29 s API-Gateway ceiling, and deliberately ≠ the facilitator's 45 s so two clocks never race. An 8 s timeout already broke a real integration |
| `product` | — | Appended to the `User-Agent`. The rate limit is shared with no per-partner bucket, so the UA is what makes your share attributable. The limit itself is not repeated here — the `RateLimit-Policy` response header is the authority (it read `50;w=1;burst=40` on 2026-08-30) |
| `failOpen` | `true` | |
| `onFailure` | — | Pass it. See above |
| `payer` | — | |
| `expectedPayTo` | the pinned treasury | Override only if you verified a rotation out of band |

Never hardcode a threshold. `health()` publishes the live `readingPolicy` and
`confidenceThresholds` precisely so nobody re-types them.

---

## Types

Hand-written, and tied to the schema by two gates rather than by a generator:

- `npm test` — offline, compares the types against a pinned
  `schema/openapi.snapshot.json`. Answers *did we drift?*
- `npm run schema:check` — re-fetches the live OpenAPI and diffs it. Answers
  *did they move?*

Two failures, two gates. A generator collapses both into "the build broke" and
tells you neither — and cannot carry the one thing that matters most here, which
is *why* a `null` is a `null`. See the header of `src/types.ts`.

Every result also keeps `raw`: the exact payload as served. A field this SDK
version has not heard of is still there, so you are never blocked on our release
cycle.

---

## Development

```bash
npm install
npm test              # offline. 93 tests, no network
npm run typecheck
npm run lint
npm run build
npm run smoke         # real call to the live API — FREE routes only
npm run schema:check  # is the live schema still what we typed?
```

`npm run smoke` never touches a metered route and has no flag to make it. The
safest way to not spend USDC by accident is to not write the code that could.

## License

MIT © Ultravioleta DAO
