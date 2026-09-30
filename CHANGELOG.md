# Changelog

Newest first. A version listed here is a version on `main`, **not** a version on
npm: publishing is a `vX.Y.Z` tag, and the tag is pushed by whoever releases,
never by the change that bumps the number.

This file starts at 0.4.0. The versions before it are summarised from their
commits, so they are shorter than they deserve — `git log` has the measurements.

## 0.5.0 — 2026-09-30 (not published yet)

### Added — `uvd-describe-sdk/widget`

One component for "a describe.net score, with its credit", for every surface of
the stack (WDG-01). Execution Market and MeshRelay showed the credit as a native
`title=` tooltip; KarmaKadabra had built the one styled card. The subpath takes
the card from KarmaKadabra, the link rule and the untranslated credit from
Execution Market, and the custom face from MeshRelay.

- **`<describe-score>`**, a custom element with a shadow root, registered only by
  `defineDescribeScore(tagName = 'describe-score')`. It returns `false` and does
  nothing without `customElements` (Node, SSR) or when the tag is taken.
  Importing the subpath registers nothing and touches no `document`.
- Attributes, each reflected as a property: `score`, `wallet`, `query`,
  `reviews`, `identities`, `chains`, `policy`, `refreshed-at`, `retrieved-at`,
  `lang` (`es` / `en` / `pt`), `theme` (`auto` / `light` / `dark`), `placement`
  (`bottom-start` / `bottom-end`).
- **`buildDescribeScoreCard(data, lang)`**, the pure model the element paints,
  for tests and for painting the card by hand. Types `DescribeScoreData`,
  `DescribeScoreCard`, `DescribeScoreCardRow`, `DescribeScoreLang`,
  `DescribeScoreElement`, and `DESCRIBE_ATTRIBUTION`.
- Theme through `--describe-score-*` custom properties, defaulting to
  describe.net's own tokens in both themes; `::part(link)`, `::part(face)`,
  `::part(card)`.
- `examples/widget.html`, a local demo with no network.

### Rules it keeps

- An absent, empty or non-decimal score paints "no data", never `0`
  (`Number('')` is `0`, so the element does not use it).
- No network: no `fetch`, no remote image or font. It paints only what the host
  holds, which is why it does not contradict describe.net publishing no widget
  (`describenet/badge.py:13-24`).
- No `innerHTML`: every host string lands through `textContent` or an attribute.
- Zero runtime dependencies. `widget/index` joins the CI check with the empty
  set.
- A date is formatted only when it is ISO 8601 with a time; anything else is
  shown raw. `new Date()` alone turns `"Version 2"` into Feb 1, 2001 and a bare
  `2026-09-30` into the previous day west of UTC.
- A `wallet` or `query` that cannot be URL-encoded (a lone surrogate) gets no
  link. `encodeURIComponent` throws there, and uncaught it left the face empty.
- `Escape` always closes an open card, and is consumed only when the card is
  open by keyboard focus on its trigger. Opened by hover alone, the key still
  reaches the control that has focus.

### Measured while building it (details in the README)

- React 18.3.1 renders `className` on a custom element as a literal `classname`
  attribute. React 19.2.0 translates it. The README's JSX declaration omits
  `className` so the mistake does not compile.
- A `<slot>` fallback does not render when the only child is whitespace
  (Chromium: one assigned text node, fallback 0 px wide).
- Python's `http.server` on Windows serves `.mjs` as `text/plain`, and the
  browser refuses the module.
- The first viewport clamp measured the card during a `transform` transition
  and let it overflow by 7 px from the second opening on; the shift now lives
  in the untransitioned `translate` property.

### Dev only

- `happy-dom` (devDependency) for the DOM tests.
- `package-lock.json` said `0.1.0` in its own `version` field; it now matches.

### Also in this version: FG-DN-03, landed on `main` before this bump

Listed here as *Unreleased (FG-DN-03, no version bump)* until 0.5.0; it ships
in 0.5.0.

#### Changed

- **`schema/` is describe.net's committed spec, vendored.** `schema/openapi.json`
  and `schema/sdk.overlay.yaml` (Overlay 1.0.0) are byte-for-byte copies from
  describe-net, pinned by sha256 in `schema/SOURCE`. They replace the
  hand-refreshed `schema/openapi.snapshot.json`. `npm run schema:refresh` now
  re-vendors from a describe-net checkout instead of writing the live spec.
- **`schema/sdk-map.json`**: every operation the overlay does not hide is either
  called by a public `DescribeClient` method (`mapeadas`) or listed in `fuera`
  with its reason. `src/sdk-map.test.ts` runs each method against a recording
  `fetch` and fails on an unclassified operation or a route outside the spec.
- **`schema:check` watches what the map says.** The schemas it compares are
  derived from the responses of the mapped operations (21, transitively; the
  hand-written list had 8), and the operations the overlay hides (web app,
  `/mcp`, `/a2a`) no longer count.

#### Unchanged, on purpose

- The client, its types and its parsers. `/names/resolve` and `/names/reverse`
  are in `fuera`, not implemented.

## 0.4.1 — 2026-09-15 (not published yet)

### Added

- **`CAVEAT_CODES` gains `thin-chain`** (ten codes, the same set describe.net
  serves). Served since 2026-09-04 on the wallet scope, and evaluated on the free
  route as well: `GET /wallets/{wallet}/chains` evaluates `burn-address` and
  `thin-chain`, and declares the other seven wallet-scope codes in
  `caveatsNotComputed`. `isKnownCaveatCode('thin-chain')` is now `true`. The
  Python twin adds the same literal in its own release.

### Unchanged, on purpose

- Types, parsers, the client and `requireFullCaveats()` behave exactly as in
  0.4.0. A `thin-chain` caveat already arrived whole; this release only makes it
  a known code (autocomplete, `switch`, `isKnownCaveatCode`).

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
