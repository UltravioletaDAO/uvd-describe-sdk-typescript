/**
 * Shape validation for the hash fields — *"el 200 sin tx"*, from KarmaKadabra.
 *
 * Pure: no network, no clock, no state. Strings in, booleans out.
 *
 * ## Where this comes from
 *
 * Contributed by **KarmaKadabra**, `#agents` on MeshRelay, **2026-08-30**. Their
 * words:
 *
 * > *"Un 200 que no hizo la cosa es peor que un 503, porque el cliente lo toma
 * > por bueno: si nosotros no chequeáramos el tx, habríamos contado 14 ratings
 * > que no existen. Nosotros lo cazamos con un sello que exige forma de hash —
 * > pero el contrato debería decirlo, no cada cliente descubrirlo."*
 *
 * The second half is why this lives in the SDK: the check is a property of the
 * CONTRACT, and three consumers each discovering it separately is three chances
 * to get it wrong. Verified before writing a line: neither this SDK nor its
 * Python twin validated the shape of any hash field on 2026-08-30.
 *
 * ## 🔴 Why `^0x[0-9a-f]{64}$` alone would have been a disaster
 *
 * The obvious version of this file — one EVM regex — would have flagged **every
 * Solana rating in the index** as malformed. Two independent confirmations, both
 * read 2026-08-30:
 *
 *   * from the writer: `describe-net/describenet/solana_indexer.py:436` puts
 *     `firma["signature"]` — a base58 signature — into the `tx_hash` column of
 *     the INSERT at `indexer.py:153-157`, the same column the EVM indexer fills
 *     with `0x…`. Solana writes to the same tables on purpose, so this is by
 *     construction and not an accident of one sample;
 *   * from the wire (measured by the Python twin against `GET /feed`): avalanche
 *     and celo serve 66-char `0x` + 64 hex, solana serves 87- and 88-char base58
 *     with no prefix.
 *
 * An alarm that screams about good data is worse than no alarm: people learn to
 * ignore it, and then it is silent on the day it is right. So this validates the
 * **union** of the legitimate shapes, never the intersection.
 *
 * The shapes the index emits today, each with its source:
 *
 * 1. **EVM hash** — `0x` + 64 hex. `chain/decode.py:253` does `"0x" + …hex()`
 *    over a `bytes32` (`_NEW_FEEDBACK_TYPES:85`). This is `tx_hash`,
 *    `revoked_tx` and `feedback_hash` on the ten EVM chains.
 * 2. **Solana signature** — base58 (Bitcoin alphabet: no `0`, `O`, `I`, `l`),
 *    86–88 characters. 64 bytes in base58 is 87–88; 86 is reachable with leading
 *    zero bytes. On Solana `feedback_hash` is **NULL on purpose**, so a hole
 *    there is correct and not a fault.
 * 3. **Bare digest** — 64 hex with **no** `0x`. That is `Snapshot.inputs_digest`,
 *    which comes out of `hashlib.sha256(...).hexdigest()` in `aggregate.py:1920`.
 *    Demanding the `0x` prefix would have marked every citable snapshot as
 *    malformed.
 * 4. **The `pending` sentinel** — only on the `X-Payment-Receipt` header, whose
 *    own OpenAPI declares it: the settlement hash *"or `pending` if settlement
 *    has not reported one"*. It is a LEGITIMATE value, which is why
 *    {@link looksLikeSettlementReceipt} exists separately: treating it as
 *    garbage would fire an alarm on the happy path of every fresh payment.
 *
 * ## 🔴 What is deliberately NOT validated: `build_sha`
 *
 * `IndexHealth.buildSha` looks like a hash and is not one, and the measurement
 * that settles it is `describe-net/scripts/build_lambda_zip.py:64` (read
 * 2026-08-30): `estampa = sha + ("-dirty" if sucio else "")`. A legitimate
 * deploy can therefore publish `"<40 hex>-dirty"`, and a validator would scream
 * about a perfectly good build — forever, on every `/health` call. The general
 * rule that falls out of it, and it is the one to apply to the next field:
 * **validate the identifiers a caller will carry somewhere to verify (an
 * explorer, a digest comparison); leave alone the strings that only describe a
 * build.** Nobody looks up a `build_sha`; the service already refuses to publish
 * its `unknown` default as if it were a SHA (`api.py:2439-2456`).
 *
 * ## The question this module answers — and the one it does not
 *
 * It answers **"does this have the shape of an on-chain identifier?"**. It does
 * NOT answer "does this transaction exist?" or "does it say what the index says
 * it says": that is verified in an explorer, which is the entire point of the
 * field (the service's own schema: *"go verify it in an explorer, which is the
 * point"*). A shape check cannot prove existence and does not pretend to.
 *
 * What it does catch is what bit KarmaKadabra: the empty string, `"null"`,
 * `"undefined"`, `"0x"`, `"0x0"`, a truncated hash, an error message parked in
 * the field. Every one of those sails through an `if (rating.txHash)` today with
 * nothing making a sound.
 *
 * 🔴 **And it deliberately does not validate per chain.** A `feedback_hash`
 * shaped like a Solana signature is accepted even though Solana emits none
 * today. Being strict per field would trade a cheap false negative (letting an
 * odd-but-valid shape through) for an expensive false positive (screaming about
 * good data the day the service extends a field), and that contradicts the
 * passthrough rule this package is built on: type what is known, PRESERVE what
 * is not.
 */

