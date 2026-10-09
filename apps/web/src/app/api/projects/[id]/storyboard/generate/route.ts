import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { scenes } from '@studio/core/db/schema';
import { enqueueJob } from '@studio/core/queues';
import { UserFacingError } from '@studio/core/errors';
import { getLlm } from '@studio/core/providers/registry';
import { api, parseJson } from '@/server/api';
import { getProjectOr404 } from '@/server/data';
import { activeJobFor } from '@/server/jobs';

export const POST = api<{ id: string }>(
  async (req, { params }) => {
    const project = await getProjectOr404(params.id);
    const { replace } = await parseJson(req, z.object({ replace: z.boolean().default(false) }));
    if (project.briefStatus !== 'approved')
      throw new UserFacingError('Approve the creative brief before generating the storyboard.');
    if (await activeJobFor({ projectId: project.id, type: 'storyboard' }))
      throw new UserFacingError('A storyboard is already being generated.', 409, 'busy');
    if (await activeJobFor({ projectId: project.id, type: 'generation' }))
      throw new UserFacingError(
        'Wait for scene generation to finish (or cancel it) before replacing the storyboard.',
        409,
        'busy',
      );
    const [{ count }] = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(scenes)
      .where(eq(scenes.projectId, project.id));
    if (count > 0 && !replace)
      throw new UserFacingError(
        'This project already has a storyboard. Confirm to replace it.',
        409,
        'confirm_replace',
      );
    await getLlm();
    const job = await enqueueJob({ type: 'storyboard', projectId: project.id });
    return { jobId: job.id };
  },
  { rateLimit: { bucket: 'llm', limit: 30, windowSec: 60 } },
);
