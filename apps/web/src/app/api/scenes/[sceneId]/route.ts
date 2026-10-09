import { asc, eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { assets, scenes } from '@studio/core/db/schema';
import { UserFacingError } from '@studio/core/errors';
import { sceneUpdateSchema } from '@studio/core/schemas';
import { api, parseJson } from '@/server/api';
import { getProjectBundle, getSceneOr404, touchProject } from '@/server/data';
import { activeJobFor, cancelJob } from '@/server/jobs';

type P = { sceneId: string };

export const PATCH = api<P>(async (req, { params }) => {
  const scene = await getSceneOr404(params.sceneId);
  const patch = await parseJson(req, sceneUpdateSchema);
  if (patch.animateAssetId) {
    const [asset] = await getDb().select().from(assets).where(eq(assets.id, patch.animateAssetId));
    if (!asset || asset.projectId !== scene.projectId || !asset.mime.startsWith('image/')) {
      throw new UserFacingError('Choose an image uploaded to this project to animate.');
    }
  }
  await getDb()
    .update(scenes)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(scenes.id, scene.id));
  await touchProject(scene.projectId);
  return getProjectBundle(scene.projectId);
});

export const DELETE = api<P>(async (_req, { params }) => {
  const scene = await getSceneOr404(params.sceneId);
  const active = await activeJobFor({ sceneId: scene.id });
  if (active) await cancelJob(active);
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(scenes).where(eq(scenes.id, scene.id));
    const after = await tx
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, scene.projectId))
      .orderBy(asc(scenes.position));
    for (const s of after.filter((x) => x.position > scene.position)) {
      await tx
        .update(scenes)
        .set({ position: s.position - 1 })
        .where(eq(scenes.id, s.id));
    }
  });
  await touchProject(scene.projectId);
  return getProjectBundle(scene.projectId);
});
