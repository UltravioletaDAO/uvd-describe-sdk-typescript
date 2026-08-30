/**
 * A mocked describe.net, as a `fetch` implementation.
 *
 * Tests never touch the network. `DescribeClient` takes `fetchImpl` for exactly
 * this: a stub that answers with real captured payloads and can be told to be
 * slow, to 5xx, to serve garbage, or to demand payment.
 *
 * It answers with a real `Response` (Node >= 18 has one globally), so the client
 * exercises the same `.ok` / `.status` / `.headers.get` / `.json()` path it
 * uses in production instead of a hand-rolled shape that quietly disagrees.
 */

export interface Route {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw instead of answering — a transport failure (DNS, reset, offline). */
  throws?: unknown;
  /** Never settle. Used with the client's own timeout + AbortSignal. */
  hang?: boolean;
  /** Answer with a body that is not JSON. */
  notJson?: string;
}

export interface MockServer {
  fetch: typeof fetch;
  /** Every request made, in order — path plus the headers we care about. */
  calls: Array<{ path: string; headers: Record<string, string> }>;
}

/**
 * @param routes keyed by path (`/health`), or by `path` with a `#n` suffix to
 * answer differently on the n-th call to that path — which is how the 402 →
 * pay → replay flow is exercised: `'/x#1'` answers 402 and `'/x#2'` answers 200.
 */
export function mockServer(routes: Record<string, Route>): MockServer {
  const calls: MockServer['calls'] = [];
  const seen = new Map<string, number>();

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;

    const headers: Record<string, string> = {};
    const raw = init?.headers as Record<string, string> | undefined;
    if (raw) for (const [k, v] of Object.entries(raw)) headers[k] = v;
    calls.push({ path, headers });

    const n = (seen.get(path) ?? 0) + 1;
    seen.set(path, n);

    const route = routes[`${path}#${n}`] ?? routes[path];
    if (!route) {
      return new Response(JSON.stringify({ detail: 'no route in mock' }), { status: 404 });
    }

    if (route.throws !== undefined) throw route.throws;

    if (route.hang) {
      // Honour the abort signal so the client's own timeout is what fires —
      // testing the timeout against a stub's timer would test the stub.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }

    const body = route.notJson !== undefined ? route.notJson : JSON.stringify(route.body ?? {});
    return new Response(body, {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  }) as typeof fetch;

  return { fetch: fetchImpl, calls };
}
