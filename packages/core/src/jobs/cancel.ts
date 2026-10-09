import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { jobs, projects, references, renders, scenes, type Job } from '../db/schema';
import { getQueue, type QueueName } from '../queues';

const ACTIVE = ['queued', 'running'];

/** Cancel a queued or running job. Running workers notice within a few seconds. */
export async function cancelJob(job: Job): Promise<void> {
  if (!ACTIVE.includes(job.status)) return;
  const db = getDb();
  await db
    .update(jobs)
    .set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(jobs.id, job.id));
  if (job.bullJobId) {
    try {
      const bull = await getQueue(job.queue as QueueName).getJob(job.bullJobId);
      const state = await bull?.getState();
      if (bull && state && ['waiting', 'delayed', 'prioritized'].includes(state)) await bull.remove();
    } catch {
      /* active jobs stop themselves */
    }
  }
  if (job.sceneId && job.type === 'generation')
    await db.update(scenes).set({ status: 'cancelled' }).where(eq(scenes.id, job.sceneId));
  if (job.renderId)
    await db
      .update(renders)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(eq(renders.id, job.renderId));
  if (job.referenceId)
    await db
      .update(references)
      .set({ analysisStatus: 'failed', error: 'Cancelled' })
      .where(eq(references.id, job.referenceId));
  if (job.type === 'brief' && job.projectId) {
    const [p] = await db.select().from(projects).where(eq(projects.id, job.projectId));
    if (p?.briefStatus === 'generating')
      await db
        .update(projects)
        .set({ briefStatus: p.brief ? 'draft' : 'none' })
        .where(eq(projects.id, p.id));
  }
}
