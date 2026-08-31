import { describe, expect, it } from 'vitest';

import { jitterDelayMs, sleep } from './jitter';

/**
 * Aporte ① — KarmaKadabra's jitter, tested where it is pure.
 *
 * The draw is a function of `(maxMs, random)`, so the interesting half needs no
 * clock at all: a stubbed `random` pins the boundaries exactly, and only the
 * wiring test in `client.test.ts` pays for a real timer.
 */

describe('the draw is uniform over [0, maxMs) and never leaves it', () => {
  it('pins both ends with a stubbed random', () => {
    expect(jitterDelayMs(400, () => 0)).toBe(0);
    expect(jitterDelayMs(400, () => 0.5)).toBe(200);
    // `Math.random()` is documented as [0, 1), so the top of the range is
    // approached and never reached: the delay is always UNDER maxMs.
    expect(jitterDelayMs(400, () => 0.999_999)).toBeLessThan(400);
    expect(jitterDelayMs(400, () => 0.999_999)).toBeGreaterThan(399);
  });

  it('a thousand real draws all land inside the window, and are not all equal', () => {
    const draws = Array.from({ length: 1000 }, () => jitterDelayMs(400));
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(400);
    }
    // A constant would satisfy every bound above and disperse nothing, which is
    // the one failure a range check cannot see.
    expect(new Set(draws).size).toBeGreaterThan(900);
  });
});

describe('a garbage bound sleeps zero rather than throwing', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('%s gives 0', (_label, value) => {
    expect(jitterDelayMs(value)).toBe(0);
  });

  it('a random source that misbehaves is clamped, not trusted', () => {
    // Not defensive decoration: `random` is injectable, so somebody will
    // eventually inject a seeded generator with its own idea of the range. A
    // negative delay is a `setTimeout` that fires immediately (harmless) and a
    // >1 draw would sleep LONGER than the caller's configured ceiling, which is
    // the one direction that is not harmless.
    expect(jitterDelayMs(400, () => -0.5)).toBe(0);
    expect(jitterDelayMs(400, () => 2)).toBe(400);
    expect(jitterDelayMs(400, () => Number.NaN)).toBe(0);
  });
});

describe('sleep', () => {
  it('waits at least as long as it was asked to', async () => {
    const started = Date.now();
    await sleep(25);
    // `setTimeout` may fire late and never early. A 5 ms allowance for timer
    // coarseness on Windows, where the clock granularity is ~15 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});
