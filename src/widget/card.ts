/**
 * The describe.net score card as DATA — what the `<describe-score>` element
 * paints, computed without a DOM.
 *
 * ## Why a pure model sits under the element
 *
 * Three surfaces of the stack drew "a number from describe.net, with credit"
 * three different ways (measured 2026-09-30): Execution Market and MeshRelay put
 * `Powered by describe.net` in a native `title=` — the grey operating-system box
 * the owner reported — and KarmaKadabra built the one styled card
 * (`dashboard/live/js/agent.js:583-634`, commit b5122230). What the three
 * DISAGREED on was never the pixels: it was which rows appear, what an absent
 * score says, and where the link goes. Those decisions live here, in one
 * function a test can call in Node, so the element is only a painter and a
 * surface that cannot run a custom element (a server-rendered page, a canvas)
 * can still paint the same card by hand from the same model.
 *
 * ## The rules, each one inherited from where it was measured
 *
 *   * **`null` is never `0`.** An absent, empty or non-finite score is NO DATA and
 *     the face says so in words. 🔴 The trap is one line away: `Number('')` is
 *     `0`, and so are `Number(' ')` and `Number(null)` — the obvious
 *     `Number(attr)` publishes "worst possible reputation" for every element
 *     whose host has not filled the attribute yet. A score is accepted only if
 *     it is written as a decimal number; `0x10`, `Infinity` and `''` are not.
 *   * **The number is written by {@link formatScore}**, the one rule of the stack
 *     (`83.0` → `83`). The face never re-rounds on its own.
 *   * **A row appears only if its datum came** (KK's `fila()`). A `0` came; an
 *     empty string did not.
 *   * **A date that does not parse is shown raw** (KK's `_fecha()`): inventing a
 *     date would be worse than showing an ugly one.
 *   * **No destination is invented** (EM `AttributedScore.tsx:53-58`): a wallet
 *     links to `?wallet=`, else a query to `?q=`, else there is no link.
 *   * **The credit is never translated** (EM `AttributedScore.tsx:15`).
 */

import { DEFAULT_SITE_URL } from '../config';
import { formatScore } from '../format';

/** The credit, verbatim. Fixed by the directive of 2026-08-28 — never translated. */
export const DESCRIBE_ATTRIBUTION = 'Powered by describe.net';

/** The three languages the stack's surfaces speak (EM: es/en/pt; KK: es/en). */
export type DescribeScoreLang = 'es' | 'en' | 'pt';

/**
 * What a host hands the card. Every field is optional and every field may be a
 * string, because that is what an HTML attribute is; the element passes its
 * attributes straight through. Names follow the element's attributes; the wire
 * field each one carries is in its comment.
 */
export interface DescribeScoreData {
  /** `global_score`. Absent, empty or not a finite decimal = no data — never 0. */
  score?: number | string | null;
  /** The wallet the score belongs to, EVM hex or Solana base58. Builds `?wallet=`. */
  wallet?: string | null;
  /** Fallback lookup (agent id, name) when there is no wallet. Builds `?q=`. */
  query?: string | null;
  /** `total_reviews`. */
  reviews?: number | string | null;
  /** `identity_count` — a wallet can own N ERC-8004 identities it mints for free. */
  identities?: number | string | null;
  /** `chain_count`. */
  chains?: number | string | null;
  /** `policy_version`. */
  policy?: string | null;
  /** `refreshed_at` — ISO; when describe.net refreshed the number. */
  refreshedAt?: string | null;
  /** ISO; when the HOST took its snapshot of it. */
  retrievedAt?: string | null;
}

/** A row of the card, in display order. `key` is stable; `label` is translated. */
export interface DescribeScoreCardRow {
  key: 'refreshedAt' | 'retrievedAt' | 'policy' | 'chains' | 'identities' | 'reviews';
  label: string;
  value: string;
}

/** Everything the card shows, already decided. */
export interface DescribeScoreCard {
  /** The language the texts were resolved to. */
  lang: DescribeScoreLang;
  /** `false` when the score is absent — the face then says `noData`, never `0`. */
  hasScore: boolean;
  /** What the number's face shows: the formatted score, or the translated "no data". */
  face: string;
  /** The brand mark, `describe.net`. */
  title: string;
  /** The seal, `POWERED BY DESCRIBE.NET` in every language. */
  seal: string;
  /** "Aggregated per chain from on-chain ERC-8004 reviews.", translated. */
  text: string;
  /** Only the rows whose datum came, in a fixed order. */
  rows: DescribeScoreCardRow[];
  /** The public profile, or `null` when there is nothing to look up. */
  href: string | null;
  /** "Click to open the public profile", translated — `null` exactly when `href` is. */
  openHint: string | null;
}

interface Texts {
  text: string;
  noData: string;
  open: string;
  rows: Record<DescribeScoreCardRow['key'], string>;
}

