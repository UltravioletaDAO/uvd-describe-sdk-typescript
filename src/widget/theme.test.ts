import { describe, expect, it } from 'vitest';

import { DESCRIBE_SCORE_CSS, DESCRIBE_SCORE_CSS_VARS, DESCRIBE_SCORE_TOKENS } from './theme';

/** WCAG 2.1 relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;

describe('contrast of the default tokens (AA, both themes)', () => {
  it('MOUNTS THE BAD STATE: the check can go red', () => {
    // #777777 on white is the textbook near-miss (4.48:1). A contrast helper
    // that passed it would pass anything.
    expect(contrast('#777777', '#ffffff')).toBeLessThan(AA);
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  for (const theme of ['light', 'dark'] as const) {
    const t = DESCRIBE_SCORE_TOKENS[theme];
    it.each([
      ['text', t.text],
      ['textSecondary', t.textSecondary],
      ['accent', t.accent],
    ])(`${theme}: %s on the card background is ≥ 4.5:1`, (_name, fg) => {
      expect(contrast(fg, t.bg)).toBeGreaterThanOrEqual(AA);
    });
  }
});

describe('the stylesheet', () => {
  it('loads nothing from the network: no url(), no @import', () => {
    expect(DESCRIBE_SCORE_CSS).not.toMatch(/url\s*\(/i);
    expect(DESCRIBE_SCORE_CSS).not.toMatch(/@import/i);
  });

  it('every public custom property is actually read, in both themes', () => {
    for (const name of Object.values(DESCRIBE_SCORE_CSS_VARS)) {
      expect(DESCRIBE_SCORE_CSS).toContain(`var(${name},`);
    }
    for (const theme of ['light', 'dark'] as const) {
      expect(DESCRIBE_SCORE_CSS).toContain(`var(--describe-score-bg, ${DESCRIBE_SCORE_TOKENS[theme].bg})`);
    }
  });

  it('the card takes its own font, never the face\'s (measured: a monospace score made monospace prose)', () => {
    const cardRule = DESCRIBE_SCORE_CSS.slice(DESCRIBE_SCORE_CSS.indexOf('.card {'));
    const block = cardRule.slice(0, cardRule.indexOf('}'));
    expect(block).toContain('all: initial;');
    expect(block).toContain(`font-family: var(--describe-score-font, ${DESCRIBE_SCORE_TOKENS.font});`);
    expect(block).not.toContain('font-family: inherit');
  });

  it('the viewport shift is NOT transitioned (a transition makes the clamp measure a stale position)', () => {
    const cardRule = DESCRIBE_SCORE_CSS.slice(DESCRIBE_SCORE_CSS.indexOf('.card {'));
    const block = cardRule.slice(0, cardRule.indexOf('}'));
    expect(block).toContain('translate: var(--_ds-dx, 0px) 0;');
    const transition = /transition:([^;]*);/.exec(block)?.[1] ?? '';
    expect(transition).not.toMatch(/translate|all/);
    const transforms = DESCRIBE_SCORE_CSS.match(/transform:[^;]*;/g) ?? [];
    expect(transforms.length).toBeGreaterThan(0);
    for (const t of transforms) expect(t).not.toContain('--_ds-dx');
  });

  it('honours reduced motion and both placements', () => {
    expect(DESCRIBE_SCORE_CSS).toContain('prefers-reduced-motion: reduce');
    expect(DESCRIBE_SCORE_CSS).toContain(':host([placement="bottom-end"])');
    expect(DESCRIBE_SCORE_CSS).toContain(':host([theme="dark"])');
    expect(DESCRIBE_SCORE_CSS).toContain(':host(:not([theme="light"]))');
  });
});
