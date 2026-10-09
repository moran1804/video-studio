import { NextResponse } from 'next/server';
import { getPool } from '@studio/core/db';
import { getRedis } from '@studio/core/redis';
import { getConfig } from '@studio/core/config';

export const dynamic = 'force-dynamic';

/** Unauthenticated health endpoint used by the Docker health check. */
export async function GET() {
  const result: Record<string, unknown> = { ok: false };
  try {
    getConfig();
    await getPool().query('select 1');
    result.db = 'ok';
  } catch (err) {
    result.db = `error: ${(err as Error).message}`;
  }
  try {
    await getRedis().ping();
    result.redis = 'ok';
    const hb = await getRedis().get('studio:worker:heartbeat');
    result.worker = hb ? `ok (${Math.round((Date.now() - JSON.parse(hb).at) / 1000)}s ago)` : 'no heartbeat';
  } catch (err) {
    result.redis = `error: ${(err as Error).message}`;
  }
  result.ok = result.db === 'ok' && result.redis === 'ok';
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
