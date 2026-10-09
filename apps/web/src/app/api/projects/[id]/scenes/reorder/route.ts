import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { scenes } from '@studio/core/db/schema';
import { UserFacingError } from '@studio/core/errors';
import { api, parseJson } from '@/server/api';
import { getProjectBundle, getProjectOr404, touchProject } from '@/server/data';

export const POST = api<{ id: string }>(async (req, { params }) => {
  const project = await getProjectOr404(params.id);
  const { ids } = await parseJson(req, z.object({ ids: z.array(z.string().uuid()).max(200) }));
  const db = getDb();
  const existing = await db.select({ id: scenes.id }).from(scenes).where(eq(scenes.projectId, project.id));
  const set = new Set(existing.map((s) => s.id));
  if (ids.length !== set.size || !ids.every((id) => set.has(id)) || new Set(ids).size !== ids.length) {
    throw new UserFacingError('Scene list is out of date. Reload and try again.', 409, 'stale');
  }
  await db.transaction(async (tx) => {
    for (let i = 0; i < ids.length; i++)
      await tx.update(scenes).set({ position: i }).where(eq(scenes.id, ids[i]!));
  });
  await touchProject(project.id);
  return getProjectBundle(project.id);
});
