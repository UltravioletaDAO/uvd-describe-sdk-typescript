/**
 * The contract between this SDK and describe.net's OpenAPI, as data.
 *
 * Three files in `schema/`, all read here and nowhere else:
 *
 *   openapi.json      the spec, vendored byte for byte from describe-net
 *   sdk.overlay.yaml  its Overlay 1.0.0: which operations are web app or agent
 *                     protocol (`x-fern-ignore: true`) and the SDK name of the rest
 *   sdk-map.json      which public method of `DescribeClient` calls which
 *                     operation (`mapeadas`), and why every other public
 *                     operation has none (`fuera`)
 *
 * `SOURCE` pins the first two by sha256, so a hand edit to the vendored copy is
 * a red test, not a quiet fork of the contract.
 *
 * Plain `.mjs` with no dependency, because two very different callers share it:
 * `src/sdk-map.test.ts` (offline) and `scripts/refresh-schema.mjs` (the one
 * networked check). The overlay is YAML and this package installs no YAML
 * parser, so `parseOverlay` reads the one shape the overlay is written in and
 * THROWS on any line it does not recognise — a parser that skipped what it did
 * not understand would hide an operation, which is the failure this gate exists
 * to catch.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCHEMA_DIR = fileURLToPath(new URL('../schema/', import.meta.url));
export const SPEC_FILE = 'openapi.json';
export const OVERLAY_FILE = 'sdk.overlay.yaml';
export const MAP_FILE = 'sdk-map.json';
export const SOURCE_FILE = 'SOURCE';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];
const OVERLAY_KEYS = ['x-fern-ignore', 'x-fern-sdk-group-name', 'x-fern-sdk-method-name'];

export function readSchemaFile(name) {
  return readFileSync(`${SCHEMA_DIR}${name}`);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `SOURCE`: `key: value` header lines, then `sha256sum`-style `<hex>  <file>` lines. */
export function parseSource(text) {
  const meta = {};
  const files = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sum = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (sum) {
      files[sum[2]] = sum[1];
      continue;
    }
    const kv = /^([a-z_]+): (.+)$/.exec(line);
    if (kv) {
      meta[kv[1]] = kv[2];
      continue;
    }
    throw new Error(`SOURCE: unrecognised line ${JSON.stringify(raw)}`);
  }
  return { meta, files };
}

/** Every operation of a spec as `"GET /path"`, in spec order. */
export function operations(spec) {
  const out = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method)) out.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return out;
}

/**
 * The overlay's actions, strictly. Accepts exactly
 *
 *   - target: "$.paths['<path>'].<method>"   [# comment]
 *     update: {key: value, key: value}       [# comment]
 *
 * after `actions:`, and throws on anything else there.
 */
export function parseOverlay(text) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => /^actions:\s*$/.test(l));
  if (!/^overlay: 1\.0\.0\s*$/m.test(text) || start < 0) {
    throw new Error('overlay: not an Overlay 1.0.0 document with `actions:`');
  }
  const actions = [];
  let pending = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue;
    const target = /^\s*- target: "([^"]+)"\s*(#.*)?$/.exec(line);
    if (target) {
      if (pending) throw new Error(`overlay line ${i + 1}: target ${pending} has no update`);
      pending = target[1];
      continue;
    }
    const update = /^\s*update: \{([^}]*)\}\s*(#.*)?$/.exec(line);
    if (update && pending) {
      const op = targetToOperation(pending);
      const values = {};
      for (const pair of update[1].split(',')) {
        const kv = /^\s*([a-z-]+): ([A-Za-z0-9_-]+)\s*$/.exec(pair);
        if (!kv || !OVERLAY_KEYS.includes(kv[1])) {
          throw new Error(`overlay line ${i + 1}: unsupported update entry ${JSON.stringify(pair)}`);
        }
        values[kv[1]] = kv[2] === 'true' ? true : kv[2];
      }
      actions.push({ target: pending, operation: op, update: values });
      pending = null;
      continue;
    }
    throw new Error(`overlay line ${i + 1}: unrecognised ${JSON.stringify(line)}`);
  }
  if (pending) throw new Error(`overlay: target ${pending} has no update`);
  return actions;
}

function targetToOperation(target) {
  const m = /^\$\.paths\['([^']+)'\]\.([a-z]+)$/.exec(target);
  if (!m || !HTTP_METHODS.includes(m[2])) throw new Error(`overlay: unsupported target ${target}`);
  return `${m[2].toUpperCase()} ${m[1]}`;
}

