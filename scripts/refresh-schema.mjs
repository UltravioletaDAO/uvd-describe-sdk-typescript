#!/usr/bin/env node
/**
 * The NETWORKED half of the type gate.
 *
 * `npm run schema:check` re-fetches the live OpenAPI and compares it against
 * `schema/openapi.snapshot.json`. It answers a question the offline test
 * cannot: **did the server move?**
 *
 * Deliberately not part of `npm test`. Tests do not touch the network — a
 * suite that fails because someone's wifi dropped teaches people to ignore red.
 * This is a separate, explicit command, meant for CI on a schedule and for the
 * moment before a release.
 *
 *   npm run schema:check     compare, exit 1 on a difference that matters
 *   npm run schema:refresh   write the new snapshot (then run the tests)
 *
 * It compares STRUCTURE, not bytes: the schema embeds prose descriptions in
 * Spanish that get reworded constantly, and a diff that goes red on a typo fix
 * is a diff nobody reads. What it watches is what this SDK depends on — which
 * paths exist, which are metered, and the required fields of the schemas we
 * type.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL_ = process.env.DESCRIBE_OPENAPI_URL ?? 'https://api.describe.net/openapi.json';
const SNAPSHOT = fileURLToPath(new URL('../schema/openapi.snapshot.json', import.meta.url));
const CHECK = process.argv.includes('--check');

/** The schemas and paths this SDK actually types. Nothing else is watched. */
const WATCHED_SCHEMAS = [
  'WalletChains',
  'WalletChain',
  'WalletScore',
  'AgentScore',
  'LeaderboardRow',
  'Health',
  'Caveat',
];

function shape(doc) {
  const paths = {};
  for (const [path, ops] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      // LENGTH, never truthiness: free routes carry `security: []` (an explicit
      // "no scheme applies") and `Boolean([])` is `true` in JavaScript, which
      // marks all 13 free routes as paid. See the note in types.schema.test.ts.
      paths[`${method.toUpperCase()} ${path}`] = (op.security ?? []).length > 0;
    }
  }
  const schemas = {};
  for (const name of WATCHED_SCHEMAS) {
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

function diff(before, after) {
  const out = [];
  if (before.version !== after.version) out.push(`info.version: ${before.version} -> ${after.version}`);

  for (const key of new Set([...Object.keys(before.paths), ...Object.keys(after.paths)])) {
    const a = before.paths[key];
    const b = after.paths[key];
    if (a === undefined) out.push(`path ADDED: ${key} (metered=${b})`);
    else if (b === undefined) out.push(`path REMOVED: ${key}`);
    else if (a !== b) out.push(`path CHANGED PRICE: ${key} metered ${a} -> ${b}`);
  }

  for (const name of WATCHED_SCHEMAS) {
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
const response = await fetch(URL_, { headers: { Accept: 'application/json' } });
if (!response.ok) {
  console.error(`FAIL: GET ${URL_} -> HTTP ${response.status}`);
  process.exitCode = 2;
} else {
  const live = await response.json();
  const pinned = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  const changes = diff(shape(pinned), shape(live));

  if (changes.length === 0) {
    console.log(
      `OK: the live schema still matches the snapshot (${Object.keys(live.paths).length} paths, v${live.info.version}).`,
    );
  } else {
    console.log(`${changes.length} structural change(s) between the snapshot and ${URL_}:`);
    for (const c of changes) console.log(`  - ${c}`);

    if (CHECK) {
      console.error(
        '\nFAIL. Read each change, update src/types.ts where it matters, then run `npm run schema:refresh`.',
      );
      process.exitCode = 1;
    } else {
      writeFileSync(SNAPSHOT, JSON.stringify(live, null, 1) + '\n', 'utf8');
      console.log(
        '\nSnapshot rewritten. Now run `npm test` — types.schema.test.ts is what tells you if our types drifted.',
      );
    }
  }
}
