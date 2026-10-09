import { z } from 'zod';
import { api, parseJson } from '@/server/api';
import { getProjectBundle, getReferenceOr404 } from '@/server/data';
import { createAnimateScene } from '@/server/animate';

/** "Animate this image": add a scene that uses the uploaded image as its start frame. */
export const POST = api<{ refId: string }>(async (req, { params }) => {
  const ref = await getReferenceOr404(params.refId);
  const input = await parseJson(
    req,
    z.object({ prompt: z.string().max(4000).optional(), durationSec: z.number().min(1).max(30).optional() }),
  );
  const scene = await createAnimateScene(ref, input);
  return { sceneId: scene.id, ...(await getProjectBundle(ref.projectId)) };
});
