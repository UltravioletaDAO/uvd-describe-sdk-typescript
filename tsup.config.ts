import { defineConfig } from 'tsup';

/**
 * Same build shape as `uvd-x402-sdk-typescript` (cjs + esm + dts, no splitting).
 *
 * Two entries and not one, and that split is the whole dependency argument of
 * this package: `index` never imports `uvd-x402-sdk`, so a consumer that only
 * reads the free routes installs nothing beyond this package. `x402/index` is
 * the only file that touches the payment SDK, it lives behind the
 * `uvd-describe-sdk/x402` subpath, and it is marked external so the payment
 * SDK is never bundled into ours — vendorizing a dependency is exactly what
 * the house forbids (D9 §"día 0": manifiesto declarado, NUNCA vendorizado).
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'x402/index': 'src/x402/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: ['uvd-x402-sdk'],
});
