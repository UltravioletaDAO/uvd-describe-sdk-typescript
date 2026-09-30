/**
 * The card's look: describe.net's own tokens, written ONCE, and the CSS derived
 * from them.
 *
 * ## Where every default comes from
 *
 * `describe-net/site/theme-describeme.css` (4fae42a), the light/dark pairs of its
 * `light-dark()` declarations: `--surface-raised` (:35), `--text-primary` (:47),
 * `--text-secondary` (:48), `--border-subtle` (:62), `--accent` (:78),
 * `--radius-surface` (:229) and `--shadow-overlay` (:261). The credit on the card
 * is describe.net's, so the card wears describe.net's colours unless the host
 * says otherwise — and a host says otherwise through the `--describe-score-*`
 * custom properties below (KarmaKadabra passes its purple gradient through
 * `--describe-score-bg`, which is why the background is painted with
 * `background`, not `background-color`).
 *
 * The contrast of every text colour against its background is COMPUTED in
 * `theme.test.ts` (WCAG 2.1 relative luminance, AA = 4.5:1 for body text) for
 * both themes, so changing a token here is a red test before it is an
 * unreadable card. One thing is deliberately NOT KK's: its seal was white at
 * 62 % opacity, which is a contrast nobody measured; here it is the secondary
 * text colour at full opacity.
 *
 * ## No network, and that is checked too
 *
 * No `url(`, no `@import`, no web font: the font stacks are system fonts. The
 * component paints only what the host handed it (see `index.ts` for why that
 * is what lets it exist next to describe.net's no-widget rule).
 */

interface Palette {
  bg: string;
  border: string;
  text: string;
  textSecondary: string;
  accent: string;
  shadow: string;
}

/** The defaults. Read by the CSS below and by the contrast test — nowhere else. */
export const DESCRIBE_SCORE_TOKENS: Readonly<{
  light: Readonly<Palette>;
  dark: Readonly<Palette>;
  radius: string;
  font: string;
}> = Object.freeze({
  light: Object.freeze({
    bg: '#ffffff',
    border: '#e2ded4',
    text: '#1a1730',
    textSecondary: '#4a4668',
    accent: '#332c86',
    shadow: '0 12px 32px rgb(26 23 48 / 0.18)',
  }),
  dark: Object.freeze({
    bg: '#1e1b2d',
    border: '#2c2840',
    text: '#f2f0ea',
    textSecondary: '#c3bfd4',
    accent: '#a9a2ff',
    shadow: '0 12px 32px rgb(0 0 0 / 0.6)',
  }),
  radius: '0.375rem',
  // describe.net's `--font-body` fallback chain (:246) without its web font:
  // naming Figtree would only work on a page that already loaded it.
  font: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
});

/** Public name of each overridable property, keyed by the token it overrides. */
export const DESCRIBE_SCORE_CSS_VARS: Readonly<Record<keyof Palette | 'radius' | 'font', string>> =
  Object.freeze({
    bg: '--describe-score-bg',
    border: '--describe-score-border',
    text: '--describe-score-text',
    textSecondary: '--describe-score-text-secondary',
    accent: '--describe-score-accent',
    shadow: '--describe-score-shadow',
    radius: '--describe-score-radius',
    font: '--describe-score-font',
  });

function palette(p: Readonly<Palette>): string {
  return (Object.keys(p) as (keyof Palette)[])
    .map((k) => `--_ds-${k}: var(${DESCRIBE_SCORE_CSS_VARS[k]}, ${p[k]});`)
    .join(' ');
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * The shadow root's stylesheet.
 *
 * `theme` is resolved here and not in JavaScript: `auto` (or absent, or any
 * value but `light`) follows `prefers-color-scheme`; `light` and `dark` force.
 * A page that switches theme with a CLASS (Tailwind `darkMode: 'class'`, as
 * Execution Market does) is invisible to a media query and to a shadow root —
 * `:host-context()` is Chromium-only — so such a host passes `theme="dark"`
 * itself.
 *
 * The card resets everything it would otherwise inherit from the host
 * (`all: initial`), font family included, and takes its own
 * (`--describe-score-font`). The face inherits the host's font and colour on
 * purpose — that is how the host's classes style the number — but a 26 px bold
 * monospace number must not turn its card into 26 px bold monospace prose.
 * Measured in the demo, 2026-09-30: with `font-family: inherit` the card of
 * every `.big` score came out in monospace.
 *
 * What NO stylesheet in here can stop: `opacity`, `filter` or `transform` on
 * the `<describe-score>` element itself apply to its whole box, card included
 * (the demo's muted "no data" faded its card too). A host that wants only the
 * number styled that way targets `::part(face)`.
 */
export const DESCRIBE_SCORE_CSS = `
:host { position: relative; display: inline-block; ${palette(DESCRIBE_SCORE_TOKENS.light)} --_ds-radius: var(${DESCRIBE_SCORE_CSS_VARS.radius}, ${DESCRIBE_SCORE_TOKENS.radius}); }
:host([theme="dark"]) { ${palette(DESCRIBE_SCORE_TOKENS.dark)} }
@media (prefers-color-scheme: dark) { :host(:not([theme="light"])) { ${palette(DESCRIBE_SCORE_TOKENS.dark)} } }
:host([hidden]) { display: none; }
a, .face { color: inherit; font: inherit; text-decoration: inherit; }
[hidden] { display: none; }
.card {
  all: initial;
  display: block; position: absolute; top: calc(100% + 8px); left: 0; z-index: 60;
  box-sizing: border-box; width: max-content; max-width: min(20rem, calc(100vw - 16px));
  padding: 0.8rem 0.95rem; border: 1px solid var(--_ds-border); border-radius: var(--_ds-radius);
  background: var(--_ds-bg); box-shadow: var(--_ds-shadow); color: var(--_ds-text);
  font-family: var(${DESCRIBE_SCORE_CSS_VARS.font}, ${DESCRIBE_SCORE_TOKENS.font}); font-size: 0.8125rem; line-height: 1.45; text-align: start; overflow-wrap: anywhere;
  translate: var(--_ds-dx, 0px) 0;
  opacity: 0; visibility: hidden; transform: translateY(-4px);
  transition: opacity .13s ease, transform .13s ease, visibility 0s linear .13s;
}
.card::before { content: ""; position: absolute; left: 0; right: 0; bottom: 100%; height: 10px; }
.card[data-open] { opacity: 1; visibility: visible; transform: none; transition-delay: 0s; }
:host([placement="bottom-end"]) .card { left: auto; right: 0; }
.mark { font-size: 1rem; font-weight: 700; letter-spacing: -0.01em; }
.mark span { color: var(--_ds-accent); }
.seal { margin-top: 0.125rem; font-family: ${MONO}; font-size: 0.625rem; letter-spacing: 0.14em; color: var(--_ds-textSecondary); }
.text { margin-top: 0.55rem; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 0.2rem 0.65rem; margin: 0.6rem 0 0; padding-top: 0.55rem; border-top: 1px solid var(--_ds-border); font-family: ${MONO}; font-size: 0.6875rem; }
dt { color: var(--_ds-textSecondary); }
dd { margin: 0; }
.open { margin-top: 0.6rem; font-size: 0.6875rem; color: var(--_ds-accent); }
@media (prefers-reduced-motion: reduce) { .card { transition: none; } }
`;
