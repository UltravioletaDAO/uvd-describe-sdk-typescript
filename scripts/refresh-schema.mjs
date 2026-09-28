#!/usr/bin/env node
/**
 * The NETWORKED half of the type gate.
 *
 * `npm run schema:check` re-fetches the live OpenAPI and compares it against
 * the vendored `schema/openapi.json`. It answers a question the offline test
 * cannot: **did the server move?**
 *
 * Deliberately not part of `npm test`. Tests do not touch the network — a
 * suite that fails because someone's wifi dropped teaches people to ignore red.
 * This is a separate, explicit command, meant for the moment before a release.
 * The GET of the live spec is the only request it makes.
 *
 *   npm run schema:check     compare, exit 1 on a difference that matters
 *   npm run schema:refresh   re-vendor schema/ from a describe-net checkout
 *                            (then run the tests)
 *
 * It compares STRUCTURE, not bytes: the schema embeds prose descriptions in
 * Spanish that get reworded constantly, and a diff that goes red on a typo fix
 * is a diff nobody reads. What it watches is what this SDK depends on — which
 * operations exist and which are metered, EXCEPT the ones `schema/sdk.overlay.yaml`
 * hides (web app and agent protocols, `x-fern-ignore: true`), and the required
 * fields of the schemas the mapped operations answer with.
 *
 * ⚠️ Rewritten for FG-DN-03. Until then it diffed against a hand-refreshed
 * `schema/openapi.snapshot.json`, watched every path including the web app's,
 * and read the schemas to watch from a list typed by hand. On 2026-09-28 it
 * exited 1 with 11 changes: 9 web app operations no SDK wraps and the two
 * `/names/*` routes. The first nine are now ignored because the overlay says
 * so; the two `/names/*` are in the vendored spec and in `fuera` of
 * `schema/sdk-map.json`.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  OVERLAY_FILE,
  SCHEMA_DIR,
  SOURCE_FILE,
  SPEC_FILE,
  hiddenOperations,
  loadContract,
  operations,
  parseOverlay,
  sha256,
  watchedSchemas,
} from './sdk-map.mjs';

const URL_ = process.env.DESCRIBE_OPENAPI_URL ?? 'https://api.describe.net/openapi.json';
const CHECK = process.argv.includes('--check');

function shape(doc, contract) {
  const paths = {};
  for (const key of operations(doc)) {
    if (contract.hidden.has(key)) continue;
    const [method, path] = key.split(' ');
    const op = doc.paths[path][method.toLowerCase()];
    // LENGTH, never truthiness: free routes carry `security: []` (an explicit
    // "no scheme applies") and `Boolean([])` is `true` in JavaScript, which
    // marks all 13 free routes as paid. See the note in types.schema.test.ts.
    paths[key] = (op.security ?? []).length > 0;
  }
  const schemas = {};
  for (const name of contract.watched) {
    const entry = doc.components?.schemas?.[name];
    schemas[name] = entry ? [...(entry.required ?? [])].sort() : null;
  }
  return {
    version: doc.info?.version,
    paths,
    schemas,
    x402: doc.components?.securitySchemes?.x402
      ? {
          type: doc.components.securitySchemes.x402.type,
          in: doc.components.securitySchemes.x402.in,
          name: doc.components.securitySchemes.x402.name,
        }
      : null,
  };
}

function diff(before, after, contract) {
  const out = [];
  if (before.version !== after.version) out.push(`info.version: ${before.version} -> ${after.version}`);

  for (const key of new Set([...Object.keys(before.paths), ...Object.keys(after.paths)])) {
    const a = before.paths[key];
    const b = after.paths[key];
    if (a === undefined) out.push(`path ADDED: ${key} (metered=${b})`);
    else if (b === undefined) out.push(`path REMOVED: ${key}`);
    else if (a !== b) out.push(`path CHANGED PRICE: ${key} metered ${a} -> ${b}`);
  }

  for (const name of contract.watched) {
    const a = before.schemas[name];
    const b = after.schemas[name];
    if (a === null && b === null) continue;
    if (a === null) out.push(`schema ADDED: ${name}`);
    else if (b === null) out.push(`schema REMOVED: ${name} <- this SDK types it`);
    else {
      for (const f of b.filter((f) => !a.includes(f))) out.push(`${name}: required field ADDED "${f}"`);
      for (const f of a.filter((f) => !b.includes(f))) out.push(`${name}: required field REMOVED "${f}"`);
    }
  }

  if (JSON.stringify(before.x402) !== JSON.stringify(after.x402)) {
    out.push(`securitySchemes.x402 changed: ${JSON.stringify(before.x402)} -> ${JSON.stringify(after.x402)}`);
  }
  return out;
}

/**
 * `contract.watched` — the schemas this SDK actually types — is DERIVED, never
 * typed by hand: every schema reachable from the 2xx responses of the operations `schema/sdk-map.json`
 * maps to a method (`watchedSchemas` in `sdk-map.mjs`).
 *
 * ⚠️ It was a hand-written list of eight. `Rating` was added to it on
 * 2026-09-15 after the fact: typed since 0.1.0 and never listed, so when
 * describe.net made `author_class` a REQUIRED field of it (2026-09-14) the
 * refresh reported only `WalletChains` — the other new field crossed this gate
 * in silence. A list someone has to remember is the bug; the derived set
 * cannot forget a schema the SDK parses.
 */
