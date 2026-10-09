import { and, eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { assets, characters } from '@studio/core/db/schema';
import { UserFacingError } from '@studio/core/errors';
import { api } from '@/server/api';
import { getCharacterDetail, getCharacterOr404 } from '@/server/characters';

/** Approve the current references: the character becomes ready for videos. */
export const POST = api<{ characterId: string }>(async (_req, { params }) => {
  const c = await getCharacterOr404(params.characterId);
  const db = getDb();
  const refs = await db
    .select()
    .from(assets)
    .where(and(eq(assets.characterId, c.id), eq(assets.kind, 'character_ref')));
  if (!refs.length) throw new UserFacingError('Prepare the character references first.');
  for (const r of refs)
    await db
      .update(assets)
      .set({ meta: { ...r.meta, approved: true } })
      .where(eq(assets.id, r.id));
  await db.update(characters).set({ status: 'ready', updatedAt: new Date() }).where(eq(characters.id, c.id));
  return { character: await getCharacterDetail(c.id) };
});
