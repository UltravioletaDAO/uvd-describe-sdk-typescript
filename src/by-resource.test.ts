import { describe, expect, it, vi } from 'vitest';

import { BY_RESOURCE, BY_RESOURCE_URLS } from './__fixtures__/live';
import { mockServer } from './__fixtures__/server';
import { DescribeClient, type DescribeClientConfig, type DescribeFailure, type PartnerSigner } from './client';
import { DescribeHTTPError, DescribeUnparseable } from './errors';
import { parseByResource } from './parse';

/**
 * `byResource()` — `GET /reputation/by-resource`, free, added in 0.7.0.
 *
 * What these tests hold in place, in order of what it would cost to lose it:
 *
 *   1. the order is the only key (no URL comes back), so a row that cannot be
 *      read, or a row count that does not match the URLs sent, is REFUSED —
 *      never dropped, never zipped against the wrong list;
 *   2. each URL is its own percent-encoded `url=` parameter, so a resource URL
 *      with a `&` in it cannot cut the batch short or ask about another URL;
 *   3. `null` stays `null` (`identityCount`, `hasIdentity`, `distinctRaters`);
 *   4. the parsed shape has no field an address could ride in;
 *   5. the free-route rules of `wallet()`: fail-open announced, a 422 thrown.
 *
 * Offline: every request is answered by `mockServer`, with the payload captured
 * live on 2026-11-17 (`__fixtures__/live.ts`).
 */

const testClient = (config: DescribeClientConfig = {}) => new DescribeClient({ jitterMs: 0, ...config });

const ENCODED = BY_RESOURCE_URLS.map((url) => `url=${encodeURIComponent(url)}`).join('&');
const PATH = `/reputation/by-resource?${ENCODED}`;