/**
 * Applies the overlay's classification to the spec. Throws on a target that
 * matches no operation (an overlay applier would skip it in silence), on an
 * operation classified twice, and on one left unclassified.
 *
 * @returns {Map<string, {ignore: boolean, group?: string, method?: string}>}
 */
export function classify(spec, actions) {
  const ops = operations(spec);
  const out = new Map();
  for (const { target, operation, update } of actions) {
    if (!ops.includes(operation)) throw new Error(`overlay: orphan target ${target} (no such operation in the spec)`);
    if (out.has(operation)) throw new Error(`overlay: ${operation} classified twice`);
    const ignore = update['x-fern-ignore'] === true;
    const group = update['x-fern-sdk-group-name'];
    const method = update['x-fern-sdk-method-name'];
    if (!ignore && (!group || !method)) throw new Error(`overlay: ${operation} is neither ignored nor named`);
    out.set(operation, ignore ? { ignore } : { ignore, group, method });
  }
  const missing = ops.filter((op) => !out.has(op));
  if (missing.length) throw new Error(`overlay: unclassified operation(s) ${missing.join(', ')}`);
  return out;
}

/** The operations the overlay hides from an SDK. */
export function hiddenOperations(spec, actions) {
  return new Set([...classify(spec, actions)].filter(([, c]) => c.ignore).map(([op]) => op));
}

/**
 * Everything wrong with `map` against the spec + overlay, as sentences. Empty
 * means every public operation is either called by a method or listed in
 * `fuera` with its reason, and nothing else is in the map.
 */
export function validateMap(spec, actions, map) {
  const classes = classify(spec, actions);
  const problems = [];
  const mapped = map.mapeadas ?? {};
  const out = map.fuera ?? {};
  for (const [op, c] of classes) {
    if (c.ignore) continue;
    if (!(op in mapped) && !(op in out)) problems.push(`${op}: public operation neither in mapeadas nor in fuera`);
  }
  for (const [section, entries] of [
    ['mapeadas', mapped],
    ['fuera', out],
  ]) {
    for (const [op, value] of Object.entries(entries)) {
      const c = classes.get(op);
      if (!c) problems.push(`${section}: ${op} is not an operation of the spec`);
      else if (c.ignore) problems.push(`${section}: ${op} is hidden by the overlay and must not be mapped`);
      if (typeof value !== 'string' || !value.trim()) problems.push(`${section}: ${op} has an empty value`);
    }
  }
  for (const op of Object.keys(mapped)) {
    if (op in out) problems.push(`${op}: in both mapeadas and fuera`);
    const c = classes.get(op);
    if (c && !c.ignore && c.method !== mapped[op]) {
      problems.push(`mapeadas: ${op} -> ${mapped[op]}, but the overlay names it ${c.method}`);
    }
  }
  return problems;
}

/** The spec operation a concrete request hits, or `null` if it is outside the spec. */
export function matchOperation(spec, method, pathname) {
  let best = null;
  for (const op of operations(spec)) {
    const [m, template] = op.split(' ');
    if (m !== method.toUpperCase()) continue;
    const params = (template.match(/\{[^}]+\}/g) ?? []).length;
    const pattern = template
      .split(/\{[^}]+\}/)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]+');
    if (new RegExp(`^${pattern}$`).test(pathname) && (best === null || params < best.params)) {
      best = { op, params };
    }
  }
  return best?.op ?? null;
}

function refsIn(node, acc) {
  if (node && typeof node === 'object') {
    if (typeof node.$ref === 'string') acc.add(node.$ref.split('/').pop());
    for (const value of Object.values(node)) refsIn(value, acc);
  }
  return acc;
}

/**
 * The component schemas this SDK parses: every schema reachable from the 2xx
 * responses of the `mapeadas` operations, following `$ref`s transitively.
 * Sorted.
 */
export function watchedSchemas(spec, map) {
  const seen = new Set();
  const queue = [];
  for (const op of Object.keys(map.mapeadas ?? {})) {
    const [method, path] = op.split(' ');
    const responses = spec.paths?.[path]?.[method.toLowerCase()]?.responses ?? {};
    for (const [code, response] of Object.entries(responses)) {
      if (code.startsWith('2')) queue.push(...refsIn(response.content ?? {}, new Set()));
    }
  }
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...refsIn(spec.components?.schemas?.[name] ?? {}, new Set()));
  }
  return [...seen].sort();
}

/** The three vendored files, parsed. */
export function loadContract() {
  return {
    spec: JSON.parse(readSchemaFile(SPEC_FILE).toString('utf8')),
    actions: parseOverlay(readSchemaFile(OVERLAY_FILE).toString('utf8')),
    map: JSON.parse(readSchemaFile(MAP_FILE).toString('utf8')),
  };
}
