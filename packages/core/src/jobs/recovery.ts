import { inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { jobs } from '../db/schema';
import { getQueue, requeueJob, type JobType, type QueueName } from '../queues';
import { getLogger } from '../logger';
import { HANDLERS } from './registry';

const log = getLogger('recovery');

const LIVE_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

/**
 * Reconcile the jobs table with BullMQ after a restart:
 * - jobs still known to Redis are left alone (stalled active jobs are retried by BullMQ);
 * - generation jobs with a provider job id resume polling;
 * - queued jobs missing from Redis are re-enqueued;
 * - other interrupted running jobs are marked failed so the user can retry.
 */
export async function recoverJobs(): Promise<{
  resumed: number;
  requeued: number;
  failed: number;
  untouched: number;
}> {
  const db = getDb();
  const rows = await db
    .select()
    .from(jobs)
    .where(inArray(jobs.status, ['queued', 'running']));
  const stats = { resumed: 0, requeued: 0, failed: 0, untouched: 0 };
  for (const row of rows) {
    let state = 'missing';
    try {
      const bull = row.bullJobId ? await getQueue(row.queue as QueueName).getJob(row.bullJobId) : undefined;
      if (bull) state = await bull.getState();
    } catch {
      state = 'missing';
    }
    if (LIVE_STATES.has(state)) {
      stats.untouched++;
      continue;
    }
    if (row.type === 'generation' && row.providerJobId) {
      await requeueJob(row, { resume: true });
      stats.resumed++;
    } else if (
      row.status === 'queued' ||
      row.type === 'brief' ||
      row.type === 'storyboard' ||
      row.type === 'prompt' ||
      row.type === 'brand' ||
      row.type === 'quick' ||
      row.type === 'character'
    ) {
      await requeueJob(row);
      stats.requeued++;
    } else {
      const message = 'Interrupted by a restart. Use Retry to run it again.';
      await db
        .update(jobs)
        .set({ status: 'failed', error: message, finishedAt: new Date() })
        .where(inArray(jobs.id, [row.id]));
      await HANDLERS[row.type as JobType]?.onFailure?.(row, message).catch(() => undefined);
      stats.failed++;
    }
  }
  log.info(stats, 'job recovery complete');
  return stats;
}
