import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { renders, scenes } from '@studio/core/db/schema';
import { enqueueJob } from '@studio/core/queues';
import { renderDimensions } from '@studio/core/jobs/render';
import { UserFacingError } from '@studio/core/errors';
import type { AspectRatio } from '@studio/core/schemas';
import { api, parseJson } from '@/server/api';
import { getProjectBundle, getProjectOr404 } from '@/server/data';
import { activeJobFor } from '@/server/jobs';

export const POST = api<{ id: string }>(
  async (req, { params }) => {
    const project = await getProjectOr404(params.id);
    const { mode } = await parseJson(req, z.object({ mode: z.enum(['preview', 'final']) }));
    const list = await getDb()
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, project.id))
      .orderBy(asc(scenes.position));
    if (!list.length) throw new UserFacingError('Create a storyboard first.');
    const missing = list.filter((s) => !s.clipAssetId).map((s) => s.position + 1);
    if (missing.length)
      throw new UserFacingError(
        `Scenes ${missing.join(', ')} have no footage yet. Generate or upload clips first.`,
      );
    if (await activeJobFor({ projectId: project.id, type: 'render' }))
      throw new UserFacingError('A render is already in progress.', 409, 'busy');
    const dims = renderDimensions(project.aspectRatio as AspectRatio, mode);
    const [render] = await getDb()
      .insert(renders)
      .values({ projectId: project.id, mode, status: 'queued', width: dims.width, height: dims.height })
      .returning();
    await enqueueJob({ type: 'render', projectId: project.id, renderId: render!.id });
    return getProjectBundle(project.id);
  },
  { rateLimit: { bucket: 'render', limit: 20, windowSec: 60 } },
);
