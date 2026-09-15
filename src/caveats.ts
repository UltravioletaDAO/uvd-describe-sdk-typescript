/**
 * The caveat codes, exported as a contract.
 *
 * ## The rule, and it is theirs, not ours
 *
 * describe.net declares it in `describenet/caveats.py:88-93`:
 *
 * > **EL TEXTO puede cambiar sin aviso** —re-redactarse, re-medirse, hasta
 * > traducirse—; **EL CODE jamás.**
 *
 * So a consumer branches on `code` and renders `text`, never the reverse. This
 * is not hygiene, it is a repair: until 2026-08-28 a caveat was a bare Spanish
 * string, ecosystem consumers matched on the prose, and when the thin-evidence
 * cut moved on 2026-08-25 every one of those matches broke silently — the
 * string comparison kept returning false and nobody was told.
 *
 * Exporting the set is one of the four "día 0" requirements the platform team
 * put on any SDK of the house: *los caveat `code`s como contrato exportado*. Typing them here means a consumer never re-types them,
 * and a typo is a compile error rather than a branch that is never taken.
 *
 * ## Why the type is not a closed union
 *
 * `CaveatCode | (string & {})` gives autocomplete on the codes that exist today
 * AND still accepts one more the server adds tomorrow. A closed union would turn
 * every new server-side code into a type error in code that is already deployed
 * and working — the passthrough rule (tipar lo conocido, CONSERVAR lo que no)
 * applied to the type system. The measured precedent is `Facet.direction`:
 * FastAPI silently dropped a field nobody had declared, and the response looked
 * correct with the data missing.
 *
 * The codes carry no version and never bump `POLICY_VERSION`: a caveat is
 * advisory by construction and identifies a CUT, it never moves a score.
 */

import type { WalletReputation } from './types';

/**
 * Nine of the ten cuts describe.net serves on 2026-09-15, copied from the frozen
 * set in `describenet/caveats.py:177-192` (describe-net `origin/main` at
 * `01f6c4a`), which its own `tests/test_caveat_codes.py` pins literally, so
 * adding or renaming one over there goes red on purpose.
 *
 * What the FREE route evaluates, per the server itself (`caveats.py:513`,
 * `_publicos_evaluados`): `burn-address` always, and `thin-chain` when it has the
 * per-chain rows — which `GET /wallets/{wallet}/chains` always has. Every other
 * wallet-scope code is DECLARED as not evaluated, by name, in
 * `WalletReputation.caveatsNotComputed`. `facilitator-authored` is agent scope
 * and is in neither: a wallet profile lists no rows. An empty `caveats: []` on a
 * free response therefore still means "no public-data caveat", NOT "clean" — and
 * `requireFullCaveats()` is the gate that knows it. See `CAVEAT_SCOPE_FREE`.
 *
 * 🔴 **`thin-chain` is NOT mirrored, and not by oversight.** Upstream since
 * 2026-09-04 (`cf8f806`) and on the free route since 2026-09-05, it is missing
 * from BOTH twins: this version was scoped to `facilitator-authored`, and a code
 * added to one twin only breaks parity in a set both publish. The Python twin
 * (`uvd_describe_sdk/caveats.py`) carries the same nine and says the same thing;
 * the follow-up adds it to both together. Meanwhile
 * `isKnownCaveatCode('thin-chain')` answers `false` — the tolerant answer this
 * module was built to give: the caveat still arrives whole and is shown.
 *
 * ⚠️ CORRECTED 2026-09-15, and the old text is left because somebody will look
 * for it. It read: *"The eight cuts served on 2026-08-30, copied from the frozen
 * set in `describenet/caveats.py:172-183` … Only `no-score` and `burn-address`
 * are computable from public data, so the free routes serve a documented SUBSET
 * … The other six need the grain and ride the metered routes."* Two codes had
 * landed upstream since and this mirror carried neither; `facilitator-authored`
 * (`6e25d71`, 2026-09-14) is mirrored now, `thin-chain` is not (above). And
 * `no-score` is not evaluated on the free route at all: the server declares it
 * in the list.
 */
export const CAVEAT_CODES = [
  /** No score to qualify: there is no eligible rating at all. */
  'no-score',
  /** The concentration signal itself is degraded and should not be leaned on. */
  'concentration-degraded',
  /** Exactly one distinct counterparty is behind this score. */
  'single-rater',
  /** Below the evidence bar (`reading_policy.min_raters`, 3 as of 2026-08-30). */
  'few-raters',
  /** One client wrote more than `reading_policy.top_share` of the ratings. */
  'top-client-share',
  /** Ratings-per-rater above `reading_policy.campaign_per_rater` — looks like a campaign. */
  'campaign-per-rater',
  /** The subject rated itself. */
  'self-rated',
  /**
   * The subject is a burn address: nobody controls it, anyone may rate it, and
   * nobody can answer for its reputation. The ratings are real on-chain facts
   * — which is why they are still served — but the subject is not an identity.
   */
  'burn-address',
  /**
   * Some rows of `ratings[]` carry `authorClass: 'facilitator-authored'`: a
   * relayer signed them, so their `client` is not the counterparty and every
   * per-rater count merges them into one voice. AGENT scope only — the one
   * metered answer that lists rows — and it carries no numbers, on purpose: the
   * aggregate by author was cancelled upstream on 2026-08-29. Since 2026-09-14.
   */
  'facilitator-authored',
] as const;

