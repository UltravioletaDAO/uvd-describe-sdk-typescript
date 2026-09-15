import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AUTHOR_CLASSES, CAVEAT_CODES } from './caveats';
import {
  parseAgentReputation,
  parseHealth,
  parseLeaderboard,
  parseWalletBreakdown,
  parseWalletReputation,
} from './parse';

/**
 * The third way: hand-written types PLUS a test that ties them to the schema.
 *
 * This is the OFFLINE half, and it runs in the normal loop. It reads
 * `schema/openapi.snapshot.json` — a pinned copy of the live schema fetched
 * 2026-08-30 (re-fetched for 0.3.0 and again on 2026-09-15 for 0.4.0) — and
 * asserts that every REQUIRED field of the schemas this SDK wraps has a home in
 * our parsed shape. It answers "did we drift?".
 *
 * The other half is `npm run schema:check`, which re-fetches the live schema
 * and diffs it against the snapshot. It answers "did THEY move?". Two failures,
 * two gates: a generator would collapse both into "the build broke" and tell
 * you neither.
 *
 * Why required-only: the schema marks a field required when the server always
 * sends it, so a required field missing from our types is a real gap. An
 * optional one may legitimately be something we chose not to surface — the
 * passthrough `raw` still carries it either way.
 */

const SCHEMA_PATH = fileURLToPath(new URL('../schema/openapi.snapshot.json', import.meta.url));
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
  info: { version: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> };
};

/** snake_case wire name -> the camelCase key we parse it into. */
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function requiredOf(name: string): string[] {
  const entry = schema.components.schemas[name];
  expect(entry, `schema ${name} vanished from the snapshot`).toBeDefined();
  return entry.required ?? [];
}

/**
 * Is this operation metered?
 *
 * ⚠️ A trap this test walked into on 2026-08-30, kept written down because the
 * next reader will walk into it too: describe.net's free routes do NOT omit
 * `security`, they carry `security: []` — an explicit "no scheme applies". And
 * `Boolean([])` is **`true`** in JavaScript, so the obvious check marks every
 * one of the 13 free routes as paid. (Python's `bool([])` is `False`, which is
 * why the same check written during the recon read correctly and this one did
 * not.) The predicate has to be LENGTH, never truthiness.
 *
 * Reproduce: `node -e "console.log(Boolean([]))"` -> `true`.
 */
function isMetered(op: { security?: unknown[] }): boolean {
  return (op.security ?? []).length > 0;
}

/** Every required wire field must land somewhere in the parsed object. */
function assertCovers(schemaName: string, parsed: Record<string, unknown>, exempt: string[] = []) {
  const missing = requiredOf(schemaName)
    .filter((field) => !exempt.includes(field))
    .filter((field) => !(camel(field) in parsed));
  expect(missing, `${schemaName}: required fields absent from the parsed shape`).toEqual([]);
}

describe('the routes this SDK wraps still exist in the schema', () => {
  it.each([
    ['/wallets/{wallet}/chains', false],
    ['/leaderboard', false],
    ['/health', false],
    ['/reputation/wallet/{wallet}', true],
    ['/reputation/agent/{network}/{agent_id}', true],
    ['/badge/{wallet}.svg', false],
  ])('%s is present and metered=%s', (path, metered) => {
    const op = schema.paths[path]?.get as { security?: unknown[] } | undefined;
    expect(op, `${path} is gone from the API`).toBeDefined();
    // If a free route ever becomes metered, this SDK's whole "gratis-primero"
    // happy path changes shape. Better a red test than a surprise 402.
    expect(isMetered(op!), `${path} changed its payment status`).toBe(metered);
  });
});

describe('hand-written types cover every required field of the schema', () => {
  it('WalletChains -> WalletReputation', () => {
    const parsed = parseWalletReputation({ wallet: '0x1', chains: [] }) as unknown as Record<string, unknown>;
    assertCovers('WalletChains', parsed);
  });

  it('WalletChain -> WalletChainRow', () => {
    const parsed = parseWalletReputation({
      wallet: '0x1',
      chains: [{ network: 'base' }],
    });
    assertCovers('WalletChain', parsed.chains[0] as unknown as Record<string, unknown>);
  });

  it('WalletScore -> WalletBreakdown', () => {
    const parsed = parseWalletBreakdown({ wallet: '0x1' }, null) as unknown as Record<string, unknown>;
    assertCovers('WalletScore', parsed);
  });

  it('AgentScore -> AgentReputation', () => {
    const parsed = parseAgentReputation({ agent_id: '1' }, null) as unknown as Record<string, unknown>;
    assertCovers('AgentScore', parsed);
  });

  it('Rating -> Rating', () => {
    // Added 2026-09-15. `Rating` was typed since 0.1.0 and never checked here,
    // so `author_class` becoming a REQUIRED field upstream (2026-09-14) would
    // have crossed this gate in silence — same hole as in `refresh-schema.mjs`.
    const [parsed] = parseAgentReputation({ agent_id: '1', ratings: [{ client: '0x1' }] }, null).ratings;
    assertCovers('Rating', parsed as unknown as Record<string, unknown>);
  });

  it('LeaderboardRow -> LeaderboardRow', () => {
    const [parsed] = parseLeaderboard([{ rank: 1, wallet: '0x1' }]);
    assertCovers('LeaderboardRow', parsed as unknown as Record<string, unknown>);
  });

  it('Health -> IndexHealth', () => {
    const parsed = parseHealth({ status: 'ok' }) as unknown as Record<string, unknown>;
    assertCovers('Health', parsed);
  });

  it('Caveat -> Caveat', () => {
    const parsed = parseWalletReputation({
      wallet: '0x1',
      caveats: [{ code: 'few-raters', text: 'pocos' }],
    });
    assertCovers('Caveat', parsed.caveats[0] as unknown as Record<string, unknown>);
  });
});

