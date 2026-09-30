// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { horizontalShift } from './element';
import { defineDescribeScore, type DescribeScoreElement } from './index';

const WALLET = '0x97cd0bd8a3ccad6b1e3b8f3a0a3e6f2b7e2b0996';
const PAYLOAD = '<img src=x onerror=alert(1)>';

beforeAll(() => {
  expect(defineDescribeScore()).toBe(true);
});

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('lang');
});

function mount(attrs: Record<string, string> = {}, children?: Node[]): DescribeScoreElement {
  const node = document.createElement('describe-score');
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (children) node.append(...children);
  document.body.append(node);
  return node;
}

const root = (node: HTMLElement): ShadowRoot => node.shadowRoot as ShadowRoot;
const face = (node: HTMLElement): HTMLElement => root(node).querySelector('[part="face"]') as HTMLElement;
const value = (node: HTMLElement): HTMLElement => root(node).querySelector('.value') as HTMLElement;
const card = (node: HTMLElement): HTMLElement => root(node).querySelector('[part="card"]') as HTMLElement;
const link = (node: HTMLElement): HTMLAnchorElement | null => root(node).querySelector('a');
const trigger = (node: HTMLElement): HTMLElement => (link(node) ?? face(node)) as HTMLElement;
const isOpen = (node: HTMLElement): boolean => card(node).hasAttribute('data-open');
const escape = (): boolean =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
/** Escape where a real keypress lands: on the focused element, composed out of any shadow root. */
const escapeOn = (target: EventTarget): boolean =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, composed: true }),
  );

describe('defineDescribeScore', () => {
  it('twice does not throw; the second call reports it had nothing to do', () => {
    expect(() => defineDescribeScore()).not.toThrow();
    expect(defineDescribeScore()).toBe(false);
    expect(customElements.get('describe-score')).toBeDefined();
  });

  it('can register under another name (a fresh class per call)', () => {
    expect(defineDescribeScore('uvd-describe-score')).toBe(true);
    const node = document.createElement('uvd-describe-score');
    node.setAttribute('score', '70');
    document.body.append(node);
    expect(value(node).textContent).toBe('70');
  });

  it('a name without a hyphen is a bug in the call, and throws', () => {
    expect(() => defineDescribeScore('describescore')).toThrow();
  });
});