/** The known codes as a union — for `switch`, not for validation. */
export type KnownCaveatCode = (typeof CAVEAT_CODES)[number];

/**
 * What a caveat's `code` may be: a known one, or any string the server starts
 * sending. The `(string & {})` half is what keeps autocomplete alive
 * while leaving the union open.
 */
export type CaveatCode = KnownCaveatCode | (string & {});

/** As served since 2026-08-28: `{code, text}`, never a bare string. */
export interface Caveat {
  /** The contract. Stable, kebab-case. Branch on this. */
  code: CaveatCode;
  /** Prose. May be re-worded, re-measured or translated without notice. Render this. */
  text: string;
}

/**
 * What an empty `caveats: []` claims on a FREE route.
 *
 * describe.net's own definition (given 2026-08-29, recorded in
 * `meshrelay/describenet.js:265-277`): on the free routes `[]` means "no
 * PUBLIC-DATA caveat", not "no caveats" — the evidence-quality cuts are only
 * computable behind the metered routes. A surface that renders a bare `[]` as
 * "clean" publishes a claim the index never made. Carry the scope with the
 * list, the same discipline as the `n/m` coverage next to any aggregate.
 */
export const CAVEAT_SCOPE_FREE = 'public-data-subset';

/** Everything a metered route can fire — the free subset plus the six from the grain. */
export const CAVEAT_SCOPE_METERED = 'full';

/**
 * Is this code known to the version of the SDK you have installed?
 *
 * Deliberately NOT a validator: a `false` means "we have not heard of it",
 * never "it is invalid". An unknown code is served through untouched.
 */
export function isKnownCaveatCode(code: string): code is KnownCaveatCode {
  return (CAVEAT_CODES as readonly string[]).includes(code);
}

/**
 * Does this result carry `code`?
 *
 * Exists so consumers stop writing `caveats.some(c => c.text.includes('...'))`
 * — the exact line that broke silently on 2026-08-25.
 */
export function hasCaveat(
  subject: { caveats?: readonly Caveat[] } | null | undefined,
  code: CaveatCode,
): boolean {
  return (subject?.caveats ?? []).some((c) => c.code === code);
}

// ---------------------------------------------------------------------------
// The gate — added 2026-09-15 (0.4.0)
// ---------------------------------------------------------------------------

/**
 * `requireFullCaveats()` refused: this answer does not vouch for every cut.
 *
 * ## 🔴 NOT a `DescribeError`, and that is the decision
 *
 * `DescribeError` is the failure taxonomy — transport and protocol, "we could
 * not read" — and consumers wrap it in their own fail-open:
 * `catch (e) { if (e instanceof DescribeError) return null; }`. A refusal caught
 * there degrades into "describe.net is down", and a gate built to tolerate
 * outages lets the subject THROUGH: the same silent green the 2026-08-31 row
 * exists to stop. This is not a failure to read; it is a successful read that
 * does not support the decision being asked of it. So it extends `Error`, carries
 * no `kind`, `transient` or `serviceFault`, and `failOpenCovers()` and
 * `failedAfterPaying()` both answer `false` for it.
 *
 * Decided by the Python twin the same night (`CaveatsNotComputedError`,
 * `uvd_describe_sdk/caveats.py`) and adopted here for parity. The first draft of
 * this package made it a `DescribeError` with a new `kind`; the argument above is
 * why that was the wrong door — and it would also have broken, at compile time,
 * every exhaustive `switch` over `DescribeErrorKind`.
 *
 * ## `notComputed` — branch on it, never on the message
 *
 * ```
 *   ['few-raters', …]  the answer DECLARED these unevaluated: unverified, not passed
 *   null               the answer declared NOTHING — a server older than
 *                      2026-09-14, or a payload stored before then. Not `[]`.
 * ```
 *
 * A declared `[]` never reaches this class: it passes the gate.
 */
