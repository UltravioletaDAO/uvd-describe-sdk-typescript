/**
 * How a score is written down. One rule, ecosystem-wide.
 *
 * **Two decimals, trailing zeros trimmed.** `86.65`, `84.7`, `87` — never `82.0`.
 *
 * Fixed on 2026-08-29 after the three consumers each rendered the SAME number
 * differently (`86.653045`, `86.7`, `86` — one field, three strings), and
 * decided by measurement rather than taste: over 47 real distinct scores,
 * rounding to 0 decimals merges 23 pairs of *different* agents into identical
 * strings, 1 decimal merges 4, and 2 decimals merges 1. Trimming matters as
 * much as the count — two surfaces both "agreeing on 1 decimal" still printed
 * `82.0` and `82` for the same agent.
 *
 * The canonical one-liner, byte-identical across the two languages
 * (`docs.describe.net`, §"Displaying a score"):
 *
 * ```js
 * String(parseFloat(x.toFixed(2)))   // JavaScript
 * ```
 * ```python
 * f"{round(x, 2):g}"                 # Python
 * ```
 *
 * **Live witness case**: the agent scored `83.0` renders as `83` on all three
 * surfaces — where `toFixed(2)` alone prints `83.00` and `toFixed(1)` prints
 * `83.0`. It is the one value that tells the three candidate rules apart, which
 * is why `format.test.ts` tests it first.
 *
 * This is a DISPLAY convention. The API keeps serving the full-precision number
 * (six decimals) and what you compute with is the number, never the string —
 * which is why the two functions below are separate and why `formatScore`
 * returns a `string`. A helper that rounded the number in place would push a
 * lossy value back into arithmetic, and averaging rounded members is how an
 * aggregate ends up disagreeing with the members it aggregates.
 */

/**
 * The canonical display string, or `null` when there is nothing to display.
 *
 * `null` in, `null` out — never `"0"`, never `"—"`. Choosing the placeholder
 * for absence is the surface's job and it is a different decision per surface;
 * inventing one here would put this package's taste into every consumer, and
 * `"0"` in particular would publish "worst possible reputation" for "nobody has
 * rated this yet" (invariante 7 of the index, and R1 of this SDK).
 *
 * A non-finite input (a `NaN` from a malformed payload) is also `null`: a
 * number we cannot name is not a number we may put describe.net's name on.
 */
export function formatScore(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return String(parseFloat(value.toFixed(2)));
}

/**
 * The same rounding, kept as a `number`.
 *
 * For the one case where a number is what you need: MeshRelay rounds at the
 * boundary where the value ENTERS the system rather than at each surface,
 * because "the bug this closes is one number rendering differently in two
 * places" (`describenet.js:204-208`). If you do that, use this — and be aware
 * you have made the value lossy on purpose. Everything else should carry the
 * full-precision number and call `formatScore` at the pixel.
 */
export function roundScore(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return parseFloat(value.toFixed(2));
}
