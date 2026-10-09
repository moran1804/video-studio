import type { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/** Fixed-window rate limiter backed by Redis (INCR + EXPIRE). */
export async function rateLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const k = `rl:${key}:${bucket}`;
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, windowSec + 1);
  const allowed = count <= limit;
  const retryAfterSec = allowed ? 0 : windowSec - (Math.floor(Date.now() / 1000) % windowSec);
  return { allowed, remaining: Math.max(0, limit - count), retryAfterSec };
}