export class CaveatsNotComputedError extends Error {
  /**
   * What to do INSTEAD, as a frozen literal that interpolates nothing — the
   * redaction rule of `recovery.ts` (invariant 11), without being an entry of
   * that table, because this is not a `kind`. Same text on the class and on
   * every instance.
   *
   * ⚠️ Not byte-identical to the Python twin's, and that is declared rather than
   * hidden: theirs names `wallet_breakdown()`, `payer=`, `partner=` and
   * `fallback_reader`, which are Python spellings. This one names what both SDKs
   * share — the route, and the two ways through it.
   */
  static readonly recovery: string =
    'What this free answer did not evaluate is what the metered decomposition sells: ' +
    '`GET /reputation/wallet/{wallet}` evaluates the wallet-scope cuts this error lists — paid ' +
    "per call with x402, or free for a wallet on describe.net's partner allowlist. If the error " +
    'lists nothing, the answer declared nothing (a server older than 2026-09-14, or a payload ' +
    'stored before then), and that is not a pass either: the decomposition is still the route ' +
    'that evaluates them.';

  /** Same literal as {@link CaveatsNotComputedError.recovery}, on the instance. */
  readonly recovery: string = CaveatsNotComputedError.recovery;
  /** The wallet whose answer was refused, as served. */
  readonly wallet: string;
  /** A COPY of what the answer declared, or `null` if it declared nothing. */
  readonly notComputed: string[] | null;

  constructor(message: string, opts: { wallet: string; notComputed: readonly string[] | null }) {
    super(message);
    this.name = 'CaveatsNotComputedError';
    this.wallet = opts.wallet;
    this.notComputed = opts.notComputed === null ? null : [...opts.notComputed];
  }
}

/**
 * Is this the object `wallet()` / `parseWalletReputation()` returns?
 *
 * By KEYS, the way `parse.ts` tells the doors apart (rule 5): `globalScore` is
 * only ever in a parsed free answer, `finalScore` only in a parsed breakdown,
 * `agentId` only in a parsed agent. `caveatsNotComputed` is deliberately NOT
 * required — a result parsed by 0.3.0 and stored has no such key, and that is an
 * undeclared answer (refused as such), not a wrong argument.
 */
function isWalletReputation(v: unknown): v is WalletReputation {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return (
    typeof (v as { wallet?: unknown }).wallet === 'string' &&
    'globalScore' in v &&
    !('finalScore' in v) &&
    !('agentId' in v)
  );
}

/**
 * Return `result` only if its answer DECLARED it left no caveat code out.
 *
 * ```ts
 * const rep = await describe.wallet(address);
 * if (rep === null) { … }        // no answer at all: decide THAT first
 * requireFullCaveats(rep);       // throws CaveatsNotComputedError
 * ```
 *
 * ## The bug it closes, found by karma-hello
 *
 * A quality gate built on the FREE route passes everybody (karma-hello, channel,
 * 2026-08-31; `describe-net/docs/BACKLOG.md:221`). The evidence-quality cuts —
 * `single-rater`, `few-raters`, `campaign-per-rater`, … — are computed only by
 * the paid decomposition, so on `GET /wallets/{wallet}/chains`
 * `hasCaveat(rep, 'single-rater')` is `false` for every wallet, the one with a
 * single rater included. Honest code, and a gate that cannot fail anyone.
 *
 * Since 2026-09-14 the free answer DECLARES the names it did not evaluate
 * (`WalletReputation.caveatsNotComputed`), and the server names this very helper
 * as the reason the declaration is a list and not a count
 * (`describenet/caveats.py:493-494`: *"el SDK puede ofrecer
 * `require_full_caveats()` sin tabla propia"*). No table of our own here either:
 * the verdict is read off the answer, never off a list typed in this package.
 *
 * ## Three states, and only one passes
 *
 * ```
 *   caveatsNotComputed = []          → returns `result`, the same object
 *   caveatsNotComputed = ['…', …]    → throws; `error.notComputed` is the list
 *   caveatsNotComputed = null        → throws; `error.notComputed` is null
 * ```
 *
 * 🔴 **Against the live index this throws for every `wallet()` today** —
 * measured 2026-09-15: the same seven codes for a wallet with 471 distinct raters
 * and for one with no identity at all. That is the gate working: the free route
 * does not evaluate the evidence-quality cuts, and a decision that needs them has
 * to buy `walletBreakdown()` (or read it over the partner rail). What changes is
 * that the gate can no longer find that out by passing.
 *
 * ## 🔴 Why `null` THROWS — the decision, and its sources
 *
 * - The position of 2026-08-31, written in `describe-net/docs/BACKLOG.md:221`:
 *   *"la línea gratis/pago es regla de costo y **el scope es la señal**; el SDK
 *   puede ganar `require_full_caveats()`"*. That row is about a gate that goes
 *   green without knowing what was not computed. A `null` that passes is that
 *   gate, back — silently, on every old deployment and every stored payload.
 * - The service refuses the same collapse on its own side: its MCP tool carries
 *   `None` *"cuando la API no lo trae: una API vieja no declaró nada, y `[]`
 *   afirmaría que lo calculó todo"* (`describenet/mcp_server.py:896-901`).
 * - Before 2026-09-14 the free route did not evaluate those cuts either; it only
 *   did not SAY so (`caveatScope: 'public-data-subset'` was the whole signal). An
 *   old answer's silence is the old gap, not a clean bill.
 *
 * ## It takes a `WalletReputation`, and nothing else
 *
 * The one result that declares what it did not compute. Anything else is a
 * `TypeError` naming the mistake — never a pass, and never the refusal above:
 *
 * - `null` is "describe.net did not answer", the third absence (invariant 3).
 *   Handle it before asking about caveats.
 * - A `WalletBreakdown` or an `AgentReputation` comes from a metered route, which
 *   evaluates its own caveat scope and declares no omissions: there is nothing
 *   here for this gate to read.
 * - A raw wire payload (snake_case) was never parsed: `parseWalletReputation()`.
 *
 * Never called by the client and never swallowed by `failOpen`. And passing
 * means the caveats are COMPLETE, not that they are empty — `hasCaveat()` is
 * still the question after the gate.
 */
