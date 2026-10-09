import { Redis } from 'ioredis';
import { getConfig } from './config';

const g = globalThis as unknown as { __studioRedis?: Redis };

/** Shared connection for general commands (rate limiting, heartbeats, queue producers). */
export function getRedis(): Redis {
  if (!g.__studioRedis) g.__studioRedis = createRedis();
  return g.__studioRedis;
}

/** New connection; BullMQ workers need their own with maxRetriesPerRequest=null. */
export function createRedis(): Redis {
  const url = getConfig().REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not configured');
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
}

export async function closeRedis(): Promise<void> {
  if (g.__studioRedis) {
    g.__studioRedis.disconnect();
    g.__studioRedis = undefined;
  }
}
