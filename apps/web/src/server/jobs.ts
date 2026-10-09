import 'server-only';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { jobs, projects, references, renders, scenes, type Job, type Scene } from '@studio/core/db/schema';
import { enqueueJob, requeueJob } from '@studio/core/queues';
import { UserFacingError } from '@studio/core/errors';
import type { ProviderId } from '@studio/core/providers/video/types';
import { getVideoProvider } from '@studio/core/providers/registry';

const ACTIVE = ['queued', 'running'];

export async function activeJobFor(where: {
  sceneId?: string;
  referenceId?: string;
  renderId?: string;
  projectId?: string;
  type?: string;
}): Promise<Job | undefined> {
  const conds = [inArray(jobs.status, ACTIVE)];
  if (where.sceneId) conds.push(eq(jobs.sceneId, where.sceneId));
  if (where.referenceId) conds.push(eq(jobs.referenceId, where.referenceId));
  if (where.renderId) conds.push(eq(jobs.renderId, where.renderId));
  if (where.projectId) conds.push(eq(jobs.projectId, where.projectId));
  if (where.type) conds.push(eq(jobs.type, where.type));
  const [row] = await getDb()
    .select()
    .from(jobs)
    .where(and(...conds))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return row;
}

export async function startGeneration(scene: Scene, providerOverride?: ProviderId): Promise<Job> {
  const existing = await activeJobFor({ sceneId: scene.id, type: 'generation' });
  if (existing) throw new UserFacingError('This scene is already generating.', 409, 'busy');
  const provider = (providerOverride ?? scene.provider) as ProviderId;
  if (!(scene.prompt || scene.visualDescription).trim())
    throw new UserFacingError(`Scene ${scene.position + 1} has no prompt.`);
  // Fail fast (before queueing) when the provider is not configured.
  await getVideoProvider(provider);
  await getDb()
    .update(scenes)
    .set({ status: 'queued', error: null, provider, updatedAt: new Date() })
    .where(eq(scenes.id, scene.id));
  return enqueueJob({ type: 'generation', projectId: scene.projectId, sceneId: scene.id, provider });
}

export { cancelJob } from '@studio/core/jobs/cancel';

/** Retry a failed / cancelled job and reset the state of the thing it works on. */
export async function retryJob(job: Job): Promise<Job> {
  if (ACTIVE.includes(job.status)) throw new UserFacingError('The job is still running.', 409, 'busy');
  const db = getDb();
  if (job.sceneId && job.type === 'generation') {
    await db.update(scenes).set({ status: 'queued', error: null }).where(eq(scenes.id, job.sceneId));
  }
  if (job.renderId)
    await db
      .update(renders)
      .set({ status: 'queued', progress: 0, error: null, finishedAt: null })
      .where(eq(renders.id, job.renderId));
  if (job.referenceId)
    await db
      .update(references)
      .set({ analysisStatus: 'queued', error: null })
      .where(eq(references.id, job.referenceId));
  if (job.type === 'brief' && job.projectId)
    await db.update(projects).set({ briefStatus: 'generating' }).where(eq(projects.id, job.projectId));
  // A fresh provider submission is needed after a provider-side failure.
  return requeueJob(job, { resume: false });
}
