import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { jobs, renders } from '@studio/core/db/schema';
import { NotFoundError } from '@studio/core/errors';
import { isUuid } from '@studio/core/security/paths';
import { api } from '@/server/api';
import { getProjectBundle } from '@/server/data';
import { retryJob } from '@/server/jobs';

export const POST = api<{ renderId: string }>(async (_req, { params }) => {
  if (!isUuid(params.renderId)) throw new NotFoundError('Render');
  const db = getDb();
  const [render] = await db.select().from(renders).where(eq(renders.id, params.renderId));
  if (!render) throw new NotFoundError('Render');
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.renderId, render.id), eq(jobs.type, 'render')))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  if (!job) throw new NotFoundError('Render job');
  await retryJob(job);
  return getProjectBundle(render.projectId);
});
