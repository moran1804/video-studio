import { eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { projects } from '@studio/core/db/schema';
import { enqueueJob } from '@studio/core/queues';
import { UserFacingError } from '@studio/core/errors';
import { getLlm } from '@studio/core/providers/registry';
import { api } from '@/server/api';
import { getProjectOr404 } from '@/server/data';
import { activeJobFor } from '@/server/jobs';

export const POST = api<{ id: string }>(
  async (_req, { params }) => {
    const project = await getProjectOr404(params.id);
    if (await activeJobFor({ projectId: project.id, type: 'brief' }))
      throw new UserFacingError('A brief is already being generated.', 409, 'busy');
    await getLlm(); // fail fast when OpenAI is not configured
    await getDb()
      .update(projects)
      .set({ briefStatus: 'generating', updatedAt: new Date() })
      .where(eq(projects.id, project.id));
    const job = await enqueueJob({ type: 'brief', projectId: project.id });
    return { jobId: job.id };
  },
  { rateLimit: { bucket: 'llm', limit: 30, windowSec: 60 } },
);
