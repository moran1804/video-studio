import { eq, inArray } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { assets, renders } from '@studio/core/db/schema';
import { NotFoundError } from '@studio/core/errors';
import { isUuid } from '@studio/core/security/paths';
import { deleteRel } from '@studio/core/storage';
import { api } from '@/server/api';
import { getProjectBundle } from '@/server/data';
import { activeJobFor, cancelJob } from '@/server/jobs';

/** Delete a render and its files from the history. */
export const DELETE = api<{ renderId: string }>(async (_req, { params }) => {
  if (!isUuid(params.renderId)) throw new NotFoundError('Render');
  const db = getDb();
  const [render] = await db.select().from(renders).where(eq(renders.id, params.renderId));
  if (!render) throw new NotFoundError('Render');
  const job = await activeJobFor({ renderId: render.id });
  if (job) await cancelJob(job);
  const ids = [render.videoAssetId, render.srtAssetId, render.thumbnailAssetId].filter((x): x is string =>
    Boolean(x),
  );
  const rows = ids.length ? await db.select().from(assets).where(inArray(assets.id, ids)) : [];
  await db.delete(renders).where(eq(renders.id, render.id));
  for (const a of rows) {
    await deleteRel(a.relPath);
    await db.delete(assets).where(eq(assets.id, a.id));
  }
  return getProjectBundle(render.projectId);
});
