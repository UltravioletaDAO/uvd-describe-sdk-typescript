/**
 * `<describe-score>` — the painter. Every decision about WHAT it shows lives in
 * `card.ts`; this file decides how it is drawn and how it opens.
 *
 * ## Why a custom element, and why its class is built on demand
 *
 * The three hosts are React 18 + Tailwind (Execution Market), React (MeshRelay)
 * and vanilla ES modules with no bundler (KarmaKadabra). The one thing all three
 * can mount is a custom element. And `class X extends HTMLElement` written at
 * module scope throws `ReferenceError` the moment Node imports the file, so the
 * class is created inside {@link defineDescribeScore}: importing this subpath
 * on a server registers nothing, touches no `document`, and cannot fail.
 *
 * ## How the card opens — WCAG 1.4.13 and 2.1.1, one clause each
 *
 *   * **Keyboard (2.1.1)**: the card opens on focus as well as on hover. With a
 *     link the link is the trigger; without one the face gets `tabindex="0"`
 *     (KK's fix), because a card that only a mouse can open does not exist for
 *     whoever navigates with a keyboard — and without a score that card is the
 *     only thing explaining the "no data".
 *   * **Hoverable**: the card sits 8 px below the number, and a transparent
 *     bridge (`.card::before`) covers the gap, so moving the pointer from the
 *     number onto the card never crosses dead air. KK relied on a 130 ms hide
 *     delay to survive the gap; a slow hand lost it.
 *   * **Persistent**: it stays open while hovered or focused. No timer closes it.
 *   * **Dismissible**: `Escape` closes it without moving focus or the pointer.
 *     It stays closed until the pointer re-enters or focus comes back. The
 *     `Escape` is CONSUMED (`stopPropagation`, capture phase on the document)
 *     only when the card is open by keyboard focus on its trigger: then the card
 *     is the innermost layer, and one keypress must close it, not the card AND
 *     the modal Execution Market renders it in. Opened by hover alone, the card
 *     closes and the key goes on: focus is on some other control (a textarea
 *     in that same modal), and swallowing that control's `Escape` for a card
 *     the user may not even be looking at was the refuter's P2-2 of
 *     2026-09-30 (the first version consumed it whenever a card was open).
 *     While no card is open, no listener exists and nothing is consumed.
 *   * **The trigger names the card**: `aria-describedby` → the card's id, in
 *     the same shadow root (an id reference cannot cross a shadow boundary).
 *
 * The open/closed state is JavaScript, not `:hover` / `:focus-within`, because
 * `Escape` has to be able to override both and a stylesheet cannot remember
 * that it was dismissed.
 *
 * ## The face, and the whitespace trap
 *
 * The host's children, if any, are the face (MeshRelay's bar); otherwise the
 * formatted score is. That is `<slot>` with fallback content — except that a
 * slot with ANY assigned node does not render its fallback, and a whitespace
 * text node is assignable: `<describe-score score="83">⏎</describe-score>`,
 * which is how every formatter writes it, would show an empty face. So the
 * fallback is a sibling of the slot, hidden only when a child with content is
 * actually slotted.
 *
 * 🔴 **Nothing from the host is ever parsed as HTML.** Every string is set
 * with `textContent` or an attribute; the one `href` is built by
 * `describeProfileHref()` and always starts with describe.net's origin. The
 * test that feeds `<img src=x onerror=…>` through every field went red when
 * one `dd` was switched to HTML parsing (mutation run, 2026-09-30).
 */

import { buildDescribeScoreCard, type DescribeScoreCard } from './card';
import { DESCRIBE_SCORE_CSS } from './theme';

/** The element's JavaScript API. Every property reflects its attribute. */
export interface DescribeScoreElement extends HTMLElement {
  score: string | null;
  wallet: string | null;
  query: string | null;
  reviews: string | null;
  identities: string | null;
  chains: string | null;
  policy: string | null;
  refreshedAt: string | null;
  retrievedAt: string | null;
  /** `auto` (default) | `light` | `dark`. */
  theme: string | null;
  /** `bottom-start` (default) | `bottom-end`. */
  placement: string | null;
}

/** Property → attribute. `lang` is not here: `HTMLElement` already reflects it. */
const REFLECTED: ReadonlyArray<readonly [string, string]> = [
  ['score', 'score'],
  ['wallet', 'wallet'],
  ['query', 'query'],
  ['reviews', 'reviews'],
  ['identities', 'identities'],
  ['chains', 'chains'],
  ['policy', 'policy'],
  ['refreshedAt', 'refreshed-at'],
  ['retrievedAt', 'retrieved-at'],
  ['theme', 'theme'],
  ['placement', 'placement'],
];

