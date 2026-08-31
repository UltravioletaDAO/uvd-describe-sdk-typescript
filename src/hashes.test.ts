import { describe, expect, it } from 'vitest';

import {
  hashField,
  looksLikeOnchainId,
  looksLikeSettlementReceipt,
  malformedHashReport,
  SETTLEMENT_PENDING,
} from './hashes';

/**
 * Aporte ③ — KarmaKadabra's *"el 200 sin tx"*.
 *
 * The vectors are REAL. Every accepted string below was fetched from
 * `https://api.describe.net/feed` on 2026-08-30 and pasted in, because a
 * synthetic base58 string tests the developer's idea of base58, which is the
 * thing most likely to be wrong. The Solana signatures in particular are the
 * whole reason this module is a union of shapes and not one EVM regex.
 */

/** `GET /feed?limit=6` — base, 66 chars. */
const EVM_TX = '0x08be6ba7c849d15a87166b36c8de815b7665d448d732e578f091cb80ce93bc95';

/** `GET /feed?network=solana&limit=4` — 88 and 87 chars, base58, no `0x`. */
const SOLANA_TX_88 =
  '2va3P3Q664cT3Zae88Fi3LMvpKWZt1J7c7TyzJHNd8pLczbwgLbwA6hELp7eAjdnwgES2cQoq42wCPtHSy9CTXjJ';
const SOLANA_TX_87 =
  'kvqERVGQjpGTemZe6rWzn4hvTuDDHMvUvhsEz31Hu2jbUmwxUigmoFPoKissZahDyNn8fRZ5TiSAJ9ftXou8JLy';

/** A bare `sha256(...).hexdigest()` — the shape of `Snapshot.inputs_digest`. */
const BARE_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** `GET /health` on 2026-08-30. A git SHA, and NOT a field this module validates. */
const BUILD_SHA = 'b5eb83903e36f20cdf21166ef8e2fba77a5a846b';

describe('the shapes the index actually emits are all accepted', () => {
  it.each([
    ['EVM tx hash (base)', EVM_TX],
    ['Solana signature, 88 chars', SOLANA_TX_88],
    ['Solana signature, 87 chars', SOLANA_TX_87],
    ['bare sha256 digest (inputs_digest)', BARE_DIGEST],
  ])('%s', (_label, value) => {
    expect(looksLikeOnchainId(value)).toBe(true);
  });

  it('MOUNTS THE BAD STATE: an EVM-only regex would flag every Solana rating', () => {
    // This is the discriminant test of the whole module. Replace the union in
    // `looksLikeOnchainId` with just the EVM branch — one line — and these two
    // go red while every other test in this file stays green. That is the bug
    // that would have shipped: an alarm screaming about perfectly good data on
    // one of the eleven chains, until somebody learned to ignore the alarm.
    const evmOnly = /^0x[0-9a-fA-F]{64}$/;
    expect(evmOnly.test(SOLANA_TX_88)).toBe(false);
    expect(evmOnly.test(SOLANA_TX_87)).toBe(false);
    expect(looksLikeOnchainId(SOLANA_TX_88)).toBe(true);
    expect(looksLikeOnchainId(SOLANA_TX_87)).toBe(true);
  });

  it('a mixed-case EVM hash is the same hash', () => {
    expect(looksLikeOnchainId(EVM_TX.toUpperCase().replace('0X', '0x'))).toBe(true);
  });
});

describe('what KarmaKadabra got bitten by is rejected', () => {
  it.each([
    ['the empty string', ''],
    ['the string "null"', 'null'],
    ['the string "undefined"', 'undefined'],
    ['the string "None"', 'None'],
    ['a bare 0x', '0x'],
    ['0x0', '0x0'],
    ['a truncated hash', EVM_TX.slice(0, 40)],
    ['a hash with one character too many', `${EVM_TX}a`],
    ['an error message parked in the field', 'error: could not fetch receipt'],
    ['a URL', 'https://basescan.org/tx/0xdead'],
    ['a Solana signature one character short of the window', SOLANA_TX_87.slice(0, 85)],
  ])('%s is not an on-chain id', (_label, value) => {
    expect(looksLikeOnchainId(value)).toBe(false);
  });

  it('every one of them passes a truthiness check, which is the point', () => {
    // `if (rating.txHash)` — the check every consumer writes — is `true` for
    // all of these. That is the gap this module closes.
    for (const value of ['null', 'undefined', '0x', '0x0', 'error: nope']) {
      expect(Boolean(value)).toBe(true);
      expect(looksLikeOnchainId(value)).toBe(false);
    }
  });
});

