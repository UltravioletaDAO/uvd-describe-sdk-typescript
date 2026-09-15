# Changelog

Newest first. A version listed here is a version on `main`, **not** a version on
npm: publishing is a `vX.Y.Z` tag, and the tag is pushed by whoever releases,
never by the change that bumps the number.

This file starts at 0.4.0. The versions before it are summarised from their
commits, so they are shorter than they deserve — `git log` has the measurements.

## 0.4.0 — 2026-09-15 (not published yet)

Types what describe.net has served since 2026-09-14 (`describe-net` PR #21,
deployed in `aa1bd75`). Upstream-first: this version exists so that Execution
Market, KarmaKadabra, MeshRelay and karma-hello adopt the fields through the SDK
instead of reading them by hand. The Python twin (`uvd-describe-sdk` 0.6.0) ships
the same contract in its own spelling — same states, same refusals, same class
name for the error. The one intended difference is the wording of that error's
`recovery`, which names each language's own API.

### Breaking — only for code that builds these objects by hand

- `WalletReputation.caveatsNotComputed` and `Rating.authorClass` are
  **required** properties. An object literal typed as `WalletReputation`,
  `Rating`, or `AgentReputation` (through `ratings`) that compiled against 0.3.0
  no longer compiles against 0.4.0: `TS2741: Property 'caveatsNotComputed' is
  missing` / `Property 'authorClass' is missing` (measured with `tsc --strict`).
  Typically a test fixture or a mock. Fix: add the two fields, or build the
  object from a payload with `parseWalletReputation()` / `parseAgentReputation()`,
  which fill them.
- If you have nothing to put there, write `null` in both — never `[]`, which
  claims every cut was evaluated, and never `'rater-authored'`, which claims a
  signer the index cannot vouch for.
- They stay required on purpose, and what the parsers return is unchanged.
  Making them optional would add a fourth state, `undefined`, to every result
  of `wallet()` and `agent()`, next to the three (`[]`, a list, `null`) this
  version exists to keep apart.
- Code that only reads what the client or the parsers return is not affected.

### Added

- **`WalletReputation.caveatsNotComputed: CaveatCode[] | null`** — the caveat
  codes `GET /wallets/{wallet}/chains` did NOT evaluate (seven on 2026-09-15).
  `null` means nothing readable was declared (a server older than 2026-09-14, a
  stored payload, or a value that is not a list of non-empty strings) and is
  deliberately **not** `[]`, which is a declaration.
- **`requireFullCaveats(rep)`** — returns `rep` only when it declared `[]`;
  throws `CaveatsNotComputedError` for a declared list AND for `null`; throws a
  `TypeError` for anything that is not the `WalletReputation` of `wallet()`
  (a metered result, a `null` response, a raw payload).
- **`CaveatsNotComputedError`** (`wallet`, `notComputed`, `recovery`). Extends
  `Error`, **not** `DescribeError`: a consumer's fail-open `catch` on
  `DescribeError` must not be able to swallow a refusal as an outage.
- **`Rating.authorClass: AuthorClass | null`** — `facilitator-authored` or
  `rater-authored`, per row. An unknown class arrives verbatim (never thrown,
  never nulled); `null` means none was served.
- **`AUTHOR_CLASSES`, `isKnownAuthorClass()`, `AuthorClass`, `KnownAuthorClass`.**
- **`CAVEAT_CODES` gains `facilitator-authored`** (nine codes).

### Known gap

- describe.net serves ten caveat codes; **`thin-chain`** (upstream since
  2026-09-04, on the free route since 2026-09-05) is still missing here and in
  the Python twin. Left for one follow-up that adds it to both, so the set both
  SDKs publish never differs. `isKnownCaveatCode('thin-chain')` is `false`; the
  caveat itself still arrives whole.

### Changed

- `schema/openapi.snapshot.json` refreshed from the live API (2.0.0, 22 paths:
  `GET /categories` and `GET /wallets/{wallet}/exists` are new and not wrapped).
- `npm run schema:check` now also watches `Rating`, and `types.schema.test.ts`
  covers it. Neither did before, which is how `author_class` becoming a required
  field upstream went unreported by the refresh.

### Unchanged, on purpose

- No method changed its return type (the types it returns gained two required
  fields — see *Breaking*), nothing throws where it did not, and
  `DescribeErrorKind` is untouched. The client never calls the gate; `failOpen`
  and `onFailure` behave exactly as in 0.3.0.

## 0.3.0 — 2026-09-10

`freshness`: WHEN a subject was last described, with its scope
(`WalletBreakdown.freshness`, `IndexHealth.freshness`), plus
`IndexHealth.credibilityM`. (#1, `764cab1`)

## 0.2.0 — 2026-08-31

The SDK review round: the `pending` settlement sentinel moved out of `receipt`
into `settlementPending`, `DescribeHTTPError.serverReason`, and parsers that fail
loud when fed the wrong route's payload or their own output. (`923a9d6`)

## 0.1.0 — 2026-08-30

First version: the free routes with `failOpen`, the metered routes paid through
`uvd-describe-sdk/x402` (and, the same day, never failing open), the partner rail,
jitter, `resolveDistinctRaters`, hash-shape validation and `recovery`.
(`99a87b2` … `8deb0c9`)