/** What changes the card. `theme` and `placement` are pure CSS (`:host([…])`). */
const OBSERVED = [
  'score',
  'wallet',
  'query',
  'reviews',
  'identities',
  'chains',
  'policy',
  'refreshed-at',
  'retrieved-at',
  'lang',
];

const CARD_ID = 'card';

/** Kept this far from the viewport edge. */
const EDGE_PX = 8;

/**
 * How far to slide a card spanning `left..right` so it stays inside
 * `0..viewport` with `margin` to spare. Pure, so it is tested without layout.
 *
 * `placement` is a preference; this is the guarantee — KK's "anchor right under
 * 560 px" pushes a LEFT-aligned score's card off the other edge.
 */
export function horizontalShift(
  left: number,
  right: number,
  viewport: number,
  margin: number = EDGE_PX,
): number {
  if (right - left > viewport - 2 * margin) return margin - left;
  if (right > viewport - margin) return viewport - margin - right;
  if (left < margin) return margin - left;
  return 0;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function cardChildren(doc: Document, model: DescribeScoreCard): Node[] {
  const out: Node[] = [];
  const mark = el(doc, 'div', 'mark');
  const dot = model.title.indexOf('.');
  mark.append(doc.createTextNode(model.title.slice(0, dot)), el(doc, 'span', '', model.title.slice(dot)));
  out.push(mark, el(doc, 'div', 'seal', model.seal), el(doc, 'div', 'text', model.text));
  if (model.rows.length > 0) {
    const dl = el(doc, 'dl');
    for (const row of model.rows) {
      const dt = el(doc, 'dt', '', row.label);
      dt.dataset.key = row.key;
      dl.append(dt, el(doc, 'dd', '', row.value));
    }
    out.push(dl);
  }
  if (model.openHint !== null) {
    const open = el(doc, 'div', 'open', model.openHint);
    const arrow = el(doc, 'span', '', ' ↗');
    arrow.setAttribute('aria-hidden', 'true');
    open.append(arrow);
    out.push(open);
  }
  return out;
}

/** A child the host put there to BE the face — not whitespace, not a named slot. */
function hasCustomFace(host: HTMLElement): boolean {
  for (const node of Array.from(host.childNodes)) {
    if (node.nodeType === 1 && !(node as Element).hasAttribute('slot')) return true;
    if (node.nodeType === 3 && (node.textContent ?? '').trim() !== '') return true;
  }
  return false;
}

/** A fresh class per call: one constructor may be registered under one name only. */
function createDescribeScoreClass(): CustomElementConstructor {
  class DescribeScore extends HTMLElement {
    static get observedAttributes(): string[] {
      return OBSERVED;
    }

    readonly #face: HTMLSpanElement;
    readonly #value: HTMLSpanElement;
    readonly #card: HTMLDivElement;
    #link: HTMLAnchorElement | null = null;
    #hovered = false;
    #focused = false;
    #dismissed = false;
    #open = false;

    constructor() {
      super();
      const doc = this.ownerDocument;
      const root = this.attachShadow({ mode: 'open' });
      const style = el(doc, 'style', '', DESCRIBE_SCORE_CSS);
      this.#face = el(doc, 'span', 'face');
      this.#face.setAttribute('part', 'face');
      this.#value = el(doc, 'span', 'value');
      const slot = el(doc, 'slot');
      slot.addEventListener('slotchange', () => {
        this.#value.hidden = hasCustomFace(this);
      });
      this.#face.append(this.#value, slot);
      this.#card = el(doc, 'div', 'card');
      this.#card.id = CARD_ID;
      this.#card.setAttribute('role', 'tooltip');
      this.#card.setAttribute('part', 'card');
      root.append(style, this.#face, this.#card);

      this.addEventListener('pointerenter', () => {
        this.#hovered = true;
        this.#dismissed = false;
        this.#update();
      });
      this.addEventListener('pointerleave', () => {
        this.#hovered = false;
        this.#update();
      });
      this.addEventListener('focusin', () => {
        this.#focused = true;
        this.#dismissed = false;
        this.#update();
      });
      this.addEventListener('focusout', () => {
        this.#focused = false;
        this.#update();
      });
    }

    connectedCallback(): void {
      // A property set before the tag was defined is an OWN property that
      // shadows the accessor; move it onto the attribute it belongs to.
      for (const [prop] of REFLECTED) {
        if (Object.prototype.hasOwnProperty.call(this, prop)) {
          const value = (this as unknown as Record<string, unknown>)[prop];
          delete (this as unknown as Record<string, unknown>)[prop];
          (this as unknown as Record<string, unknown>)[prop] = value;
        }
      }
      this.#render();
    }

    disconnectedCallback(): void {
      this.#hovered = false;
      this.#focused = false;
      this.#update();
    }

    attributeChangedCallback(): void {
      if (this.isConnected) this.#render();
    }

    #render(): void {
      const doc = this.ownerDocument;
      const model = buildDescribeScoreCard(
        {
          score: this.getAttribute('score'),
          wallet: this.getAttribute('wallet'),
          query: this.getAttribute('query'),
          reviews: this.getAttribute('reviews'),
          identities: this.getAttribute('identities'),
          chains: this.getAttribute('chains'),
          policy: this.getAttribute('policy'),
          refreshedAt: this.getAttribute('refreshed-at'),
          retrievedAt: this.getAttribute('retrieved-at'),
        },
        this.getAttribute('lang') || doc.documentElement.lang,
      );

      this.#value.textContent = model.face;
      this.#value.setAttribute('lang', model.lang);
      this.#value.hidden = hasCustomFace(this);

      if (model.href === null) {
        if (this.#link) {
          this.#link.replaceWith(this.#face);
          this.#link = null;
        }
        this.#face.setAttribute('tabindex', '0');
        this.#face.setAttribute('aria-describedby', CARD_ID);
      } else {
        if (!this.#link) {
          const a = el(doc, 'a');
          a.setAttribute('part', 'link');
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          a.setAttribute('aria-describedby', CARD_ID);
          this.#face.removeAttribute('tabindex');
          this.#face.removeAttribute('aria-describedby');
          this.#face.replaceWith(a);
          a.append(this.#face);
          this.#link = a;
        }
        this.#link.setAttribute('href', model.href);
      }

      this.#card.setAttribute('lang', model.lang);
      this.#card.replaceChildren(...cardChildren(doc, model));
    }

    #onKeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !this.#open) return;
      // Consumed only when focus is on this card's trigger: then the card IS
      // the innermost layer. Opened by hover alone, focus is somewhere else
      // (a textarea in a modal) and that control's own Escape must arrive.
      if (this.#focused) event.stopPropagation();
      this.#dismissed = true;
      this.#update();
    };

    #update(): void {
      const open = (this.#hovered || this.#focused) && !this.#dismissed;
      if (open === this.#open) return;
      this.#open = open;
      this.#card.toggleAttribute('data-open', open);
      const doc = this.ownerDocument;
      if (open) {
        doc.addEventListener('keydown', this.#onKeydown, true);
        this.#place();
      } else {
        doc.removeEventListener('keydown', this.#onKeydown, true);
      }
    }

    /**
     * 🔴 The shift lives in the CSS `translate` property, which has no
     * transition, and never in the transitioned `transform`. Measured in
     * Chromium, 2026-09-30, at 360 px: with the shift inside `transform`, the
     * reset to `0px` started a transition, `getBoundingClientRect()` read the
     * card where the PREVIOUS opening had left it, computed "fits", and every
     * card after the first sat 7 px past the edge.
     */
    #place(): void {
      const card = this.#card;
      card.style.setProperty('--_ds-dx', '0px');
      const viewport = this.ownerDocument.documentElement.clientWidth;
      if (!viewport) return;
      const rect = card.getBoundingClientRect();
      const dx = horizontalShift(rect.left, rect.right, viewport);
      if (dx !== 0) card.style.setProperty('--_ds-dx', `${dx}px`);
    }
  }

  for (const [prop, attr] of REFLECTED) {
    Object.defineProperty(DescribeScore.prototype, prop, {
      configurable: true,
      enumerable: true,
      get(this: HTMLElement): string | null {
        return this.getAttribute(attr);
      },
      set(this: HTMLElement, value: unknown): void {
        if (value === null || value === undefined) this.removeAttribute(attr);
        else this.setAttribute(attr, String(value));
      },
    });
  }

  return DescribeScore;
}

/**
 * Registers `<describe-score>` (or `tagName`). Returns `true` if it registered
 * now, `false` if there is nothing to do: no `customElements` (Node, SSR), or
 * the tag is already taken. Calling it twice is safe; an invalid tag name
 * (no hyphen) throws, because that is a bug in the call and not an environment.
 *
 * Nothing registers on import — this function is the only door.
 */
export function defineDescribeScore(tagName: string = 'describe-score'): boolean {
  if (typeof customElements === 'undefined' || typeof HTMLElement === 'undefined') return false;
  if (customElements.get(tagName) !== undefined) return false;
  customElements.define(tagName, createDescribeScoreClass());
  return true;
}