describe('the face — null is never 0', () => {
  it('score="83.0" paints "83"', () => {
    expect(value(mount({ score: '83.0' })).textContent).toBe('83');
  });

  it('score="" and no score paint "no data" / "sin datos", never "0"', () => {
    for (const node of [mount({ score: '', lang: 'en' }), mount({ lang: 'en' })]) {
      expect(value(node).textContent).toBe('no data');
      expect(face(node).textContent).not.toContain('0');
    }
    expect(value(mount({ score: '', lang: 'es' })).textContent).toBe('sin datos');
    expect(value(mount({ lang: 'pt' })).textContent).toBe('sem dados');
  });

  it('follows <html lang> when the element has none, and falls back to English', () => {
    document.documentElement.setAttribute('lang', 'es-CO');
    expect(value(mount()).textContent).toBe('sin datos');
    document.documentElement.removeAttribute('lang');
    expect(value(mount()).textContent).toBe('no data');
  });

  it('a language switched at runtime re-renders an element that is already connected', () => {
    // README promises "a host that switches language at runtime passes it";
    // that only works while `lang` is an observed attribute (refuter's M2).
    const node = mount({ lang: 'en', 'refreshed-at': 'raw', wallet: WALLET });
    expect(node.isConnected).toBe(true);
    expect(value(node).textContent).toBe('no data');
    node.setAttribute('lang', 'es');
    expect(value(node).textContent).toBe('sin datos');
    expect(root(node).querySelector('dt')?.textContent).toBe('actualizado');
    expect(root(node).querySelector('.open')?.textContent).toBe('Clic para abrir el perfil público ↗');
  });

  it('re-renders when an attribute changes, and properties reflect attributes', () => {
    const node = mount({ score: '83' });
    node.setAttribute('score', '84.567');
    expect(value(node).textContent).toBe('84.57');
    node.score = '90';
    expect(node.getAttribute('score')).toBe('90');
    (node as unknown as { score: unknown }).score = 91.25;
    expect(node.getAttribute('score')).toBe('91.25');
    expect(value(node).textContent).toBe('91.25');
    node.refreshedAt = '2026-09-30T14:15:00Z';
    expect(node.getAttribute('refreshed-at')).toBe('2026-09-30T14:15:00Z');
    node.score = null;
    expect(node.hasAttribute('score')).toBe(false);
    expect(value(node).textContent).toBe('no data');
  });

  it('a property set BEFORE the tag is defined is not lost on upgrade', () => {
    const node = document.createElement('describe-late') as DescribeScoreElement;
    node.score = '42';
    document.body.append(node);
    expect(defineDescribeScore('describe-late')).toBe(true);
    expect(node.getAttribute('score')).toBe('42');
    expect(value(node).textContent).toBe('42');
  });

  it('children with content ARE the face (MeshRelay\'s bar)', () => {
    const bar = document.createElement('span');
    bar.className = 'bar';
    const node = mount({ score: '83' }, [bar]);
    expect(value(node).hidden).toBe(true);
    expect(face(node).querySelector('slot')).not.toBeNull();
  });

  it('MOUNTS THE BAD STATE: whitespace-only children do NOT blank the face', () => {
    // How every formatter writes it: <describe-score score="83">⏎</describe-score>.
    // A plain <slot> fallback would render nothing here.
    const node = mount({ score: '83' }, [document.createTextNode('\n    ')]);
    expect(node.childNodes.length).toBe(1);
    expect(value(node).hidden).toBe(false);
    expect(value(node).textContent).toBe('83');
  });
});

describe('the link', () => {
  it('wallet → ?wallet= encoded, new tab, no opener, no referrer', () => {
    const a = link(mount({ score: '83', wallet: WALLET }));
    expect(a).not.toBeNull();
    expect(a?.getAttribute('href')).toBe(`https://describe.net/agent.html?wallet=${WALLET}`);
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a?.getAttribute('part')).toBe('link');
  });

  it('no wallet, a query → ?q=', () => {
    const a = link(mount({ score: '83', query: 'agent 7' }));
    expect(a?.getAttribute('href')).toBe('https://describe.net/agent.html?q=agent%207');
  });

  it('neither → no <a> at all, and the face is focusable instead', () => {
    const node = mount({ score: '83' });
    expect(root(node).querySelector('a')).toBeNull();
    expect(face(node).getAttribute('tabindex')).toBe('0');
    expect(root(node).querySelector('.open')).toBeNull();
  });

  it('a wallet with a lone surrogate: the score still paints, with no link', () => {
    const node = mount({ score: '83', wallet: 'name \uD83D' });
    expect(value(node).textContent).toBe('83');
    expect(link(node)).toBeNull();
    expect(face(node).getAttribute('tabindex')).toBe('0');
  });

  it('gaining and losing the wallet swaps the trigger without duplicating the face', () => {
    const node = mount({ score: '83' });
    node.setAttribute('wallet', WALLET);
    expect(link(node)?.contains(face(node))).toBe(true);
    expect(face(node).hasAttribute('tabindex')).toBe(false);
    node.removeAttribute('wallet');
    expect(link(node)).toBeNull();
    expect(root(node).querySelectorAll('[part="face"]').length).toBe(1);
    expect(face(node).getAttribute('tabindex')).toBe('0');
  });
});

