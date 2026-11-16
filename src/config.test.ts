import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_EXPIRY_MARGIN_SECONDS,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRY_AFTER_SECONDS,
  SDK_NAME,
  SDK_VERSION,
  TREASURY_EVM,
  userAgent,
} from './config';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { name: string; version: string };

describe('the User-Agent cannot lie about the version', () => {
  it('SDK_VERSION equals package.json', () => {
    // MeshRelay gets this guarantee at runtime by reading its own manifest,
    // "a User-Agent that lies about the version is worse than none"
    // (`describenet.js:39`). A bundled library cannot afford that read, so the
    // constant is typed and this test is what keeps it honest. Bumping the
    // version without the constant goes red here instead of quietly
    // misattributing every request in the provider's access log.
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it('MOUNTS THE BAD STATE: a stale constant is what this catches', () => {
    // If the two could drift, this comparison would pass anyway. It cannot:
    // one side is read off disk at test time.
    expect(SDK_VERSION).not.toBe('');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(`${SDK_NAME}/${SDK_VERSION}`).not.toBe(`${SDK_NAME}/0.0.0`);
  });

  it('names the product when given one, and stays clean when not', () => {
    expect(userAgent()).toBe(`${SDK_NAME}/${SDK_VERSION}`);
    expect(userAgent('meshrelay')).toBe(`${SDK_NAME}/${SDK_VERSION} (+meshrelay)`);
    expect(userAgent('   ')).toBe(`${SDK_NAME}/${SDK_VERSION}`);
  });
});

describe('the defaults are the measured ones', () => {
  it('timeout is 30 s — above the 15,2 s cold start, below the 29 s gateway ceiling', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    // The two failure modes the number sits between. An 8 s timeout already
    // broke a real integration; waiting past the gateway buys nothing.
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(15_200);
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(29_000);
    // And deliberately NOT the facilitator's 45 s, so two clocks never race.
    expect(DEFAULT_TIMEOUT_MS).not.toBe(45_000);
  });

  it('the pinned treasury is a checksummed EVM address', () => {
    expect(TREASURY_EVM).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Read live from the 402 challenge on 2026-08-30. If describe.net rotates
    // it, this SDK stops paying until it is republished — the safe direction.
    expect(TREASURY_EVM).toBe('0xe4dc963c56979E0260fc146b87eE24F18220e545');
  });

  it("the two post-payment clocks are describe.net's numbers, typed as literals here", () => {
    // Added 2026-11-16 (c0der's round 1, P2-2). The margin is the guard on
    // the one door to a second payment (`forgetAuthorization`), and its only
    // test computed the edge from this very constant, so 15 -> 0 passed the
    // whole suite (mutant MR5). A literal is the only check that can go red.
    // Source: `MARGEN_FIRMA_MS = 15000`, describe-net `site/dn-pay.js:714`.
    expect(AUTHORIZATION_EXPIRY_MARGIN_SECONDS).toBe(15);
    // Source: `RETRY_AFTER_CEILING_SECONDS = 30`, describe-net
    // `describenet/paywall.py:179` (already pinned by behaviour: the
    // `retryAfterSeconds` table in `client.test.ts` killed MR15, 30 -> 300).
    expect(MAX_RETRY_AFTER_SECONDS).toBe(30);
  });
});

describe('the package is the one the docs describe', () => {
  it('is named uvd-describe-sdk', () => {
    expect(pkg.name).toBe('uvd-describe-sdk');
  });
});
