import { eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { references } from '@studio/core/db/schema';
import { enqueueJob } from '@studio/core/queues';
import { UserFacingError } from '@studio/core/errors';
import { api } from '@/server/api';
import { getProjectBundle, getReferenceOr404 } from '@/server/data';
import { activeJobFor } from '@/server/jobs';

export const POST = api<{ refId: string }>(
  async (_req, { params }) => {
    const ref = await getReferenceOr404(params.refId);
    if (await activeJobFor({ referenceId: ref.id }))
      throw new UserFacingError('Analysis is already running.', 409, 'busy');
    await getDb()
      .update(references)
      .set({ analysisStatus: 'queued', error: null })
      .where(eq(references.id, ref.id));
    await enqueueJob({ type: 'analysis', projectId: ref.projectId, referenceId: ref.id });
    return getProjectBundle(ref.projectId);
  },
  { rateLimit: { bucket: 'analysis', limit: 30, windowSec: 60 } },
);