describe('the card', () => {
  it('shows only the rows that came; an unparseable date is shown raw', () => {
    const node = mount({ score: '83', reviews: '123', 'refreshed-at': 'not-a-date', lang: 'en' });
    const keys = Array.from(root(node).querySelectorAll('dt')).map((dt) => dt.dataset.key);
    expect(keys).toEqual(['refreshedAt', 'reviews']);
    const dd = Array.from(root(node).querySelectorAll('dd')).map((x) => x.textContent);
    expect(dd).toEqual(['not-a-date', '123']);
  });

  it('with no data at all, there is no <dl>', () => {
    expect(root(mount({ score: '83' })).querySelector('dl')).toBeNull();
  });

  it('"POWERED BY DESCRIBE.NET" is the same in es, en and pt', () => {
    const seals = ['es', 'en', 'pt'].map(
      (lang) => root(mount({ lang })).querySelector('.seal')?.textContent,
    );
    expect(seals).toEqual(['POWERED BY DESCRIBE.NET', 'POWERED BY DESCRIBE.NET', 'POWERED BY DESCRIBE.NET']);
  });

  it('the "open" hint appears with a link, and its arrow is hidden from screen readers', () => {
    const open = root(mount({ wallet: WALLET, lang: 'es' })).querySelector('.open') as HTMLElement;
    expect(open.textContent).toBe('Clic para abrir el perfil público ↗');
    expect(open.querySelector('[aria-hidden="true"]')?.textContent).toBe(' ↗');
  });

  it('markup in wallet / policy / query is TEXT: no node is injected', () => {
    const node = mount({ score: PAYLOAD, wallet: PAYLOAD, policy: PAYLOAD, reviews: PAYLOAD, lang: 'en' });
    expect(root(node).querySelector('img')).toBeNull();
    expect(node.querySelector('img')).toBeNull();
    const policy = Array.from(root(node).querySelectorAll('dd'))[0];
    expect(policy.textContent).toBe(PAYLOAD);
    expect(policy.children.length).toBe(0);
    expect(link(node)?.getAttribute('href')).toBe(
      `https://describe.net/agent.html?wallet=${encodeURIComponent(PAYLOAD)}`,
    );
    expect(value(node).textContent).toBe('no data');
  });
});

