import { ProviderError } from '../errors';
import { redact } from '../security/redact';
import { getLogger } from '../logger';

const log = getLogger('http');

export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ProviderRequest {
  provider: string;
  url: string;
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  body?: string | Uint8Array | FormData;
  timeoutMs?: number;
  retries?: number;
  /** Base delay for exponential backoff (tests use a tiny value). */
  retryBaseMs?: number;
  fetchImpl?: FetchImpl;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(120_000, Math.max(0, secs * 1000));
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.min(120_000, Math.max(0, date - Date.now()));
  return undefined;
}

/** Pull a human readable message out of common provider error payloads. */
export function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 500) : undefined;
  const b = body as Record<string, unknown>;
  const err = b.error as Record<string, unknown> | string | undefined;
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;
  const detail = b.detail as Record<string, unknown> | string | undefined;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail.message === 'string') return detail.message;
  if (typeof b.message === 'string') return b.message;
  if (typeof b.failure === 'string') return b.failure;
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Call a provider API with a timeout, retries with exponential backoff and
 * rate-limit handling. Returns the raw Response on success (2xx).
 */
export async function providerFetch(req: ProviderRequest): Promise<Response> {
  const retries = req.retries ?? 3;
  const fetchImpl = req.fetchImpl ?? (globalThis.fetch as FetchImpl);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(req.url, {
        method: req.method ?? 'GET',
        headers: req.headers,
        body: req.body as RequestInit['body'],
        signal: AbortSignal.timeout(req.timeoutMs ?? 60_000),
      });
    } catch (err) {
      lastError = new ProviderError(
        `${req.provider}: network error – ${redact(String((err as Error)?.message ?? err))}`,
        {
          provider: req.provider,
          retryable: true,
        },
      );
      if (attempt < retries) {
        await sleep(backoffDelay(attempt, req.retryBaseMs));
        continue;
      }
      throw lastError;
    }
    if (res.ok) return res;

    let body: unknown = undefined;
    const text = await res.text().catch(() => '');
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    const message = extractErrorMessage(body) ?? res.statusText;
    const retryable = RETRYABLE_STATUS.has(res.status);
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    const friendly =
      res.status === 401 || res.status === 403
        ? `${req.provider}: authentication failed – check the API key (${message})`
        : res.status === 429
          ? `${req.provider}: rate limit or quota reached – ${message}`
          : `${req.provider}: HTTP ${res.status} – ${message}`;
    lastError = new ProviderError(redact(friendly), {
      provider: req.provider,
      retryable,
      status: res.status,
      retryAfterMs,
    });
    log.warn({ provider: req.provider, status: res.status, attempt }, redact(friendly));
    if (retryable && attempt < retries) {
      await sleep(retryAfterMs ?? backoffDelay(attempt, req.retryBaseMs));
      continue;
    }
    throw lastError;
  }
  throw lastError;
}

export async function providerJson<T = unknown>(req: ProviderRequest): Promise<T> {
  const res = await providerFetch(req);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(`${req.provider}: invalid JSON response`, {
      provider: req.provider,
      retryable: true,
    });
  }
}