describe('the gate is discriminant', () => {
  it('goes RED when a required field has no home in the parsed shape', () => {
    // Mount the bad state: a parsed object that dropped `global_score`, which
    // is exactly the failure this gate exists to catch (a field the server
    // always sends and our type quietly stopped carrying).
    const drifted = parseWalletReputation({ wallet: '0x1', chains: [] }) as unknown as Record<
      string,
      unknown
    >;
    delete drifted.globalScore;

    expect(() => assertCovers('WalletChains', drifted)).toThrow();
  });

  it('goes RED when a schema name it depends on disappears', () => {
    expect(() => requiredOf('SchemaThatDoesNotExist')).toThrow();
  });
});

describe('the x402 security scheme is still what we implement', () => {
  it('is an apiKey in the X-PAYMENT header', () => {
    const x402 = (schema.components as unknown as { securitySchemes: Record<string, { type: string; in: string; name: string }> })
      .securitySchemes.x402;
    expect(x402).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-PAYMENT' });
  });
});

describe('the caveat codes we export are the ones the index can send', () => {
  it('are nine, kebab-case, and unique — one short of the service, knowingly', () => {
    // The set is frozen upstream in `describenet/caveats.py:177-192` and pinned
    // there by its own test. This asserts our copy has not been edited by hand
    // — an added or renamed code is a contract change, never a typo that slid
    // through. The snapshot cannot check this for us: the schema types `code`
    // as a plain string, which is the whole reason exporting the set is a
    // deliverable of this package.
    // ⚠️ Eight until 2026-09-15, when `facilitator-authored` was mirrored. The
    // service serves TEN: `thin-chain` (upstream 2026-09-04) is deliberately NOT
    // here yet — missing from both twins, reported for a follow-up that adds it
    // to both at once. See the docstring of `CAVEAT_CODES`.
    expect(CAVEAT_CODES).toHaveLength(9);
    expect(new Set(CAVEAT_CODES).size).toBe(9);
    for (const code of CAVEAT_CODES) expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/);
    expect([...CAVEAT_CODES].sort()).toEqual([
      'burn-address',
      'campaign-per-rater',
      'concentration-degraded',
      'facilitator-authored',
      'few-raters',
      'no-score',
      'self-rated',
      'single-rater',
      'top-client-share',
    ]);
  });

  it('every code the free route declares unevaluated is one we export', () => {
    // The schema cannot list them (it types the entries as plain strings), so
    // this reads the only machine-readable source there is: the description
    // names the metered route that DOES evaluate them. What it can pin is the
    // field itself — a list of strings, required.
    const field = schema.components.schemas.WalletChains.properties?.caveats_not_computed as {
      type: string;
      items: { type: string };
    };
    expect(field).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(requiredOf('WalletChains')).toContain('caveats_not_computed');
  });
});

describe('the author classes we export are the schema enum, exactly', () => {
  it('match `Rating.author_class.enum` in the snapshot', () => {
    // Unlike the caveat codes, this one the schema DOES enumerate, so the copy
    // is pinned against the snapshot itself instead of against a typed list.
    // The type stays OPEN anyway (see `AuthorClass`): this pins what is known,
    // it does not forbid what comes next.
    const field = schema.components.schemas.Rating.properties?.author_class as { enum: string[] };
    expect([...AUTHOR_CLASSES].sort()).toEqual([...field.enum].sort());
    expect(requiredOf('Rating')).toContain('author_class');
  });
});

describe('the snapshot is the version we wrote these types against', () => {
  it('is describe.net 2.0.0 with 22 paths', () => {
    // 20 until the refresh of 2026-09-15, which added two FREE routes this SDK
    // does not wrap (`GET /categories`, `GET /wallets/{wallet}/exists`) and the
    // two fields 0.4.0 types. `info.version` did not move: both are additive.
    expect(schema.info.version).toBe('2.0.0');
    expect(Object.keys(schema.paths)).toHaveLength(22);
  });
});