describe('byResource() reads the live answer', () => {
  it('parses both rows of the captured batch, in order', async () => {
    const server = mockServer({ [PATH]: { body: BY_RESOURCE } });
    const client = testClient({ fetchImpl: server.fetch });

    const answer = await client.byResource(BY_RESOURCE_URLS);

    expect(answer).not.toBeNull();
    const [found, absent] = answer!.resources;
    expect(found).toMatchObject({
      status: 'found',
      listingHealth: 'alive',
      collectorsCheckable: true,
      collectorsOmitted: 0,
      bazaarReadAt: '2026-11-17T03:27:44.318208Z',
    });
    expect(found.collectors).toHaveLength(6);
    expect(found.collectors[0]).toEqual({
      network: 'eip155:8453',
      identityStatus: 'erc8004_identity',
      hasIdentity: true,
      identityCount: 12,
      agent: { network: 'base', agentId: '31995' },
      reviews: {
        hasReputation: true,
        totalReviews: 71,
        distinctRaters: 8,
        chainsWithReputation: 2,
        lastEligibleRatingAt: '2026-04-26T06:40:43Z',
      },
    });
    // Six rows, one agent: a row is a network, not a counterparty — and
    // `agent()` over every row would pay six times for one read.
    expect(new Set(found.collectors.map((c) => c.network)).size).toBe(6);
    expect(new Set(found.collectors.map((c) => c.agent?.agentId)).size).toBe(1);

    expect(absent).toEqual({
      status: 'not_in_bazaar',
      listingHealth: null,
      collectorsCheckable: null,
      collectors: [],
      collectorsOmitted: 0,
      bazaarReadAt: '2026-11-17T03:27:44.312961Z',
    });
    expect(answer!.bazaar).toBe('https://facilitator.ultravioletadao.xyz/discovery/resources');
    expect(answer!.source).toBe('chain_rankings_mv');
    expect(answer!.refreshedAt).toBe('2026-11-17T02:51:38.297174Z');
    expect(answer!.raw).toEqual(BY_RESOURCE);
  });

  it('the parsed collector has exactly the six schema fields — none where an address could ride', () => {
    // Emporium's anti-rail rule is that it never holds a payment address, and
    // describe.net built this route so that it can ask it. The SDK is the
    // layer that could quietly add one (`payTo` "for convenience"); this pins
    // that it did not. `raw` is the passthrough and is the server's promise.
    const [collector] = parseByResource(BY_RESOURCE).resources[0].collectors;
    expect(Object.keys(collector).sort()).toEqual(
      ['agent', 'hasIdentity', 'identityCount', 'identityStatus', 'network', 'reviews'].sort(),
    );
    expect(Object.keys(collector.agent!).sort()).toEqual(['agentId', 'network']);
    expect(JSON.stringify(parseByResource(BY_RESOURCE))).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});

describe('byResource() builds the query so no URL can cut another short', () => {
  it('sends each URL as its own percent-encoded url= parameter, in order', async () => {
    const server = mockServer({ [PATH]: { body: BY_RESOURCE } });
    const client = testClient({ fetchImpl: server.fetch });

    await client.byResource(BY_RESOURCE_URLS);

    expect(server.calls).toHaveLength(1);
    expect(server.calls[0].path).toBe(
      '/reputation/by-resource?url=https%3A%2F%2Fapi.describe.net%2Freputation%2Fwallet' +
        '&url=https%3A%2F%2Fapi.example.com%2Fv1%2Fprices',
    );
  });

  it('MOUNTS THE BAD STATE: a & or # inside a resource URL stays inside its parameter', async () => {
    // Unencoded, `?b=1&c=2#frag` would end the parameter at `&`, ask about
    // `https://x.test/a?b=1`, add a stray `c` parameter and drop the fragment
    // client-side — one URL in, a different URL asked about.
    const tricky = 'https://x.test/a?b=1&c=2#frag';
    const row = { ...BY_RESOURCE.resources[1] };
    const server = mockServer({
      '/reputation/by-resource?url=https%3A%2F%2Fx.test%2Fa%3Fb%3D1%26c%3D2%23frag': {
        body: { ...BY_RESOURCE, resources: [row] },
      },
    });
    const client = testClient({ fetchImpl: server.fetch, failOpen: false });

    const answer = await client.byResource(tricky);

    expect(answer!.resources).toHaveLength(1);
    expect(new URL(`https://api.describe.net${server.calls[0].path}`).searchParams.getAll('url')).toEqual([tricky]);
  });

  it('a single string is one URL, the same request as a one-element list', async () => {
    const one = `/reputation/by-resource?url=${encodeURIComponent(BY_RESOURCE_URLS[1])}`;
    const body = { ...BY_RESOURCE, resources: [BY_RESOURCE.resources[1]] };
    const server = mockServer({ [one]: { body } });
    const client = testClient({ fetchImpl: server.fetch });

    await client.byResource(BY_RESOURCE_URLS[1]);
    await client.byResource([BY_RESOURCE_URLS[1]]);

    expect(server.calls.map((c) => c.path)).toEqual([one, one]);
  });

  it('on the partner rail the signature covers the query, not only the path', async () => {
    // The first free route with a query string. ERC-8128 signs the target URI;
    // signing the bare path would send a signature for a request that was not
    // made.
    const server = mockServer({ [PATH]: { body: BY_RESOURCE } });
    const sign = vi.fn<PartnerSigner['sign']>(async () => ({ Signature: 'sig', 'Signature-Input': 'input' }));
    const client = testClient({ fetchImpl: server.fetch, partner: { sign } });

    await client.byResource(BY_RESOURCE_URLS);

    expect(sign).toHaveBeenCalledWith({ method: 'GET', url: `https://api.describe.net${PATH}` });
    expect(server.calls[0].headers.Signature).toBe('sig');
  });
});

describe('the order is the only key — MOUNTS THE BAD STATE', () => {
  it('fewer rows than URLs is unparseable: null, announced, never a short list', async () => {
    const server = mockServer({ [PATH]: { body: { ...BY_RESOURCE, resources: [BY_RESOURCE.resources[1]] } } });
    const seen: DescribeFailure[] = [];
    const client = testClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

    // Handed over, the one row would be zipped against the FIRST URL — and
    // describe.net's own listing would read `not_in_bazaar`.
    expect(await client.byResource(BY_RESOURCE_URLS)).toBeNull();
    expect(seen).toEqual([expect.objectContaining({ kind: 'unparseable', path: PATH })]);
  });

  it('more rows than URLs is refused too, and with failOpen off it throws', async () => {
    const rows = [...BY_RESOURCE.resources, BY_RESOURCE.resources[1]];
    const server = mockServer({ [PATH]: { body: { ...BY_RESOURCE, resources: rows } } });
    const client = testClient({ fetchImpl: server.fetch, failOpen: false });

    const error = await client.byResource(BY_RESOURCE_URLS).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DescribeUnparseable);
    expect((error as Error).message).toMatch(/3 row\(s\) for 2 URL\(s\)/);
  });

  it('a row that is not an object throws in the parser instead of being dropped', () => {
    // `filter(isObj)` here would shift row 1 into position 0: the second URL's
    // answer filed under the first URL. The exported parser has no URL list to
    // count against, so it is the parser that has to refuse.
    expect(() => parseByResource({ ...BY_RESOURCE, resources: [null, BY_RESOURCE.resources[0]] })).toThrow(
      /row 0 is not an object/,
    );
  });
});

describe('null is never 0, and nothing asked is not false', () => {
  it('a collector nobody could ask keeps its nulls', () => {
    const notIndexed = {
      network: 'stellar:pubnet',
      identity_status: 'not_indexed',
      has_identity: null,
      identity_count: null,
      agent: null,
      reviews: null,
    };
    const payload = { ...BY_RESOURCE, resources: [{ ...BY_RESOURCE.resources[0], collectors: [notIndexed] }] };

    const [collector] = parseByResource(payload).resources[0].collectors;

    expect(collector.identityCount).toBeNull();
    expect(collector.hasIdentity).toBeNull();
    expect(collector.agent).toBeNull();
    expect(collector.reviews).toBeNull();
    expect(collector.identityStatus).toBe('not_indexed');
  });

  it('distinct_raters null ("not in the ranking") stays null, next to a real 0 count', () => {
    const reviews = { ...BY_RESOURCE.resources[0].collectors[0].reviews, distinct_raters: null, total_reviews: 0 };
    const collector = { ...BY_RESOURCE.resources[0].collectors[0], reviews };
    const payload = { ...BY_RESOURCE, resources: [{ ...BY_RESOURCE.resources[0], collectors: [collector] }] };

    const parsed = parseByResource(payload).resources[0].collectors[0].reviews!;

    expect(parsed.distinctRaters).toBeNull();
    expect(parsed.totalReviews).toBe(0);
  });

  it('MOUNTS THE BAD STATE: an agent block without an id is no identity, never agentId "undefined"', () => {
    // Without the id check, `String(undefined)` hands the caller
    // `{ network: 'base', agentId: 'undefined' }` — a link to `agent('base',
    // 'undefined')`, which a consumer following the docstring would call.
    for (const agent of [{ network: 'base' }, { network: 'base', agent_id: null }]) {
      const collector = { ...BY_RESOURCE.resources[0].collectors[0], agent };
      const payload = { ...BY_RESOURCE, resources: [{ ...BY_RESOURCE.resources[0], collectors: [collector] }] };
      expect(parseByResource(payload).resources[0].collectors[0].agent, JSON.stringify(agent)).toBeNull();
    }
  });

  it('a status this SDK has not heard of arrives verbatim', () => {
    const payload = { ...BY_RESOURCE, resources: [{ ...BY_RESOURCE.resources[1], status: 'delisted' }] };
    expect(parseByResource(payload).resources[0].status).toBe('delisted');
  });
});

/**
 * What the live capture does not carry, SHAPED from the schema — not captured,
 * and labelled so (`components.schemas.Resource*` of the vendored spec). The
 * refuter of 0.7.0 (P2-2, P2-3) showed seven mutants alive on the live fixture
 * alone, because it has one agent on one chain, every boolean `true` and no
 * `null` outside row 1: a `false` read as `null`, a `null` read as "now", an
 * omitted count read as `0`, and the agent's network hard-wired to `base` all
 * passed. The Solana asset id is the schema's own example.
 */
const SHAPED = {
  resources: [
    {
      status: 'found',
      listing_health: 'degraded',
      collectors_checkable: false,
      collectors: [
        {
          network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          identity_status: 'erc8004_identity',
          has_identity: true,
          identity_count: 1,
          agent: { network: 'solana', agent_id: '4qNFzd4bQvdspEDmrAMnk3shcrEYHo4n52zfW9VVFLhZ' },
          reviews: {
            has_reputation: false,
            total_reviews: 0,
            distinct_raters: null,
            chains_with_reputation: 0,
            last_eligible_rating_at: null,
          },
        },
        {
          network: 'eip155:8453',
          identity_status: 'no_erc8004_identity',
          has_identity: false,
          identity_count: 0,
          agent: null,
          reviews: null,
        },
        {
          network: null,
          identity_status: 'not_indexed',
          has_identity: null,
          identity_count: null,
          agent: null,
          reviews: null,
        },
      ],
      collectors_omitted: 3,
      bazaar_read_at: '2026-11-17T03:00:00Z',
    },
    {
      status: 'bazaar_unavailable',
      listing_health: null,
      collectors_checkable: null,
      collectors: [],
      collectors_omitted: 0,
      bazaar_read_at: null,
    },
  ],
  bazaar: 'https://facilitator.ultravioletadao.xyz/discovery/resources',
  source: 'chain_rankings_mv',
  refreshed_at: null,
};

describe('the states the live capture does not carry — SHAPED from the schema', () => {
  it('false stays false, null stays null, an omitted count is not 0, and the agent keeps its chain', () => {
    const answer = parseByResource(SHAPED);

    expect(answer.refreshedAt).toBeNull();
    expect(answer.resources).toEqual([
      {
        status: 'found',
        listingHealth: 'degraded',
        collectorsCheckable: false,
        collectors: [
          {
            network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
            identityStatus: 'erc8004_identity',
            hasIdentity: true,
            identityCount: 1,
            agent: { network: 'solana', agentId: '4qNFzd4bQvdspEDmrAMnk3shcrEYHo4n52zfW9VVFLhZ' },
            reviews: {
              hasReputation: false,
              totalReviews: 0,
              distinctRaters: null,
              chainsWithReputation: 0,
              lastEligibleRatingAt: null,
            },
          },
          {
            network: 'eip155:8453',
            identityStatus: 'no_erc8004_identity',
            hasIdentity: false,
            identityCount: 0,
            agent: null,
            reviews: null,
          },
          {
            network: null,
            identityStatus: 'not_indexed',
            hasIdentity: null,
            identityCount: null,
            agent: null,
            reviews: null,
          },
        ],
        collectorsOmitted: 3,
        bazaarReadAt: '2026-11-17T03:00:00Z',
      },
      {
        status: 'bazaar_unavailable',
        listingHealth: null,
        collectorsCheckable: null,
        collectors: [],
        collectorsOmitted: 0,
        bazaarReadAt: null,
      },
    ]);
  });

  it('a field that did not come never reads as the good value', () => {
    // A row, a collector and a reviews block with nothing in them: none may
    // come out `found`, `alive`, `erc8004_identity` or `has_reputation: true`.
    const empty = parseByResource({
      ...BY_RESOURCE,
      resources: [{ collectors: [{ reviews: {} }] }],
    }).resources[0];

    expect(empty).toEqual({
      status: '',
      listingHealth: null,
      collectorsCheckable: null,
      collectors: [
        {
          network: null,
          identityStatus: '',
          hasIdentity: null,
          identityCount: null,
          agent: null,
          reviews: {
            hasReputation: false,
            totalReviews: 0,
            distinctRaters: null,
            chainsWithReputation: 0,
            lastEligibleRatingAt: null,
          },
        },
      ],
      collectorsOmitted: 0,
      bazaarReadAt: null,
    });
  });

  it('half a link is no link: an empty or non-string id or network gives agent null', () => {
    for (const agent of [
      { network: 'base', agent_id: '' },
      { network: 'base', agent_id: {} },
      { network: 'base', agent_id: 31995 },
      { agent_id: '31995' },
      { network: '', agent_id: '31995' },
    ]) {
      const collector = { ...BY_RESOURCE.resources[0].collectors[0], agent };
      const payload = { ...BY_RESOURCE, resources: [{ ...BY_RESOURCE.resources[0], collectors: [collector] }] };
      expect(parseByResource(payload).resources[0].collectors[0].agent, JSON.stringify(agent)).toBeNull();
    }
  });

  it('a count that is not a JSON integer is not a declaration: "" is null, not 0', () => {
    for (const identity_count of ['', false, [], '12', -1, 1.5]) {
      const collector = { ...BY_RESOURCE.resources[0].collectors[0], identity_count };
      const payload = { ...BY_RESOURCE, resources: [{ ...BY_RESOURCE.resources[0], collectors: [collector] }] };
      expect(parseByResource(payload).resources[0].collectors[0].identityCount, JSON.stringify(identity_count)).toBeNull();
    }
  });
});

describe('byResource() input', () => {
  it('an empty list throws before any request — it could only be a 422', async () => {
    const server = mockServer({});
    const client = testClient({ fetchImpl: server.fetch });

    await expect(client.byResource([])).rejects.toBeInstanceOf(TypeError);
    expect(server.calls).toHaveLength(0);
  });

  it('the same URL twice is asked twice and answered twice — never deduplicated here', async () => {
    // describe.net answers one row per `url` sent, duplicates included.
    // Deduplicating before sending would make the count check refuse a good
    // answer, or — without it — shift every row after the duplicate.
    const twice = [BY_RESOURCE_URLS[1], BY_RESOURCE_URLS[1]];
    const path = `/reputation/by-resource?${twice.map((u) => `url=${encodeURIComponent(u)}`).join('&')}`;
    const server = mockServer({
      [path]: { body: { ...BY_RESOURCE, resources: [BY_RESOURCE.resources[1], BY_RESOURCE.resources[1]] } },
    });
    const client = testClient({ fetchImpl: server.fetch, failOpen: false });

    const answer = await client.byResource(twice);

    expect(server.calls[0].path).toBe(path);
    expect(answer!.resources).toHaveLength(2);
  });
});

describe('byResource() follows the free-route rules', () => {
  it('a 503 returns null and announces it', async () => {
    const server = mockServer({ [PATH]: { status: 503, body: {} } });
    const seen: DescribeFailure[] = [];
    const client = testClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

    expect(await client.byResource(BY_RESOURCE_URLS)).toBeNull();
    expect(seen).toEqual([expect.objectContaining({ kind: 'http_5xx', transient: true, path: PATH })]);
  });

  it('the 1 rps budget answers 429: null, announced, transient', async () => {
    const server = mockServer({ [PATH]: { status: 429, body: {} } });
    const seen: DescribeFailure[] = [];
    const client = testClient({ fetchImpl: server.fetch, onFailure: (f) => seen.push(f) });

    expect(await client.byResource(BY_RESOURCE_URLS)).toBeNull();
    expect(seen[0]).toMatchObject({ kind: 'http_4xx', transient: true });
  });

  it('too_many_urls is the caller\'s bug and throws, failOpen or not', async () => {
    const urls = Array.from({ length: 11 }, (_, i) => `https://x.test/${i}`);
    const path = `/reputation/by-resource?${urls.map((u) => `url=${encodeURIComponent(u)}`).join('&')}`;
    const server = mockServer({
      [path]: { status: 422, body: { detail: { error: 'too_many_urls', index: 10, max_urls: 10 } } },
    });
    const onFailure = vi.fn();
    const client = testClient({ fetchImpl: server.fetch, failOpen: true, onFailure });

    const error = await client.byResource(urls).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DescribeHTTPError);
    expect(error).toMatchObject({ kind: 'http_4xx', status: 422, transient: false });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('a parsed answer fed back into the parser is refused, not read as rows of nulls', () => {
    const parsed = parseByResource(BY_RESOURCE);
    expect(() => parseByResource(parsed)).toThrow(/already parsed/);
    expect(() => parseByResource({ resources: 'nope' })).toThrow(DescribeUnparseable);
  });
});
