import { describe, expect, it } from 'vitest';

import { buildDescribeScoreCard, describeProfileHref, parseScoreValue, resolveLang } from './card';
import * as widget from './index';

const WALLET = '0x97cd0bd8a3ccad6b1e3b8f3a0a3e6f2b7e2b0996';
const SOLANA = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

describe('importing the widget without a DOM (this file runs in Node)', () => {
  it('does not throw, registers nothing, and says so', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
    expect(typeof (globalThis as { customElements?: unknown }).customElements).toBe('undefined');
    expect(widget.defineDescribeScore()).toBe(false);
    expect(widget.defineDescribeScore('describe-score')).toBe(false);
  });

  it('exports the pure model and the credit, and nothing that needs a window', () => {
    expect(Object.keys(widget).sort()).toEqual(
      ['DESCRIBE_ATTRIBUTION', 'buildDescribeScoreCard', 'defineDescribeScore'].sort(),
    );
    expect(widget.DESCRIBE_ATTRIBUTION).toBe('Powered by describe.net');
  });
});

describe('the score — null is never 0', () => {
  it('writes 83.0 as "83" (the canonical witness case of format.ts)', () => {
    const card = buildDescribeScoreCard({ score: '83.0' }, 'en');
    expect(card.hasScore).toBe(true);
    expect(card.face).toBe('83');
    expect(buildDescribeScoreCard({ score: 86.653045 }, 'en').face).toBe('86.65');
  });

  it('MOUNTS THE BAD STATE: Number() turns an empty attribute into a 0', () => {
    // The trap this parser exists for. If this ever stops being true the
    // guard is merely redundant — but while it IS true, Number(attr) would
    // publish "worst possible reputation" for every unfilled attribute.
    expect(Number('')).toBe(0);
    expect(Number('   ')).toBe(0);
    expect(Number('0x10')).toBe(16);
    expect(parseScoreValue('')).toBeNull();
    expect(parseScoreValue('   ')).toBeNull();
    expect(parseScoreValue('0x10')).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '  '],
    ['text', 'abc'],
    ['hex', '0x10'],
    ['Infinity', 'Infinity'],
    ['NaN number', Number.NaN],
    ['Infinity number', Number.POSITIVE_INFINITY],
    ['markup', '<img src=x onerror=alert(1)>'],
  ])('%s is NO DATA, never "0"', (_label, score) => {
    for (const [lang, words] of [
      ['es', 'sin datos'],
      ['en', 'no data'],
      ['pt', 'sem dados'],
    ] as const) {
      const card = buildDescribeScoreCard({ score }, lang);
      expect(card.hasScore).toBe(false);
      expect(card.face).toBe(words);
      expect(card.face).not.toContain('0');
    }
  });

  it('a real zero IS a score: absence and zero stay distinct', () => {
    expect(buildDescribeScoreCard({ score: '0' }, 'en')).toMatchObject({ hasScore: true, face: '0' });
    expect(buildDescribeScoreCard({ score: 0 }, 'en')).toMatchObject({ hasScore: true, face: '0' });
  });

  it('accepts what String(n) writes, exponent included, and trims', () => {
    expect(parseScoreValue(' 91.5 ')).toBe(91.5);
    expect(parseScoreValue('1e-7')).toBe(1e-7);
    expect(parseScoreValue('.5')).toBe(0.5);
  });
});

describe('the link — never an invented destination', () => {
  it('wallet → ?wallet=, encoded', () => {
    expect(describeProfileHref(WALLET, null)).toBe(`https://describe.net/agent.html?wallet=${WALLET}`);
    expect(describeProfileHref(SOLANA, 'ignored')).toBe(
      `https://describe.net/agent.html?wallet=${SOLANA}`,
    );
    expect(describeProfileHref('a b&c=<d>', null)).toBe(
      'https://describe.net/agent.html?wallet=a%20b%26c%3D%3Cd%3E',
    );
  });

  it('no wallet, a query → ?q=', () => {
    expect(describeProfileHref(null, 'agent #42')).toBe('https://describe.net/agent.html?q=agent%20%2342');
    expect(describeProfileHref('   ', 'x')).toBe('https://describe.net/agent.html?q=x');
  });

  it('neither → null, and the card then offers no "open" line', () => {
    expect(describeProfileHref(null, null)).toBeNull();
    expect(describeProfileHref('', '  ')).toBeNull();
    const card = buildDescribeScoreCard({ score: '80' }, 'en');
    expect(card.href).toBeNull();
    expect(card.openHint).toBeNull();
  });

  it('a link without a score still links — the profile is where "no data" is explained', () => {
    const card = buildDescribeScoreCard({ wallet: WALLET }, 'es');
    expect(card.hasScore).toBe(false);
    expect(card.href).toContain('?wallet=');
    expect(card.openHint).toBe('Clic para abrir el perfil público');
  });

  it('MOUNTS THE BAD STATE: a lone surrogate cannot be linked — no link, never a throw', () => {
    // encodeURIComponent throws on it; uncaught, the render aborted before the
    // face was written and the score vanished (refuter's P3-2, 2026-09-30).
    expect(() => encodeURIComponent('\uD800')).toThrow(URIError);
    expect(describeProfileHref('\uD800abc', null)).toBeNull();
    expect(describeProfileHref(null, 'name \uD83D')).toBeNull();
    // A wallet that cannot be linked does not fall back to a different lookup.
    expect(describeProfileHref('\uD800', 'agent 7')).toBeNull();
    const card = buildDescribeScoreCard({ score: '83', wallet: '\uD800' }, 'en');
    expect(card).toMatchObject({ face: '83', hasScore: true, href: null, openHint: null });
  });
});

