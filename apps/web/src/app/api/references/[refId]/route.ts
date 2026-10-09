import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { assets, references } from '@studio/core/db/schema';
import { REFERENCE_CATEGORIES, REFERENCE_USAGES } from '@studio/core/schemas';
import { UserFacingError } from '@studio/core/errors';
import { deleteRel } from '@studio/core/storage';
import { api, parseJson } from '@/server/api';
import { getProjectBundle, getReferenceOr404, touchProject } from '@/server/data';
import { activeJobFor, cancelJob } from '@/server/jobs';

type P = { refId: string };

const patchSchema = z
  .object({
    title: z.string().trim().max(300),
    notes: z.string().trim().max(2000),
    category: z.enum(REFERENCE_CATEGORIES),
    usage: z.enum(REFERENCE_USAGES),
  })
  .partial();

export const PATCH = api<P>(async (req, { params }) => {
  const ref = await getReferenceOr404(params.refId);
  const patch = await parseJson(req, patchSchema);
  if (patch.usage === 'animate') {
    const [asset] = ref.assetId ? await getDb().select().from(assets).where(eq(assets.id, ref.assetId)) : [];
    if (!asset?.mime.startsWith('image/')) throw new UserFacingError('Only uploaded images can be animated.');
    if (!patch.category && !['image', 'logo', 'poster', 'artwork'].includes(ref.category))
      patch.category = 'artwork';
  }
  await getDb().update(references).set(patch).where(eq(references.id, ref.id));
  await touchProject(ref.projectId);
  return getProjectBundle(ref.projectId);
});

export const DELETE = api<P>(async (_req, { params }) => {
  const ref = await getReferenceOr404(params.refId);
  const job = await activeJobFor({ referenceId: ref.id });
  if (job) await cancelJob(job);
  const db = getDb();
  const ids = [ref.assetId, ...(ref.analysis?.frames ?? []), ref.thumbnailAssetId].filter((x): x is string =>
    Boolean(x),
  );
  const rows = ids.length ? await db.select().from(assets).where(inArray(assets.id, ids)) : [];
  await db.delete(references).where(eq(references.id, ref.id));
  for (const a of rows) {
    if (a.projectId !== ref.projectId) continue;
    await deleteRel(a.relPath);
    await db.delete(assets).where(eq(assets.id, a.id));
  }
  await touchProject(ref.projectId);
  return getProjectBundle(ref.projectId);
});
