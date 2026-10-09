import type { FetchImpl } from '../../src/providers/http';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Build a fetch mock that replies from a queue of handlers and records calls. */
export function mockFetch(responses: ((call: RecordedCall) => Response | Promise<Response>)[]): {
  fetch: FetchImpl;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetch: FetchImpl = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach(
      (v, k) => (headers[k] = v),
    );
    let body: unknown = init?.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep string */
      }
    }
    const call = { url: String(input), method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    const handler = responses[Math.min(i++, responses.length - 1)];
    if (!handler) throw new Error('No mock response configured');
    return handler(call);
  };
  return { fetch, calls };
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
