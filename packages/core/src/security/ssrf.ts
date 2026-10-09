import dns from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch, type Response } from 'undici';

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const BLOCKED_HOST_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.home.arpa',
  '.lan',
  '.intranet',
  '.corp',
];
const ALLOWED_PORTS = new Set(['', '80', '443']);

/** True when an IP address is public unicast (safe to connect to). */
export function isPublicIp(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let addr = ipaddr.parse(address);
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
  }
  const range = addr.range();
  if (range !== 'unicast') return false;
  if (addr.kind() === 'ipv4') {
    // ipaddr.js labels a few special-purpose blocks as unicast; block them explicitly.
    const v4 = addr as ipaddr.IPv4;
    const extra: [string, number][] = [
      ['0.0.0.0', 8],
      ['100.64.0.0', 10],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
    ];
    if (extra.some(([net, bits]) => v4.match(ipaddr.IPv4.parse(net), bits))) return false;
  }
  return true;
}

/** Syntactic URL validation (no DNS). Throws UnsafeUrlError. */
export function validatePublicUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UnsafeUrlError('That does not look like a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeUrlError('Only http:// and https:// links are supported.');
  }
  if (url.username || url.password) throw new UnsafeUrlError('Links containing credentials are not allowed.');
  if (!ALLOWED_PORTS.has(url.port))
    throw new UnsafeUrlError('Links must use the standard web ports (80/443).');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new UnsafeUrlError('The link has no host name.');
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError('Links to local or internal hosts are not allowed.');
  }
  if (net.isIP(host)) {
    if (!isPublicIp(host))
      throw new UnsafeUrlError('Links to private or reserved IP addresses are not allowed.');
  } else if (!host.includes('.')) {
    throw new UnsafeUrlError('Links must use a fully-qualified public domain name.');
  }
  if (input.length > 2048) throw new UnsafeUrlError('The link is too long.');
  return url;
}

type LookupFn = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
) => void;

/**
 * DNS lookup used for every outbound connection: all resolved addresses must
 * be public. Because validation happens at connect time, DNS rebinding
 * between "check" and "use" is not possible.
 */
export const safeLookup: LookupFn = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = addresses as dns.LookupAddress[];
    if (!list.length) return callback(new Error(`No addresses for ${hostname}`) as NodeJS.ErrnoException, '');
    const bad = list.find((a) => !isPublicIp(a.address));
    if (bad) {
      const e = new UnsafeUrlError(
        `Host ${hostname} resolves to a private or reserved address`,
      ) as unknown as NodeJS.ErrnoException;
      return callback(e, '');
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
};

let agent: Agent | undefined;
function getSafeAgent(): Agent {
  if (!agent) {
    agent = new Agent({
      connect: { lookup: safeLookup as never, timeout: 10_000 },
      headersTimeout: 30_000,
      bodyTimeout: 60_000,
    });
  }
  return agent;
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
}

/**
 * Fetch a user-supplied URL safely: validated scheme/host/port, public-IP
 * enforcement at connect time, manual redirect handling (each hop validated)
 * and a total timeout.
 */
export async function safeFetch(
  input: string,
  opts: SafeFetchOptions = {},
): Promise<{ response: Response; finalUrl: URL }> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  let url = validatePublicUrl(input);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await undiciFetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        'user-agent': 'AI-Social-Video-Studio/1.0 (+reference-analysis)',
        accept: '*/*',
        ...opts.headers,
      },
      redirect: 'manual',
      signal,
      dispatcher: getSafeAgent(),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      await response.body?.cancel().catch(() => undefined);
      const next = new URL(response.headers.get('location')!, url);
      url = validatePublicUrl(next.toString());
      continue;
    }
    return { response, finalUrl: url };
  }
  throw new UnsafeUrlError('Too many redirects.');
}

/** Read a response body into memory with a hard size cap. */
export async function readBodyLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const len = Number(response.headers.get('content-length') || 0);
  if (len && len > maxBytes)
    throw new UnsafeUrlError(`Remote file is too large (${Math.round(len / 1e6)} MB).`);
  const chunks: Buffer[] = [];
  let total = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    const b = Buffer.from(chunk as Uint8Array);
    total += b.length;
    if (total > maxBytes)
      throw new UnsafeUrlError(`Remote file exceeds the ${Math.round(maxBytes / 1e6)} MB limit.`);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
