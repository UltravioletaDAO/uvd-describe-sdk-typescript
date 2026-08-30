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
 * put on any SDK of the house (`D9-c0der.md:234-241`): *los caveat `code`s como
 * contrato exportado*. Typing them here means a consumer never re-types them,
 * and a typo is a compile error rather than a branch that is never taken.
 *
 * ## Why the type is not a closed union
 *
 * `CaveatCode | (string & {})` gives autocomplete on the eight codes that exist
 * today AND still accepts a ninth one the server adds tomorrow. A closed union
 * would turn every new server-side code into a type error in code that is
 * already deployed and working — the passthrough rule (tipar lo conocido,
 * CONSERVAR lo que no) applied to the type system. The measured precedent is
 * `Facet.direction`: FastAPI silently dropped a field nobody had declared, and
 * the response looked correct with the data missing.
 *
 * The codes carry no version and never bump `POLICY_VERSION`: a caveat is
 * advisory by construction and identifies a CUT, it never moves a score.
 */

/**
 * The eight cuts served on 2026-08-30, copied from the frozen set in
 * `describenet/caveats.py:172-183` (which its own
 * `tests/test_caveat_codes.py` pins literally, so adding or renaming one over
 * there goes red on purpose).
 *
 * Only `no-score` and `burn-address` are computable from public data, so the
 * free routes serve a documented SUBSET — an empty `caveats: []` on a free
 * response means "no public-data caveat", NOT "clean". The other six need the
 * grain and ride the metered routes. See `CAVEAT_SCOPE_FREE`.
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
] as const;

/** The eight known codes as a union — for `switch`, not for validation. */
export type KnownCaveatCode = (typeof CAVEAT_CODES)[number];

/**
 * What a caveat's `code` may be: one of the eight, or any string the server
 * starts sending. The `(string & {})` half is what keeps autocomplete alive
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