export function requireFullCaveats(result: WalletReputation): WalletReputation {
  if (!isWalletReputation(result)) {
    throw new TypeError(
      'requireFullCaveats() takes the WalletReputation that wallet() returns. A null means ' +
        'describe.net did NOT answer — handle that before asking about caveats. A WalletBreakdown ' +
        'or an AgentReputation comes from a metered route, which evaluates its own caveat scope ' +
        'and declares no omissions. A raw payload goes through parseWalletReputation() first.',
    );
  }
  // `Array.isArray`, not a null check: anything that is not a list is not a
  // declaration (the parser already maps it to `null`), and a stored 0.3.0
  // result has no key at all — both are undeclared, both refused as such.
  const declared: unknown = result.caveatsNotComputed;
  if (!Array.isArray(declared)) {
    throw new CaveatsNotComputedError(
      `the answer for ${result.wallet} did not declare which caveat codes it left out (no ` +
        '`caveats_not_computed`): a server older than 2026-09-14, or a payload stored before ' +
        'then. Undeclared is not `[]`, so this gate does not pass.',
      { wallet: result.wallet, notComputed: null },
    );
  }
  if (declared.length === 0) return result;
  const codes = declared.map(String);
  throw new CaveatsNotComputedError(
    `the answer for ${result.wallet} declares ${codes.length} caveat code(s) it did not ` +
      `compute: ${codes.join(', ')}. Unverified, not passed.`,
    { wallet: result.wallet, notComputed: codes },
  );
}

// ---------------------------------------------------------------------------
// Author classes — who SIGNED a rating row. Added 2026-09-15 (0.4.0)
// ---------------------------------------------------------------------------

/**
 * The two classes served in `ratings[].author_class` since describe.net
 * 2026-09-14 — the schema's own enum (`describenet/api.py:962`,
 * `Literal["facilitator-authored", "rater-authored"]`), and
 * `types.schema.test.ts` pins this tuple against the snapshot's `enum`. The
 * Python twin calls the same set `KNOWN_AUTHOR_CLASSES`, the way it calls
 * `CAVEAT_CODES` `KNOWN_CAVEAT_CODES`.
 *
 * They live next to the caveat codes because one of them IS one: the agent-scope
 * caveat `facilitator-authored` fires exactly when some row carries that class
 * (`describenet/caveats.py:614`, which reads the field instead of recomputing it,
 * so the two cannot disagree inside one answer).
 */
export const AUTHOR_CLASSES = ['facilitator-authored', 'rater-authored'] as const;

/** The known classes as a union — for `switch`, not for validation. */
export type KnownAuthorClass = (typeof AUTHOR_CLASSES)[number];

/**
 * What `Rating.authorClass` may be: a known class, or any string the server
 * starts sending.
 *
 * Open, not closed, and recording that decision is why this type exists. The
 * server's enum is closed TODAY; a third class there is a new contract on their
 * side and must not become a type error — or worse, a thrown parse — on ours. A
 * parser that rejected it would destroy a PAID read over one advisory field; one
 * that nulled it would read as "no class served". So it arrives verbatim and
 * `isKnownAuthorClass()` says whether this SDK has heard of it: the `CaveatCode`
 * rule, applied one field over.
 */
export type AuthorClass = KnownAuthorClass | (string & {});

/**
 * Is this one of the author classes this SDK knows?
 *
 * NOT a validator, same as `isKnownCaveatCode`: `false` means "newer than this
 * SDK" — or, for `null`, a row served before 2026-09-14 that carries no class at
 * all. Neither is invalid. Before filtering rows on it, decide what an unknown
 * class means for YOUR count; this SDK will not decide that for you.
 */
export function isKnownAuthorClass(value: string | null | undefined): value is KnownAuthorClass {
  return (AUTHOR_CLASSES as readonly unknown[]).includes(value);
}
