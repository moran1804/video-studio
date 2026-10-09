import { z } from 'zod';
import { enqueueJob } from '@studio/core/queues';
import { getImageProvider } from '@studio/core/providers/registry';
import { LOOK_IDS } from '@studio/core/schemas';
import { UserFacingError } from '@studio/core/errors';
import { api, parseJson } from '@/server/api';
import { characterBusy, getCharacterDetail, getCharacterOr404 } from '@/server/characters';

/** Make a still of the character in a scene to check the likeness (Nano Banana Pro). */
export const POST = api<{ characterId: string }>(
  async (req, { params }) => {
    const c = await getCharacterOr404(params.characterId);
    const input = await parseJson(
      req,
      z.object({
        scene: z.string().trim().min(3, 'Describe the scene').max(500),
        look: z.enum(LOOK_IDS).default('ugc'),
        aspectRatio: z.enum(['9:16', '16:9', '1:1', '4:5']).default('9:16'),
      }),
    );
    if (await characterBusy(c.id))
      throw new UserFacingError('Wait for the current job to finish.', 409, 'busy');
    await getImageProvider();
    await enqueueJob({ type: 'character', payload: { characterId: c.id, mode: 'test', ...input } });
    return { character: await getCharacterDetail(c.id) };
  },
  { rateLimit: { bucket: 'llm', limit: 20, windowSec: 60 } },
);
