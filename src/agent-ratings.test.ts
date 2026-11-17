import { describe, expect, it } from 'vitest';

import { AGENT_WITH_AUTHOR_CLASSES, CHALLENGE_402 } from './__fixtures__/live';
import { mockServer } from './__fixtures__/server';
import { DescribeClient } from './client';
import { parseAgentReputation } from './parse';

/**
 * `AgentReputation.ratingsTotal` and `.ratingsPage` — the two fields
 * describe.net made REQUIRED in `AgentScore` (describe-net #94, `c0a97fa`,
 * 2026-10-17) and that `npm run schema:check` reported on 2026-11-17. Added in
 * 0.7.0.
 *
 * The metered payload cannot be captured (it costs money, and no test here may
 * spend it), so these build on `AGENT_WITH_AUTHOR_CLASSES` — itself an
 * honestly-labelled reconstruction — with the two blocks shaped as the schema
 * describes an UNPAGED answer: `offset: 0`, `limit: null`, `next_offset: null`.
 */

const UNPAGED = {
  ...AGENT_WITH_AUTHOR_CLASSES,
  ratings_total: 2,
  ratings_page: { offset: 0, limit: null, returned: 2, next_offset: null },
};

describe('ratings_total and ratings_page are typed as what they are', () => {
  it('an unpaged answer reads as the whole list, with its nulls intact', () => {
    const agent = parseAgentReputation(UNPAGED, null);

    expect(agent.ratingsTotal).toBe(2);
    expect(agent.ratingsPage).toEqual({ offset: 0, limit: null, returned: 2, nextOffset: null });
    expect(agent.ratings).toHaveLength(agent.ratingsTotal!);
  });

  it('a stored PAGE reads as a page: limit and nextOffset say so', () => {
    const page = parseAgentReputation(
      { ...UNPAGED, ratings_total: 300001, ratings_page: { offset: 200, limit: 200, returned: 2, next_offset: 400 } },
      null,
    );

    expect(page.ratingsTotal).toBe(300001);
    expect(page.ratingsPage).toEqual({ offset: 200, limit: 200, returned: 2, nextOffset: 400 });
  });

  it('MOUNTS THE BAD STATE: an undeclared total is null — not ratings.length, not 0', () => {
    // A payload stored before describe-net #94 says nothing about paging.
    // `ratings.length` (2 here) would assert it was the whole list, and `0`
    // would assert an agent that has no ratings — while two sit right there.
    const { ratings_total: _t, ratings_page: _p, ...stored } = UNPAGED;
    const agent = parseAgentReputation(stored, null);

    expect(agent.ratings).toHaveLength(2);
    expect(agent.ratingsTotal).toBeNull();
    expect(agent.ratingsPage).toBeNull();
  });

  it('a declared 0 stays 0 — an agent with no ratings is a different fact from an undeclared one', () => {
    const agent = parseAgentReputation(
      {
        ...UNPAGED,
        ratings: [],
        ratings_total: 0,
        ratings_page: { offset: 0, limit: null, returned: 0, next_offset: null },
      },
      null,
    );

    expect(agent.ratingsTotal).toBe(0);
    expect(agent.ratingsPage!.returned).toBe(0);
  });

  it('a ratings_page that is not an object is null, never a made-up whole-list page', () => {
    for (const garbage of ['whole', [], 7, null]) {
      expect(parseAgentReputation({ ...UNPAGED, ratings_page: garbage }, null).ratingsPage).toBeNull();
    }
  });

  it('MOUNTS THE BAD STATE: a partial ratings_page is null — read whole or not at all', () => {
    // The refuter of 0.7.0 (P2-4): `{}` and `{offset: 200}` used to read as
    // `{limit: null, nextOffset: null}` — the WHOLE-LIST page — so a stored
    // fragment claimed to be every rating the agent has.
    for (const partial of [
      {},
      { offset: 200 },
      { offset: 0, limit: null, returned: 2 },
      { offset: 0, returned: 2, next_offset: null },
      { offset: 0, limit: '', returned: 2, next_offset: null },
      { offset: -1, limit: null, returned: 2, next_offset: null },
      { offset: 1.5, limit: null, returned: 2, next_offset: null },
      { offset: 0, limit: null, returned: '2', next_offset: null },
      { offset: 0, limit: null, returned: 2, next_offset: 'end' },
      { offset: 0, limit: 0, returned: 0, next_offset: null },
    ]) {
      expect(parseAgentReputation({ ...UNPAGED, ratings_page: partial }, null).ratingsPage, JSON.stringify(partial)).toBeNull();
    }
  });

  it('a ratings_total that is not a JSON integer is null — "" and false are not 0', () => {
    for (const ratings_total of ['', false, [], '2', -1, 1.5]) {
      expect(parseAgentReputation({ ...UNPAGED, ratings_total }, null).ratingsTotal, JSON.stringify(ratings_total)).toBeNull();
    }
  });

  it('a page without its total does not borrow ratings.length for it', () => {
    const { ratings_total: _t, ...pageOnly } = UNPAGED;
    expect(parseAgentReputation(pageOnly, null).ratingsTotal).toBeNull();
  });
});

describe('agent() carries them through the paid path', () => {
  it('the two fields arrive on the answer the payer paid for', async () => {
    const server = mockServer({
      '/reputation/agent/base/42#1': { status: 402, body: CHALLENGE_402 },
      '/reputation/agent/base/42#2': { body: UNPAGED },
    });
    const client = new DescribeClient({ jitterMs: 0, fetchImpl: server.fetch, payer: { pay: async () => 'ok' } });

    const agent = await client.agent('base', 42);

    // No `limit`/`offset` went out: `agent()` does not page, so the request
    // path is the bare path form and the answer is the whole list.
    expect(server.calls.map((c) => c.path)).toEqual(['/reputation/agent/base/42', '/reputation/agent/base/42']);
    expect(agent.ratingsTotal).toBe(2);
    expect(agent.ratingsPage).toEqual({ offset: 0, limit: null, returned: 2, nextOffset: null });
  });
});
