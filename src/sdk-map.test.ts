import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  OVERLAY_FILE,
  SOURCE_FILE,
  SPEC_FILE,
  type OpenApiDoc,
  type SdkMap,
  classify,
  loadContract,
  matchOperation,
  parseOverlay,
  parseSource,
  readSchemaFile,
  sha256,
  validateMap,
  watchedSchemas,
} from '../scripts/sdk-map.mjs';
import { DescribeClient } from './client';

/**
 * Which method calls which operation — measured, not declared.
 *
 * `schema/sdk-map.json` says it; this file checks it the only way that cannot
 * lie: every public network method of `DescribeClient` runs against a `fetch`
 * that records `(method, path)`, and each recorded request has to land on an
 * operation of the vendored spec, and on the one the map assigns to that
 * method. Red when:
 *
 *   - an operation the overlay does not hide is neither mapped nor in `fuera`
 *     (describe.net added a route and nobody decided about it);
 *   - a method calls a route that is not in the spec;
 *   - a public `async` method of the client has no entry here;
 *   - the vendored spec or overlay stops matching `schema/SOURCE`.
 *
 * Offline: the recording fetch answers every request itself.
 */

const { spec, actions, map } = loadContract();
const ADDRESS = '0x52e05c8e45a32eee169639f6d2ca40f8887b5a15';

/** How to call each public network method. Keys are method names. */
const INVOKE: Record<string, (client: DescribeClient) => Promise<unknown>> = {
  wallet: (c) => c.wallet(ADDRESS),
  leaderboard: (c) => c.leaderboard(),
  health: (c) => c.health(),
  walletBreakdown: (c) => c.walletBreakdown(ADDRESS),
  agent: (c) => c.agent('base', 1),
};

async function record(call: (client: DescribeClient) => Promise<unknown>) {
  const calls: Array<{ method: string; path: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', path: new URL(String(input)).pathname });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const client = new DescribeClient({ jitterMs: 0, fetchImpl });
  try {
    await call(client);
  } catch (_) {
    // A parser may reject the `{}` body; the request it made is what is measured.
  }
  return calls;
}

describe('schema/ is the vendored describe-net contract', () => {
  it('every file listed in SOURCE matches its sha256', () => {
    const { meta, files } = parseSource(readSchemaFile(SOURCE_FILE).toString('utf8'));
    expect(meta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(files).sort()).toEqual([OVERLAY_FILE, SPEC_FILE].sort());
    for (const [file, sum] of Object.entries(files)) {
      expect(sha256(readSchemaFile(file)), `${file} was edited after vendoring`).toBe(sum);
    }
  });

  it('the overlay classifies every operation of the spec, with no orphan target', () => {
    const classes = classify(spec, actions);
    expect(classes.size).toBe(Object.values(spec.paths ?? {}).flatMap((item) => Object.keys(item)).length);
  });
});

describe('schema/sdk-map.json', () => {
  it('maps or excuses every operation the overlay does not hide, and nothing else', () => {
    expect(validateMap(spec, actions, map)).toEqual([]);
  });

  it('maps exactly the methods this test knows how to call', () => {
    expect([...new Set(Object.values(map.mapeadas))].sort()).toEqual(Object.keys(INVOKE).sort());
  });

  it('every public async method of DescribeClient is in INVOKE', () => {
    const source = readFileSync(fileURLToPath(new URL('./client.ts', import.meta.url)), 'utf8');
    const publicAsync = [...source.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]);
    expect(publicAsync.length).toBeGreaterThan(0);
    expect(publicAsync.sort()).toEqual(Object.keys(INVOKE).sort());
  });

  it.each(Object.entries(INVOKE))('%s() calls only the operation mapped to it', async (name, call) => {
    const calls = await record(call);
    expect(calls.length, `${name}() made no request`).toBeGreaterThan(0);
    for (const { method, path } of calls) {
      const op = matchOperation(spec, method, path);
      expect(op, `${name}() called ${method} ${path}, which is not in the spec`).not.toBeNull();
      expect(map.mapeadas[op!], `${name}() called ${op}`).toBe(name);
    }
  });

  it('badgeUrl() builds a URL that lands on the operation fuera says it does', () => {
    const url = new URL(new DescribeClient({ jitterMs: 0 }).badgeUrl(ADDRESS));
    const op = matchOperation(spec, 'GET', url.pathname);
    expect(op).toBe('GET /badge/{wallet}.svg');
    expect(map.fuera[op!]).toContain('badgeUrl()');
  });

  it('/names/resolve and /names/reverse wait for the TS pair of DUP-01', () => {
    expect(map.fuera['GET /names/resolve']).toBe('pendiente: par TS de DUP-01');
    expect(map.fuera['GET /names/reverse']).toBe('pendiente: par TS de DUP-01');
  });
});

describe('the watched schemas are derived from the map', () => {
  it('cover every schema the old hand-written WATCHED list carried', () => {
    const watched = watchedSchemas(spec, map);
    for (const name of ['WalletChains', 'WalletChain', 'WalletScore', 'AgentScore', 'Rating', 'LeaderboardRow', 'Health', 'Caveat']) {
      expect(watched).toContain(name);
    }
    for (const name of watched) expect(spec.components?.schemas?.[name], name).toBeDefined();
  });
});

describe('the gate is discriminant — MOUNTS THE BAD STATE', () => {
  const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

  it('goes RED on an invented operation nobody mapped', () => {
    const mutated = clone(spec) as OpenApiDoc & { paths: Record<string, Record<string, unknown>> };
    mutated.paths['/inventada'] = { get: { responses: {} } };
    const withTarget = [
      ...actions,
      ...parseOverlay(
        'overlay: 1.0.0\nactions:\n  - target: "$.paths[\'/inventada\'].get"\n    update: {x-fern-sdk-group-name: index, x-fern-sdk-method-name: inventada}\n',
      ),
    ];
    expect(validateMap(mutated, withTarget, map)).toContain(
      'GET /inventada: public operation neither in mapeadas nor in fuera',
    );
    expect(() => classify(mutated, actions)).toThrow(/unclassified operation\(s\) GET \/inventada/);
  });

  it('goes RED on a route outside the spec', () => {
    expect(matchOperation(spec, 'GET', '/healthz')).toBeNull();
    expect(matchOperation(spec, 'POST', '/health')).toBeNull();
  });

  it('goes RED when a hidden operation is mapped, or a public one is dropped', () => {
    const mutated = clone(map) as SdkMap;
    mutated.mapeadas['GET /me'] = 'me';
    delete mutated.fuera['GET /names/resolve'];
    const problems = validateMap(spec, actions, mutated);
    expect(problems).toContain('mapeadas: GET /me is hidden by the overlay and must not be mapped');
    expect(problems).toContain('GET /names/resolve: public operation neither in mapeadas nor in fuera');
  });

  it('goes RED on an orphan overlay target and on a line the parser does not know', () => {
    const orphan = parseOverlay(
      'overlay: 1.0.0\nactions:\n  - target: "$.paths[\'/healthz\'].get"\n    update: {x-fern-ignore: true}\n',
    );
    expect(() => classify(spec, [...actions, ...orphan])).toThrow(/orphan target/);
    expect(() => parseOverlay('overlay: 1.0.0\nactions:\n  - target: "$.paths[\'/x\'].get"\n    remove: true\n')).toThrow();
  });
});
