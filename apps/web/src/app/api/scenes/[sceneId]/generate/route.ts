import { z } from 'zod';
import { VIDEO_PROVIDERS } from '@studio/core/schemas';
import { api, parseJson } from '@/server/api';
import { getSceneOr404 } from '@/server/data';
import { startGeneration } from '@/server/jobs';

/** Generate (or regenerate) footage for one scene. */
export const POST = api<{ sceneId: string }>(
  async (req, { params }) => {
    const scene = await getSceneOr404(params.sceneId);
    const { provider } = await parseJson(req, z.object({ provider: z.enum(VIDEO_PROVIDERS).optional() }));
    const job = await startGeneration(scene, provider);
    return { jobId: job.id };
  },
  { rateLimit: { bucket: 'generate', limit: 30, windowSec: 60 } },
);