async function check() {
  const { spec, actions, map } = loadContract();
  const contract = { hidden: hiddenOperations(spec, actions), watched: watchedSchemas(spec, map) };

  const response = await fetch(URL_, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    console.error(`FAIL: GET ${URL_} -> HTTP ${response.status}`);
    process.exitCode = 2;
    return;
  }
  const live = await response.json();
  const changes = diff(shape(spec, contract), shape(live, contract), contract);
  const ignored = operations(live).filter((op) => contract.hidden.has(op)).length;

  if (changes.length === 0) {
    console.log(
      `OK: the live schema still matches schema/${SPEC_FILE} ` +
        `(${operations(live).length} operations, ${ignored} hidden by the overlay, ` +
        `${contract.watched.length} watched schemas, v${live.info.version}).`,
    );
    return;
  }
  console.log(`${changes.length} structural change(s) between schema/${SPEC_FILE} and ${URL_}:`);
  for (const c of changes) console.log(`  - ${c}`);
  console.error(
    '\nFAIL. Read each change, update src/types.ts where it matters, then re-vendor with `npm run schema:refresh`.',
  );
  process.exitCode = 1;
}

/**
 * Re-vendor `schema/openapi.json` and `schema/sdk.overlay.yaml` from a
 * describe-net checkout, byte for byte, and rewrite `schema/SOURCE`. No network:
 * `git show` of a ref (`DESCRIBE_NET_REF`, default `origin/main`) in
 * `DESCRIBE_NET_DIR` (default `../describe-net`). Refuses to write an overlay
 * that does not parse or does not classify every operation of the spec.
 */
function vendor() {
  const dir = process.env.DESCRIBE_NET_DIR ?? fileURLToPath(new URL('../../describe-net', import.meta.url));
  const ref = process.env.DESCRIBE_NET_REF ?? 'origin/main';
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { maxBuffer: 64 * 1024 * 1024 });
  const commit = git('rev-parse', `${ref}^{commit}`).toString('utf8').trim();
  const spec = git('show', `${commit}:openapi/openapi.json`);
  const overlay = git('show', `${commit}:openapi/sdk.overlay.yaml`);
  hiddenOperations(JSON.parse(spec.toString('utf8')), parseOverlay(overlay.toString('utf8')));

  writeFileSync(`${SCHEMA_DIR}${SPEC_FILE}`, spec);
  writeFileSync(`${SCHEMA_DIR}${OVERLAY_FILE}`, overlay);
  writeFileSync(
    `${SCHEMA_DIR}${SOURCE_FILE}`,
    [
      '# Vendored byte for byte. Regenerate with `npm run schema:refresh` (needs a',
      '# describe-net checkout); `src/sdk-map.test.ts` fails if a file stops matching.',
      'repo: UltravioletaDAO/describe-net',
      `commit: ${commit}`,
      `${sha256(spec)}  ${SPEC_FILE}`,
      `${sha256(overlay)}  ${OVERLAY_FILE}`,
      '',
    ].join('\n'),
    'utf8',
  );
  console.log(`Vendored schema/ from describe-net@${commit}. Now run \`npm test\` — sdk-map.test.ts and types.schema.test.ts tell you what moved.`);
}

/**
 * ⚠️ `process.exitCode`, never `process.exit()`. Measured on this machine
 * (Windows, Node v23.11.0, 2026-08-30): calling `process.exit(0)` right after a
 * global `fetch` aborts the process with
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
 *   file c:\ws\deps\uv\src\win\async.c, line 76
 *
 * and reports **exit 127** — after having printed `OK`. A CI that trusts the
 * status code would call a passing check a failure, forever, and the person
 * who finally investigates finds a green log with a red exit. Setting
 * `exitCode` and letting Node drain undici's sockets gives the same status with
 * no crash. Reproduce the bad version with `process.exit(0)` on the OK branch.
 */
if (CHECK) await check();
else vendor();
