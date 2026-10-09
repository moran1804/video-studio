import { eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { jobs } from '@studio/core/db/schema';
import { NotFoundError } from '@studio/core/errors';
import { isUuid } from '@studio/core/security/paths';
import { api } from '@/server/api';
import { jobDTO } from '@/server/data';
import { retryJob } from '@/server/jobs';

export const POST = api<{ jobId: string }>(async (_req, { params }) => {
  if (!isUuid(params.jobId)) throw new NotFoundError('Job');
  const [job] = await getDb().select().from(jobs).where(eq(jobs.id, params.jobId));
  if (!job) throw new NotFoundError('Job');
  return { job: jobDTO(await retryJob(job)) };
});