/**
 * `0x` + 64 hex. Case-insensitive: the index serves lowercase, but a hash
 * written in mixed case is the same hash and flagging it would be a false
 * positive.
 */
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;

/** 64 hex with NO prefix — a `sha256(...).hexdigest()`, i.e. `inputs_digest`. */
const BARE_DIGEST = /^[0-9a-fA-F]{64}$/;

/**
 * Base58, Bitcoin alphabet (no `0`, `O`, `I`, `l`), 86–88 characters: a Solana
 * transaction signature. Both high lengths measured live on 2026-08-30.
 */
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

/**
 * The one non-hash value the `X-Payment-Receipt` header declares legitimate.
 *
 * The live OpenAPI says it, not us: the settlement transaction hash *"or
 * `pending` if settlement has not reported one"*.
 */
export const SETTLEMENT_PENDING = 'pending';

/**
 * Does `value` have the shape of an on-chain identifier this index emits?
 *
 * The UNION of the three measured shapes (EVM hash, Solana signature, bare
 * digest) — never the intersection. See the module header for why an EVM-only
 * regex would have marked every Solana rating as malformed.
 *
 * It does not prove the transaction exists. That is the explorer's job.
 */
export function looksLikeOnchainId(value: string): boolean {
  return EVM_HASH.test(value) || BASE58_SIGNATURE.test(value) || BARE_DIGEST.test(value);
}

/**
 * The same, plus the `pending` sentinel. For `X-Payment-Receipt` and nothing
 * else.
 *
 * `pending` is not garbage: it is the seller saying *"I charged you and
 * settlement has not reported the hash yet"*, and it is in their OpenAPI.
 * Marking it malformed would turn the happy path of every freshly settled
 * payment into an alarm.
 */
export function looksLikeSettlementReceipt(value: string): boolean {
  return value === SETTLEMENT_PENDING || looksLikeOnchainId(value);
}

/**
 * Read one hash field off a wire object: keep it if it has the shape of a hash,
 * otherwise `null` **and a mark**.
 *
 * 🔴 **Absent and malformed are not the same thing** (R1, applied one level
 * below where it usually lives) and this function is where the distinction is
 * made, so read the two cases carefully:
 *
 * ```
 *   did not come  → null, and `key` does NOT enter `malformed`. This is normal
 *                   and documented: the schema itself says tx_hash is "null
 *                   until the log scan reaches this entry, not null forever",
 *                   and Solana writes feedback_hash NULL on purpose.
 *   came garbage  → null AND `key` in `malformed`. THIS is the one that shouts.
 * ```
 *
 * A caller therefore branches on the list, never on `field === null`.
 *
 * Why the value is dropped rather than passed through: the field exists so
 * somebody can build an explorer link out of it, and a link built from garbage
 * is the "200 that did not do the thing" arriving one layer later. Why it does
 * not throw: the rest of the response is very likely useful, and killing a whole
 * reputation breakdown over an accessory field would be worse than the bug being
 * hunted. The original value is not lost — it stays in the result's `raw`, which
 * is where it gets investigated.
 *
 * A non-string that is not `null`/`undefined` (a number, an object) counts as
 * garbage, not as absence: the wire said something and it was not a hash.
 */
export function hashField(
  row: Record<string, unknown>,
  key: string,
  malformed: string[],
  ok: (value: string) => boolean = looksLikeOnchainId,
): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && ok(value)) return value;
  malformed.push(key);
  return null;
}

/** Anything that carries the marks of its own malformed hash fields. */
interface MalformedCarrier {
  malformedHashes?: readonly string[];
}

/**
 * Every malformed hash field of a result, located.
 *
 * Walks the places a hash can hide in a parsed result and returns qualified
 * paths, in the order they appear:
 *
 * ```ts
 * ['ratings[3].tx_hash', 'snapshot.inputs_digest', 'payment.receipt']
 * ```
 *
 * Wire names (`tx_hash`), not ours (`txHash`), on purpose: this string is what
 * ends up in a log line or a ticket to whoever runs the index, and it has to
 * name the field the way the API does.
 *
 * An empty array is the normal case and means "no field arrived malformed" — it
 * says nothing about which fields arrived at all. An absent hash is legitimate
 * and is not reported here.
 */
export function malformedHashReport(
  result:
    | {
        ratings?: readonly MalformedCarrier[];
        snapshot?: MalformedCarrier | null;
        payment?: MalformedCarrier | null;
      }
    | null
    | undefined,
): string[] {
  if (!result) return [];
  const fields: string[] = [];
  (result.ratings ?? []).forEach((rating, i) => {
    for (const name of rating.malformedHashes ?? []) fields.push(`ratings[${i}].${name}`);
  });
  for (const attr of ['snapshot', 'payment'] as const) {
    const part = result[attr];
    if (part) for (const name of part.malformedHashes ?? []) fields.push(`${attr}.${name}`);
  }
  return fields;
}
