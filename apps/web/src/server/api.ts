import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import { getConfig } from '@studio/core/config';
import { getLogger } from '@studio/core/logger';
import { ProviderError, UserFacingError } from '@studio/core/errors';
import { PathSecurityError } from '@studio/core/security/paths';
import { UnsafeUrlError } from '@studio/core/security/ssrf';
import { rateLimit } from '@studio/core/security/rate-limit';
import { timingSafeEqualStr } from '@studio/core/security/crypto';
import { redactError } from '@studio/core/security/redact';
import { getRedis } from '@studio/core/redis';
import { CSRF_COOKIE, SESSION_COOKIE, userFromToken, type SessionUser } from './auth';
import { ensureInit } from './init';

const log = getLogger('api');

export class HttpError extends UserFacingError {}

export interface ApiOptions {
  auth?: boolean;
  csrf?: boolean;
  rateLimit?: { bucket: string; limit: number; windowSec: number };
}

export interface ApiContext<P> {
  params: P;
  user: SessionUser | null;
}

type Handler<P> = (req: NextRequest, ctx: ApiContext<P>) => Promise<Response | unknown>;

export function clientIp(req: NextRequest): string {
  if (getConfig().TRUST_PROXY) {
    const fwd = req.headers.get('x-forwarded-for');
    if (fwd) return fwd.split(',')[0]!.trim();
    const real = req.headers.get('x-real-ip');
    if (real) return real.trim();
  }
  return req.headers.get('x-studio-remote-addr') ?? 'local';
}

/** Origin + double-submit token check for state-changing requests. */
export function checkCsrf(req: NextRequest): void {
  const c = getConfig();
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  let source: string | null = null;
  try {
    source = origin ? new URL(origin).origin : referer ? new URL(referer).origin : null;
  } catch {
    source = null;
  }
  const selfOrigin = req.nextUrl.origin;
  const allowed = new Set([...c.allowedOrigins, selfOrigin]);
  if (!source || !allowed.has(source)) {
    throw new UserFacingError(
      'Request blocked: origin not allowed. If you access the studio through a different URL, add it to ALLOWED_ORIGINS or set APP_URL correctly.',
      403,
      'csrf',
    );
  }
  const header = req.headers.get('x-csrf-token') ?? '';
  const cookie = req.cookies.get(CSRF_COOKIE)?.value ?? '';
  if (!header || !cookie || !timingSafeEqualStr(header, cookie)) {
    throw new UserFacingError(
      'Security token missing or expired. Reload the page and try again.',
      403,
      'csrf',
    );
  }
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const field = issue?.path.join('.') || 'input';
    return NextResponse.json(
      { error: `${field}: ${issue?.message ?? 'invalid value'}`, code: 'validation' },
      { status: 400 },
    );
  }
  if (err instanceof UserFacingError)
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  if (err instanceof PathSecurityError || err instanceof UnsafeUrlError) {
    return NextResponse.json({ error: err.message, code: 'unsafe' }, { status: 400 });
  }
  if (err instanceof ProviderError) {
    return NextResponse.json(
      { error: redactError(err), code: 'provider' },
      { status: err.options.status === 429 ? 429 : 502 },
    );
  }
  log.error({ err }, 'unhandled API error');
  return NextResponse.json(
    { error: 'Something went wrong. Check the web container logs for details.', code: 'internal' },
    { status: 500 },
  );
}

/** Wrap a route handler with init, auth, CSRF, rate limiting and error mapping. */
export function api<P = Record<string, string>>(handler: Handler<P>, opts: ApiOptions = {}) {
  return async (req: NextRequest, ctx: { params: Promise<P> }): Promise<Response> => {
    try {
      await ensureInit();
      const needsAuth = opts.auth ?? true;
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      let user: SessionUser | null = null;
      if (needsAuth) {
        user = await userFromToken(req.cookies.get(SESSION_COOKIE)?.value);
        if (!user)
          return NextResponse.json(
            { error: 'Please sign in again.', code: 'unauthenticated' },
            { status: 401 },
          );
      }
      if (mutating && (opts.csrf ?? true)) checkCsrf(req);
      if (opts.rateLimit) {
        const rl = await rateLimit(
          getRedis(),
          `${opts.rateLimit.bucket}:${user?.id ?? clientIp(req)}`,
          opts.rateLimit.limit,
          opts.rateLimit.windowSec,
        );
        if (!rl.allowed) {
          return NextResponse.json(
            { error: `Too many requests. Try again in ${rl.retryAfterSec}s.`, code: 'rate_limited' },
            { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
          );
        }
      }
      const params = (ctx?.params ? await ctx.params : {}) as P;
      const result = await handler(req, { params, user });
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export async function parseJson<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new UserFacingError('Request body must be JSON');
  }
  return schema.parse(body);
}
