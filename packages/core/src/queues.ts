import { Queue, type JobsOptions } from 'bullmq';
import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { jobs, type Job } from './db/schema';
import { createRedis } from './redis';

export const QUEUE_NAMES = ['analysis', 'llm', 'generation', 'voiceover', 'render', 'pipeline'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export type JobType =
  | 'analysis'
  | 'brief'
  | 'storyboard'
  | 'prompt'
  | 'brand'
  | 'character'
  | 'generation'
  | 'voiceover'
  | 'transcribe'
  | 'render'
  | 'quick';

export const JOB_QUEUE: Record<JobType, QueueName> = {
  analysis: 'analysis',
  brief: 'llm',
  storyboard: 'llm',
  prompt: 'llm',
  brand: 'llm',
  character: 'llm',
  generation: 'generation',
  voiceover: 'voiceover',
  transcribe: 'voiceover',
  render: 'render',
  quick: 'pipeline',
};

const MAX_ATTEMPTS: Record<JobType, number> = {
  analysis: 2,
  brief: 3,
  storyboard: 3,
  prompt: 3,
  brand: 3,
  character: 2,
  generation: 4,
  voiceover: 3,
  transcribe: 3,
  render: 2,
  quick: 3,
};

export interface QueuePayload {
  jobId: string;
}

const g = globalThis as unknown as { __studioQueues?: Map<QueueName, Queue<QueuePayload>> };

export function getQueue(name: QueueName): Queue<QueuePayload> {
  if (!g.__studioQueues) g.__studioQueues = new Map();
  let q = g.__studioQueues.get(name);
  if (!q) {
    q = new Queue<QueuePayload>(name, { connection: createRedis(), prefix: 'studio' });
    g.__studioQueues.set(name, q);
  }
  return q;
}

export async function closeQueues(): Promise<void> {
  for (const q of g.__studioQueues?.values() ?? []) await q.close();
  g.__studioQueues = undefined;
}

export function bullJobOptions(type: JobType, bullJobId: string): JobsOptions {
  return {
    jobId: bullJobId,
    attempts: MAX_ATTEMPTS[type],
    backoff: { type: 'exponential', delay: type === 'generation' ? 15_000 : 5_000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 2000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 5000 },
  };
}

export interface EnqueueArgs {
  type: JobType;
  projectId?: string | null;
  sceneId?: string | null;
  referenceId?: string | null;
  renderId?: string | null;
  provider?: string | null;
  payload?: Record<string, unknown>;
}

/** Create a tracked job row and add it to its BullMQ queue. */
export async function enqueueJob(args: EnqueueArgs): Promise<Job> {
  const db = getDb();
  const [row] = await db
    .insert(jobs)
    .values({
      type: args.type,
      queue: JOB_QUEUE[args.type],
      projectId: args.projectId ?? null,
      sceneId: args.sceneId ?? null,
      referenceId: args.referenceId ?? null,
      renderId: args.renderId ?? null,
      provider: args.provider ?? null,
      payload: args.payload ?? {},
      maxAttempts: MAX_ATTEMPTS[args.type],
      status: 'queued',
    })
    .returning();
  const bullJobId = `${row!.id}-1`;
  await getQueue(JOB_QUEUE[args.type]).add(
    args.type,
    { jobId: row!.id },
    bullJobOptions(args.type, bullJobId),
  );
  const [updated] = await db.update(jobs).set({ bullJobId }).where(eq(jobs.id, row!.id)).returning();
  return updated!;
}

/**
 * Re-queue an existing job row (manual retry or restart recovery). A new
 * BullMQ job id is used so a stale failed job in Redis never blocks it.
 * Provider job ids are kept when `resume` is true so polling can continue.
 */
export async function requeueJob(job: Job, opts: { resume?: boolean } = {}): Promise<Job> {
  const db = getDb();
  const n = Number(job.bullJobId?.split('-').pop() ?? '1') + 1;
  const bullJobId = `${job.id}-${Number.isFinite(n) ? n : Date.now()}`;
  const [updated] = await db
    .update(jobs)
    .set({
      status: 'queued',
      error: null,
      progress: opts.resume ? job.progress : 0,
      attempts: 0,
      bullJobId,
      providerJobId: opts.resume ? job.providerJobId : null,
      updatedAt: new Date(),
      finishedAt: null,
    })
    .where(eq(jobs.id, job.id))
    .returning();
  await getQueue(job.queue as QueueName).add(
    job.type,
    { jobId: job.id },
    bullJobOptions(job.type as JobType, bullJobId),
  );
  return updated!;
}
