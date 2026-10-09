import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { assets } from '@studio/core/db/schema';
import { CHARACTER_UPLOAD_ROLE_IDS } from '@studio/core/schemas';
import { deleteRel } from '@studio/core/storage';
import { NotFoundError, UserFacingError } from '@studio/core/errors';
import { api, parseJson } from '@/server/api';
import { getAssetOr404 } from '@/server/data';
import { getCharacterDetail, getCharacterOr404 } from '@/server/characters';

type P = { characterId: string; assetId: string };

async function load(params: P) {
  const c = await getCharacterOr404(params.characterId);
  const a = await getAssetOr404(params.assetId);
  if (a.characterId !== c.id) throw new NotFoundError('Character image');
  return { c, a };
}

/** Change an upload's type, or approve / un-approve a generated reference. */
export const PATCH = api<P>(async (req, { params }) => {
  const { c, a } = await load(params);
  const input = await parseJson(
    req,
    z.object({ role: z.enum(CHARACTER_UPLOAD_ROLE_IDS).optional(), approved: z.boolean().optional() }),
  );
  if (input.role && a.kind !== 'character_upload') throw new UserFacingError('Only uploads have a type.');
  if (input.approved !== undefined && a.kind !== 'character_ref')
    throw new UserFacingError('Only generated references can be approved.');
  await getDb()
    .update(assets)
    .set({ meta: { ...a.meta, ...input } })
    .where(eq(assets.id, a.id));
  return { character: await getCharacterDetail(c.id) };
});

export const DELETE = api<P>(async (_req, { params }) => {
  const { c, a } = await load(params);
  await getDb().delete(assets).where(eq(assets.id, a.id));
  await deleteRel(a.relPath);
  return { character: await getCharacterDetail(c.id) };
});
