import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { scenes } from '@studio/core/db/schema';
import { getDefaults } from '@studio/core/settings';
import { api, parseJson } from '@/server/api';
import { getProjectBundle, getProjectOr404, touchProject } from '@/server/data';

/** Add a blank scene at the end or after a given position. */
export const POST = api<{ id: string }>(async (req, { params }) => {
  const project = await getProjectOr404(params.id);
  const { afterPosition } = await parseJson(
    req,
    z.object({ afterPosition: z.number().int().min(-1).optional() }),
  );
  const db = getDb();
  const defaults = await getDefaults();
  const list = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, project.id))
    .orderBy(asc(scenes.position));
  const insertAt = afterPosition === undefined ? list.length : Math.min(list.length, afterPosition + 1);
  await db.transaction(async (tx) => {
    for (const s of list.filter((x) => x.position >= insertAt)) {
      await tx
        .update(scenes)
        .set({ position: s.position + 1 })
        .where(eq(scenes.id, s.id));
    }
    await tx.insert(scenes).values({
      projectId: project.id,
      position: insertAt,
      purpose: 'New scene',
      durationSec: 4,
      provider: project.defaultProvider ?? defaults.videoProvider,
      transition: 'cut',
    });
  });
  await touchProject(project.id);
  return getProjectBundle(project.id);
});