describe('the rows — only what came', () => {
  it('no data, no rows', () => {
    expect(buildDescribeScoreCard({ score: '80' }, 'en').rows).toEqual([]);
  });

  it('keeps a fixed order and skips what did not come', () => {
    const card = buildDescribeScoreCard(
      { reviews: '123', policy: 'v3', identities: '2', chains: '4' },
      'es',
    );
    expect(card.rows.map((r) => [r.key, r.label, r.value])).toEqual([
      ['policy', 'política', 'v3'],
      ['chains', 'cadenas', '4'],
      ['identities', 'identidades', '2'],
      ['reviews', 'reseñas', '123'],
    ]);
  });

  it('a 0 came; an empty string did not', () => {
    const card = buildDescribeScoreCard({ reviews: 0, identities: '', chains: '  ' }, 'en');
    expect(card.rows).toEqual([{ key: 'reviews', label: 'reviews', value: '0' }]);
  });

  it('a date that parses is made readable; one that does not is shown raw', () => {
    const iso = '2026-09-09T17:49:39.070989Z';
    const card = buildDescribeScoreCard(
      { refreshedAt: iso, retrievedAt: 'yesterday-ish' },
      'en',
    );
    const [refreshed, retrieved] = card.rows;
    expect(refreshed.key).toBe('refreshedAt');
    expect(refreshed.label).toBe('updated');
    expect(refreshed.value).not.toBe(iso);
    expect(refreshed.value).toContain('2026');
    expect(retrieved).toEqual({ key: 'retrievedAt', label: 'retrieved', value: 'yesterday-ish' });
  });

  it('the readable date is EXACTLY Intl medium + short (computed the same way, so no time zone leaks in)', () => {
    // An ISO string re-serialised passes "not the input" and "contains 2026";
    // only the exact format pins what the brief asked for (refuter's M4).
    const expected = (s: string, locale: string): string =>
      new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s));
    const iso = '2026-09-09T17:49:39.070989Z';
    expect(buildDescribeScoreCard({ refreshedAt: iso }, 'en').rows[0].value).toBe(expected(iso, 'en'));
    expect(buildDescribeScoreCard({ retrievedAt: iso }, 'es-CO').rows[0].value).toBe(expected(iso, 'es-CO'));
    const python = '2026-09-30 14:15:39.070989+00:00';
    expect(buildDescribeScoreCard({ refreshedAt: python }, 'pt').rows[0].value).toBe(expected(python, 'pt'));
  });

  it('shaped like ISO but not a real instant (month 13, hour 25) is shown raw too', () => {
    const raw = '2026-13-45T25:99Z';
    expect(Number.isNaN(new Date(raw).getTime())).toBe(true);
    expect(buildDescribeScoreCard({ refreshedAt: raw }, 'en').rows[0].value).toBe(raw);
  });

  it.each([
    ['Version 2', 'Feb 1, 2001'],
    ['12', 'Dec 1, 2001'],
    ['abc 2020', 'Jan 1, 2020'],
    ['2026-09-30', 'the previous day west of UTC'],
  ])('MOUNTS THE BAD STATE: %j is shown raw, not guessed into %s', (raw) => {
    // new Date() alone accepts every one of these (Node 20, refuter's P3-1).
    expect(Number.isNaN(new Date(raw).getTime())).toBe(false);
    expect(buildDescribeScoreCard({ refreshedAt: raw }, 'en').rows[0].value).toBe(raw);
  });
});

describe('languages', () => {
  it('the credit is identical in es, en and pt — never translated', () => {
    const seals = (['es', 'en', 'pt'] as const).map((l) => buildDescribeScoreCard({}, l).seal);
    expect(seals).toEqual(['POWERED BY DESCRIBE.NET', 'POWERED BY DESCRIBE.NET', 'POWERED BY DESCRIBE.NET']);
    expect(buildDescribeScoreCard({}, 'pt').title).toBe('describe.net');
  });

  it('the sentence is translated, and es/en are KarmaKadabra\'s words', () => {
    expect(buildDescribeScoreCard({}, 'es').text).toBe('Agregado por cadena desde reseñas on-chain ERC-8004.');
    expect(buildDescribeScoreCard({}, 'en').text).toBe('Aggregated per chain from on-chain ERC-8004 reviews.');
    expect(buildDescribeScoreCard({}, 'pt').text).toBe(
      'Agregado por cadeia a partir de avaliações on-chain ERC-8004.',
    );
  });

  it.each([
    ['es', 'es', 'es'],
    ['es-CO', 'es', 'es-CO'],
    ['pt_BR', 'pt', 'pt-BR'],
    ['EN', 'en', 'en'],
    ['fr', 'en', 'en'],
    ['', 'en', 'en'],
    [undefined, 'en', 'en'],
  ])('%s → %s (Intl locale %s)', (tag, lang, locale) => {
    expect(resolveLang(tag)).toEqual({ lang, locale });
  });

  it('a malformed tag in a known language keeps the language', () => {
    expect(resolveLang('es-@@').lang).toBe('es');
  });
});