describe('the settlement receipt has its own rule, and `pending` is legitimate', () => {
  it('`pending` is a receipt but is NOT an on-chain id', () => {
    // The live OpenAPI declares the header as the settlement hash "or `pending`
    // if settlement has not reported one". Treating it as garbage would fire an
    // alarm on the happy path of every freshly settled payment.
    expect(looksLikeSettlementReceipt(SETTLEMENT_PENDING)).toBe(true);
    expect(looksLikeOnchainId(SETTLEMENT_PENDING)).toBe(false);
  });

  it('a settlement hash is a receipt, and garbage is not', () => {
    expect(looksLikeSettlementReceipt(EVM_TX)).toBe(true);
    expect(looksLikeSettlementReceipt('rcpt_abc123')).toBe(false);
    expect(looksLikeSettlementReceipt('')).toBe(false);
  });
});

describe('build_sha is deliberately NOT one of these fields', () => {
  it('a real "-dirty" stamp would be flagged, which is why nothing validates it', () => {
    // `describe-net/scripts/build_lambda_zip.py:64` stamps
    // `sha + ("-dirty" if sucio else "")`, so a legitimate deploy can publish
    // this. If someone ever wires `buildSha` through `hashField`, this test is
    // the argument against it: the validator is right and the alarm is wrong.
    expect(looksLikeOnchainId(BUILD_SHA)).toBe(false); // 40 hex, not 64
    expect(looksLikeOnchainId(`${BUILD_SHA}-dirty`)).toBe(false);
  });
});

describe('hashField — absent and malformed are NOT the same thing (R1, one level down)', () => {
  it('a valid hash comes through untouched and marks nothing', () => {
    const malformed: string[] = [];
    expect(hashField({ tx_hash: EVM_TX }, 'tx_hash', malformed)).toBe(EVM_TX);
    expect(malformed).toEqual([]);
  });

  it('ABSENT: null and undefined give null and are NOT reported', () => {
    // The schema says it itself: tx_hash is "null until the log scan reaches
    // this entry, not null forever". A hole here is normal.
    const malformed: string[] = [];
    expect(hashField({ tx_hash: null }, 'tx_hash', malformed)).toBeNull();
    expect(hashField({}, 'tx_hash', malformed)).toBeNull();
    expect(malformed).toEqual([]);
  });

  it('MALFORMED: garbage gives null AND is reported', () => {
    const malformed: string[] = [];
    expect(hashField({ tx_hash: '0x' }, 'tx_hash', malformed)).toBeNull();
    expect(malformed).toEqual(['tx_hash']);
  });

  it('MOUNTS THE BAD STATE: the two absences must not collapse into one', () => {
    // If `hashField` ever stopped marking — or started marking a plain null —
    // these two objects would become byte-identical, and the caller would have
    // no way to tell "the indexer has not caught up" from "the service served
    // nonsense". That is R1 arriving one level below where it usually lives.
    const absent: string[] = [];
    const garbage: string[] = [];
    const a = hashField({ tx_hash: null }, 'tx_hash', absent);
    const g = hashField({ tx_hash: 'undefined' }, 'tx_hash', garbage);

    expect(a).toBeNull();
    expect(g).toBeNull();
    expect(a).toEqual(g); // the VALUES are identical...
    expect(absent).not.toEqual(garbage); // ...and only the marks separate them
  });

  it('a non-string is garbage, not absence — the wire said something', () => {
    const malformed: string[] = [];
    expect(hashField({ tx_hash: 12345 }, 'tx_hash', malformed)).toBeNull();
    expect(hashField({ feedback_hash: { nested: true } }, 'feedback_hash', malformed)).toBeNull();
    expect(malformed).toEqual(['tx_hash', 'feedback_hash']);
  });

  it('takes the receipt predicate when it is handed one', () => {
    const malformed: string[] = [];
    expect(
      hashField({ receipt: SETTLEMENT_PENDING }, 'receipt', malformed, looksLikeSettlementReceipt),
    ).toBe(SETTLEMENT_PENDING);
    expect(hashField({ receipt: SETTLEMENT_PENDING }, 'receipt', malformed)).toBeNull();
    expect(malformed).toEqual(['receipt']);
  });
});

describe('malformedHashReport locates every one of them', () => {
  it('qualifies the path, with the index, in wire names', () => {
    const report = malformedHashReport({
      ratings: [
        { malformedHashes: [] },
        { malformedHashes: [] },
        { malformedHashes: ['tx_hash', 'revoked_tx'] },
      ],
      snapshot: { malformedHashes: ['inputs_digest'] },
      payment: { malformedHashes: ['receipt'] },
    });

    expect(report).toEqual([
      'ratings[2].tx_hash',
      'ratings[2].revoked_tx',
      'snapshot.inputs_digest',
      'payment.receipt',
    ]);
  });

  it('is empty for a clean result, and for nothing at all', () => {
    expect(malformedHashReport({ ratings: [{ malformedHashes: [] }] })).toEqual([]);
    expect(malformedHashReport({})).toEqual([]);
    expect(malformedHashReport(null)).toEqual([]);
  });
});
