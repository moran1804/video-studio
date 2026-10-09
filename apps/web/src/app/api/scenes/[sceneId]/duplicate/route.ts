import { asc, eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { scenes } from '@studio/core/db/schema';
import { api } from '@/server/api';
import { getProjectBundle, getSceneOr404, touchProject } from '@/server/data';

/** Duplicate a scene (including its footage reference) directly after the original. */
export const POST = api<{ sceneId: string }>(async (_req, { params }) => {
  const s = await getSceneOr404(params.sceneId);
  const db = getDb();
  await db.transaction(async (tx) => {
    const list = await tx
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, s.projectId))
      .orderBy(asc(scenes.position));
    for (const x of list.filter((x) => x.position > s.position)) {
      await tx
        .update(scenes)
        .set({ position: x.position + 1 })
        .where(eq(scenes.id, x.id));
    }
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = s;
    await tx.insert(scenes).values({
      ...rest,
      position: s.position + 1,
      purpose: `${s.purpose} (copy)`,
      status: s.clipAssetId ? 'completed' : 'draft',
      error: null,
    });
  });
  await touchProject(s.projectId);
  return getProjectBundle(s.projectId);
});
