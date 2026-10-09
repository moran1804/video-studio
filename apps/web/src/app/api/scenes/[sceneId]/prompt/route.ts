import { enqueueJob } from '@studio/core/queues';
import { UserFacingError } from '@studio/core/errors';
import { getLlm } from '@studio/core/providers/registry';
import { api } from '@/server/api';
import { getSceneOr404 } from '@/server/data';
import { activeJobFor } from '@/server/jobs';

/** Ask the language model to rewrite the scene's video prompt. */
export const POST = api<{ sceneId: string }>(
  async (_req, { params }) => {
    const scene = await getSceneOr404(params.sceneId);
    if (await activeJobFor({ sceneId: scene.id, type: 'prompt' }))
      throw new UserFacingError('Prompt is already being regenerated.', 409, 'busy');
    await getLlm();
    const job = await enqueueJob({ type: 'prompt', projectId: scene.projectId, sceneId: scene.id });
    return { jobId: job.id };
  },
  { rateLimit: { bucket: 'llm', limit: 30, windowSec: 60 } },
);