/**
 * es and en are KK's wording (`agent.js:589-609`), kept word for word so the
 * surface that already had the card does not change its copy by migrating.
 */
const TEXTS: Readonly<Record<DescribeScoreLang, Texts>> = Object.freeze({
  es: {
    text: 'Agregado por cadena desde reseñas on-chain ERC-8004.',
    noData: 'sin datos',
    open: 'Clic para abrir el perfil público',
    rows: {
      refreshedAt: 'actualizado',
      retrievedAt: 'consultado',
      policy: 'política',
      chains: 'cadenas',
      identities: 'identidades',
      reviews: 'reseñas',
    },
  },
  en: {
    text: 'Aggregated per chain from on-chain ERC-8004 reviews.',
    noData: 'no data',
    open: 'Click to open the public profile',
    rows: {
      refreshedAt: 'updated',
      retrievedAt: 'retrieved',
      policy: 'policy',
      chains: 'chains',
      identities: 'identities',
      reviews: 'reviews',
    },
  },
  pt: {
    text: 'Agregado por cadeia a partir de avaliações on-chain ERC-8004.',
    noData: 'sem dados',
    open: 'Clique para abrir o perfil público',
    rows: {
      refreshedAt: 'atualizado',
      retrievedAt: 'consultado',
      policy: 'política',
      chains: 'cadeias',
      identities: 'identidades',
      reviews: 'avaliações',
    },
  },
});

/**
 * A decimal number as a human or `String(n)` writes it — including the
 * exponent `String()` produces for tiny values (`1e-7`). NOT `Number()`'s
 * grammar: that one also accepts `''`, `'0x10'`, `'0b1'` and `'Infinity'`.
 */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The score as a number, or `null` for anything that is not one. */
export function parseScoreValue(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!DECIMAL.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A datum as display text, or `null` when it did not come. */
function present(value: number | string | null | undefined): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

/**
 * `es`, `es-CO`, `pt_BR`, `EN` → the language; anything else → `en`.
 *
 * The full tag is kept for `Intl` when it is valid, so `es-CO` gets Colombian
 * dates while the strings stay the shared `es` ones.
 */
export function resolveLang(tag: string | null | undefined): {
  lang: DescribeScoreLang;
  locale: string;
} {
  const raw = (tag ?? '').trim().replace(/_/g, '-');
  const base = raw.split('-')[0].toLowerCase();
  if (base !== 'es' && base !== 'en' && base !== 'pt') return { lang: 'en', locale: 'en' };
  try {
    return { lang: base, locale: Intl.getCanonicalLocales(raw)[0] ?? base };
  } catch {
    return { lang: base, locale: base };
  }
}

/** Readable date, or the raw text when it does not parse. */
function readableDate(raw: string, locale: string): string {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  } catch {
    return raw;
  }
}

/** `https://describe.net/agent.html?wallet=…`, `?q=…`, or `null`. */
export function describeProfileHref(
  wallet: string | null | undefined,
  query: string | null | undefined,
): string | null {
  const w = present(wallet);
  if (w !== null) return `${DEFAULT_SITE_URL}/agent.html?wallet=${encodeURIComponent(w)}`;
  const q = present(query);
  if (q !== null) return `${DEFAULT_SITE_URL}/agent.html?q=${encodeURIComponent(q)}`;
  return null;
}

/**
 * The card for `data`, in `lang` (`es` | `en` | `pt`, or a full tag such as
 * `es-CO`; anything else is `en`).
 *
 * Pure: no DOM, no network, no clock. Call it from Node to test a surface, or
 * to paint the card by hand where a custom element cannot run.
 */
export function buildDescribeScoreCard(
  data: DescribeScoreData,
  lang?: string | null,
): DescribeScoreCard {
  const { lang: l, locale } = resolveLang(lang);
  const t = TEXTS[l];
  const formatted = formatScore(parseScoreValue(data.score));

  const rows: DescribeScoreCardRow[] = [];
  const add = (key: DescribeScoreCardRow['key'], value: string | null): void => {
    if (value !== null) rows.push({ key, label: t.rows[key], value });
  };
  const refreshed = present(data.refreshedAt);
  const retrieved = present(data.retrievedAt);
  add('refreshedAt', refreshed === null ? null : readableDate(refreshed, locale));
  add('retrievedAt', retrieved === null ? null : readableDate(retrieved, locale));
  add('policy', present(data.policy));
  add('chains', present(data.chains));
  add('identities', present(data.identities));
  add('reviews', present(data.reviews));

  const href = describeProfileHref(data.wallet, data.query);
  return {
    lang: l,
    hasScore: formatted !== null,
    face: formatted ?? t.noData,
    title: 'describe.net',
    seal: DESCRIBE_ATTRIBUTION.toUpperCase(),
    text: t.text,
    rows,
    href,
    openHint: href === null ? null : t.open,
  };
}