describe('opening and closing (WCAG 1.4.13, 2.1.1)', () => {
  it('aria-describedby on the trigger points to an id that exists, with role=tooltip', () => {
    for (const node of [mount({ score: '83', wallet: WALLET }), mount({ score: '83' }), mount()]) {
      const id = trigger(node).getAttribute('aria-describedby');
      expect(id).toBeTruthy();
      const target = root(node).getElementById(id as string);
      expect(target).toBe(card(node));
      expect(target?.getAttribute('role')).toBe('tooltip');
    }
  });

  it('keyboard focus on the trigger opens the card; Escape closes it without moving focus', () => {
    const node = mount({ score: '83', wallet: WALLET });
    expect(isOpen(node)).toBe(false);
    trigger(node).focus();
    expect(root(node).activeElement).toBe(trigger(node));
    expect(isOpen(node)).toBe(true);
    escape();
    expect(isOpen(node)).toBe(false);
    expect(root(node).activeElement).toBe(trigger(node));
  });

  it('after Escape, focusing the trigger again reopens the card (keyboard only, no pointer)', () => {
    // A keyboard user who dismissed it must get it back by coming back to it;
    // without the reset in `focusin` it stayed closed until a mouse showed up
    // (refuter's M1).
    const node = mount({ score: '83', wallet: WALLET });
    trigger(node).focus();
    escapeOn(trigger(node));
    expect(isOpen(node)).toBe(false);
    trigger(node).blur();
    expect(root(node).activeElement).toBeNull();
    trigger(node).focus();
    expect(isOpen(node)).toBe(true);
  });

  it('with no score and no link the face takes focus, so "no data" can still be read', () => {
    const node = mount();
    face(node).focus();
    expect(isOpen(node)).toBe(true);
    trigger(node).blur();
    expect(isOpen(node)).toBe(false);
  });

  it('hover opens; moving onto the card keeps it; leaving closes', () => {
    const node = mount({ score: '83' });
    node.dispatchEvent(new PointerEvent('pointerenter'));
    expect(isOpen(node)).toBe(true);
    // Pointer moving from the face to the card stays inside the host: no leave.
    card(node).dispatchEvent(new PointerEvent('pointerover', { bubbles: true, composed: true }));
    expect(isOpen(node)).toBe(true);
    node.dispatchEvent(new PointerEvent('pointerleave'));
    expect(isOpen(node)).toBe(false);
  });

  it('Escape while hovering closes it until the pointer comes back', () => {
    const node = mount({ score: '83' });
    node.dispatchEvent(new PointerEvent('pointerenter'));
    escape();
    expect(isOpen(node)).toBe(false);
    node.dispatchEvent(new PointerEvent('pointerleave'));
    node.dispatchEvent(new PointerEvent('pointerenter'));
    expect(isOpen(node)).toBe(true);
  });

  it('a card open by keyboard focus consumes Escape (so a modal behind it stays); a closed one does not', () => {
    const seen: string[] = [];
    const modal = (e: KeyboardEvent): void => {
      seen.push(e.key);
    };
    document.addEventListener('keydown', modal);
    try {
      const node = mount({ score: '83' });
      trigger(node).focus();
      expect(isOpen(node)).toBe(true);
      escapeOn(trigger(node));
      expect(isOpen(node)).toBe(false);
      expect(seen).toEqual([]);
      escapeOn(trigger(node));
      expect(seen).toEqual(['Escape']);
    } finally {
      document.removeEventListener('keydown', modal);
    }
  });

  it('a card open by hover alone closes on Escape but does NOT swallow it: the focused control gets it', () => {
    // EM: focus in a textarea of a modal, pointer resting on a score. The
    // first Escape used to be eaten by a card the user may not be looking at
    // (refuter's P2-2, 2026-09-30).
    const input = document.createElement('input');
    document.body.append(input);
    const seen: string[] = [];
    input.addEventListener('keydown', (e) => {
      seen.push(e.key);
    });
    const node = mount({ score: '83' });
    input.focus();
    expect(document.activeElement).toBe(input);
    node.dispatchEvent(new PointerEvent('pointerenter'));
    expect(isOpen(node)).toBe(true);
    escapeOn(input);
    expect(seen).toEqual(['Escape']);
    expect(isOpen(node)).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('a removed element stops listening', () => {
    const node = mount({ score: '83' });
    trigger(node).focus();
    expect(isOpen(node)).toBe(true);
    node.remove();
    expect(isOpen(node)).toBe(false);
    const seen: string[] = [];
    const listener = (e: KeyboardEvent): void => {
      seen.push(e.key);
    };
    document.addEventListener('keydown', listener);
    escape();
    document.removeEventListener('keydown', listener);
    expect(seen).toEqual(['Escape']);
  });
});

describe('horizontalShift — the card never leaves the viewport', () => {
  it.each([
    ['fits', 100, 300, 1000, 0],
    ['overflows right', 800, 1100, 1000, -108],
    ['overflows left', -40, 260, 1000, 48],
    ['wider than the viewport: pin the left edge', 20, 420, 360, -12],
  ])('%s', (_label, left, right, viewport, expected) => {
    expect(horizontalShift(left, right, viewport)).toBe(expected);
  });

  it('opening the card applies the shift to the card (the wiring, not just the arithmetic)', () => {
    // happy-dom lays nothing out: documentElement.clientWidth is 0, so without
    // these stubs #place() returns early and a flipped sign would pass
    // (refuter's M3). 360 - 8 - 520 = -168.
    const node = mount({ score: '83' });
    const html = document.documentElement;
    Object.defineProperty(html, 'clientWidth', { configurable: true, get: () => 360 });
    const box = { left: 200, right: 520, top: 0, bottom: 100, width: 320, height: 100, x: 200, y: 0 };
    card(node).getBoundingClientRect = () => ({ ...box, toJSON: () => box }) as DOMRect;
    try {
      node.dispatchEvent(new PointerEvent('pointerenter'));
      expect(isOpen(node)).toBe(true);
      expect(card(node).style.getPropertyValue('--_ds-dx')).toBe('-168px');
    } finally {
      delete (html as unknown as Record<string, unknown>).clientWidth;
    }
    expect(document.documentElement.clientWidth).toBe(0);
  });
});
