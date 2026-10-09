import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { assets, characters } from '@studio/core/db/schema';
import { deleteRel } from '@studio/core/storage';
import { api, parseJson } from '@/server/api';
import { getCharacterDetail, getCharacterOr404 } from '@/server/characters';

type P = { characterId: string };

export const GET = api<P>(async (_req, { params }) => ({
  character: await getCharacterDetail(params.characterId),
}));

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000),
    notes: z.string().trim().max(2000),
  })
  .partial();

export const PATCH = api<P>(async (req, { params }) => {
  const c = await getCharacterOr404(params.characterId);
  const input = await parseJson(req, patchSchema);
  await getDb()
    .update(characters)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(characters.id, c.id));
  return { character: await getCharacterDetail(c.id) };
});

export const DELETE = api<P>(async (_req, { params }) => {
  const c = await getCharacterOr404(params.characterId);
  const db = getDb();
  const owned = await db.select().from(assets).where(eq(assets.characterId, c.id));
  await db.delete(characters).where(eq(characters.id, c.id));
  for (const a of owned) await deleteRel(a.relPath);
  return { ok: true };
});
