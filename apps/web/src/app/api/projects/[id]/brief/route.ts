import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { projects } from '@studio/core/db/schema';
import { briefSchema } from '@studio/core/schemas';
import { api, parseJson } from '@/server/api';
import { getProjectBundle, getProjectOr404 } from '@/server/data';

/** Save user edits to the brief. Editing an approved brief returns it to draft. */
export const PATCH = api<{ id: string }>(async (req, { params }) => {
  await getProjectOr404(params.id);
  const { brief } = await parseJson(req, z.object({ brief: briefSchema }));
  await getDb()
    .update(projects)
    .set({ brief, briefStatus: 'draft', updatedAt: new Date() })
    .where(eq(projects.id, params.id));
  return getProjectBundle(params.id);
});
