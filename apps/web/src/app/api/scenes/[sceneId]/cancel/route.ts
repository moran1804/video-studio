import { UserFacingError } from '@studio/core/errors';
import { api } from '@/server/api';
import { getSceneOr404 } from '@/server/data';
import { activeJobFor, cancelJob } from '@/server/jobs';

export const POST = api<{ sceneId: string }>(async (_req, { params }) => {
  const scene = await getSceneOr404(params.sceneId);
  const job = await activeJobFor({ sceneId: scene.id, type: 'generation' });
  if (!job) throw new UserFacingError('Nothing to cancel.', 404, 'not_found');
  await cancelJob(job);
  return { ok: true };
});
