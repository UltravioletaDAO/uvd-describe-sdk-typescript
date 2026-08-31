/**
 * How many distinct counterparties are behind a wallet's reputation — and the
 * two ways of reconstructing that number that are both WRONG.
 *
 * Contributed by **MeshRelay**, `#agents` on MeshRelay, **2026-08-30**. The
 * seven lines of the helper are not the contribution; the two measurements are,
 * and they are the reason this file has a docstring longer than its code.
 */

/**
 * The distinct-rater count of a wallet, or `null` when there is none to give.
 *
 * ## 🔴 Read this before you use the number
 *
 * `distinct_raters` at the top level of `GET /wallets/{wallet}/chains` is
 * `COUNT(DISTINCT client)` across every chain AND every identity: one rater who
 * reviewed on two chains counts **once**. There is no way to rebuild that from
 * the per-chain rows, and MeshRelay measured both attempts on 2026-08-30:
 *
 *   * **Summing the chains DOUBLE-COUNTS** whoever rated on more than one of
 *     them. Measured case: the karma-hello wallet reads **9** distinct raters
 *     globally while its per-chain figures add up to **11**.
 *   * **Taking the maximum UNDERESTIMATES.** Measured case: 3 raters on base and
 *     4 *different* ones on avalanche is **7** real counterparties, and the
 *     maximum answers **4**.
 *
 * So the per-chain maximum is a **LOWER BOUND — never the answer**, and summing
 * is not a second-best either: it is wrong in the opposite direction. That pair
 * of sentences is the contribution; without them this helper reads like a
 * one-liner and gets used as the truth.
 *
 * **One live vector proves all three branches at once.** Verified against
 * `api.describe.net` on 2026-08-30 (free route), wallet
 * `0xcc28…4821`: global `distinct_raters` **129**, per chain base **113** and
 * ethereum **21**. The maximum answers 113 (**16 short**), the sum answers 134
 * (**5 over**), and only the global figure is right. It is the fixture this
 * file's test pins, because a vector where two wrong answers land on opposite
 * sides of the true one cannot be passed by accident.
 *
 * ## 🔴 The fallback is a COMPATIBILITY path, not a normal one
 *
 * ⚠️ Corrected while writing this, and the correction matters more than the
 * line it replaces: an earlier draft called the per-chain maximum a "fallback
 * for when the global figure is not there", which invites a reader to treat the
 * global field as optional. It is not. describe.net has served wallet-level
 * `distinct_raters` since `b753c9c` — *"el dato ya estaba y no lo leíamos"*,
 * committed **2026-08-28**, which MeshRelay's own note dates 08-29 (the day they
 * read it; both are written here because a reader will find the other one and
 * think one of us is wrong) — and their comment says the maximum is kept *"only
 * as a fallback for a cached response predating that deploy"*
 * (`meshrelay/meshrelayserv/describenet.js:228-230`,
 * read 2026-08-30). Confirmed live the same day: the free route serves
 * `distinct_raters` at the top level on every wallet.
 *
 * So in a client written after that date the fallback branch is unreachable
 * unless you cache responses and outlive one of their deploys — which MeshRelay
 * does, and is why the branch exists at all. It is kept for them and for anyone
 * replaying a stored payload, not because the field might be missing today.
 *
 * ## What this function therefore does
 *
 * Prefers the global count whenever the object carries one; falls back to the
 * per-chain maximum only when it does not. What comes back is exact in the first
 * case and a lower bound in the second, and there is no third answer it could
 * give. **It never sums, and neither should you.**
 *
 * ## 🔴 Why this is not called `maxDistinctRaters`
 *
 * Because MeshRelay, who wrote it under that name, asked for the rename when
 * they handed it over (2026-08-30): *"ese nombre invita a creer que el máximo es
 * la respuesta correcta, cuando es el último recurso. El mío está mal nombrado y
 * lo arrastro de cuando el nivel wallet no existía."*
 *
 * That is worth keeping written down, because the old name is what a reader will
 * search for and because it is the failure this whole file guards against
 * arriving through the API surface: a function named after its fallback
 * advertises the fallback, and the fallback is the wrong answer. Their name
 * survives here, in the provenance, which is where it belongs.
 *
 * ## Two `null`s that are not zero
 *
 *   * A wallet with no eligible rating anywhere serves `distinct_raters: null`
 *     with `chains: []` — verified live 2026-08-30 against `0xdEaD…BEEF`. The
 *     answer is `null`, **never `0`**: "nobody has rated this" and "zero people
 *     rated this after we counted" are the same sentence, but `0` is a number a
 *     caller will divide by, average, or render as a bar of length zero next to
 *     wallets whose bar means something. `Math.max(...[])` is `-Infinity`, which
 *     is the concrete bug this branch exists to not have.
 *   * A `null` INPUT (the fail-open value of `wallet()`, i.e. "we could not ask
 *     describe.net") also gives `null`. Accepting it is deliberate: it lets a
 *     caller write `resolveDistinctRaters(await describe.wallet(w))` without a
 *     null-check that would only exist to satisfy the compiler, and it keeps the
 *     three absences of this package from collapsing — an unreachable index and
 *     an unrated wallet both mean "no number", and neither means zero.
 *
 * Structurally typed rather than tied to `WalletReputation` so it also works on
 * a payload you parsed yourself or pulled out of your own cache.
 */
export function resolveDistinctRaters(
  wallet:
    | {
        distinctRaters: number | null;
        chains: readonly { distinctRaters: number }[];
      }
    | null
    | undefined,
): number | null {
  if (!wallet) return null;
  if (wallet.distinctRaters !== null && wallet.distinctRaters !== undefined) {
    return wallet.distinctRaters;
  }
  let best: number | null = null;
  for (const chain of wallet.chains ?? []) {
    const n = chain?.distinctRaters;
    if (typeof n === 'number' && Number.isFinite(n) && (best === null || n > best)) best = n;
  }
  return best;
}
