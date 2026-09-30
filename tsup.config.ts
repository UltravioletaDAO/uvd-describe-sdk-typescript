import { defineConfig } from 'tsup';

/**
 * Same build shape as `uvd-x402-sdk-typescript` (cjs + esm + dts, no splitting).
 *
 * Four entries and not one (three until 0.5.0), and that split is the whole dependency argument of
 * this package: `index` never imports `uvd-x402-sdk`, so a consumer that only
 * reads the free routes installs nothing beyond this package.
 *
 *   * `x402/index` names the payment SDK's types with `import type` only, so it
 *     also compiles to zero runtime imports;
 *   * `partner/index` is the one entry that genuinely NEEDS the payment SDK at
 *     runtime — it calls its ERC-8128 signer — and that is why the partner rail
 *     lives behind its own subpath instead of inside the client. Added
 *     2026-08-30.
 *   * `widget/index` is `<describe-score>` (added 2026-09-30, 0.5.0). It
 *     touches the DOM, which is exactly why it is not in `index`: importing
 *     the root in Node must never meet an `HTMLElement`. It bundles the two
 *     modules it reuses (`format`, `config`) and imports nothing at runtime.
 *
 * All of them mark `uvd-x402-sdk` external so it is never bundled into ours:
 * vendorizing a dependency is exactly what the house forbids (D9 §"día 0":
 * manifiesto declarado, NUNCA vendorizado).
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'x402/index': 'src/x402/index.ts',
    'partner/index': 'src/partner/index.ts',
    'widget/index': 'src/widget/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  // The wildcard is load-bearing, not defensive: esbuild matches `external`
  // entries exactly, so `uvd-x402-sdk` alone does NOT cover the
  // `uvd-x402-sdk/erc8128` subpath the partner rail imports — it would be
  // BUNDLED, dragging ethers and three @noble packages into our artifact.
  external: ['uvd-x402-sdk', 'uvd-x402-sdk/*'],
});
