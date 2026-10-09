import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { assets, characters } from '@studio/core/db/schema';
import { enqueueJob } from '@studio/core/queues';
import { getImageProvider, getLlm } from '@studio/core/providers/registry';
import { CHARACTER_REF_ROLES } from '@studio/core/schemas';
import { UserFacingError } from '@studio/core/errors';
import { api } from '@/server/api';
import { characterBusy, getCharacterDetail, getCharacterOr404 } from '@/server/characters';

const REF_IDS = CHARACTER_REF_ROLES.map((r) => r.id) as [string, ...string[]];

/**
 * Prepare a character: describe it and generate clean face / full-body references.
 * With { role }, regenerate just that reference.
 */
export const POST = api<{ characterId: string }>(
  async (req, { params }) => {
    const c = await getCharacterOr404(params.characterId);
    const text = await req.text();
    let raw: unknown = {};
    try {
      raw = text ? JSON.parse(text) : {};
    } catch {
      throw new UserFacingError('Invalid JSON body');
    }
    const parsed = z.object({ role: z.enum(REF_IDS).optional() }).safeParse(raw);
    if (!parsed.success) throw new UserFacingError('Unknown reference type');
    if (await characterBusy(c.id))
      throw new UserFacingError('The character is already being prepared.', 409, 'busy');
    const uploads = await getDb().select({ id: assets.id }).from(assets).where(eq(assets.characterId, c.id));
    if (!uploads.length) throw new UserFacingError('Upload at least one image of the character first.');
    // Fail fast when the models are not configured.
    await getImageProvider();
    if (!parsed.data.role) await getLlm();
    await getDb()
      .update(characters)
      .set({ status: 'preparing', updatedAt: new Date() })
      .where(eq(characters.id, c.id));
    await enqueueJob({
      type: 'character',
      payload: parsed.data.role
        ? { characterId: c.id, mode: 'ref', role: parsed.data.role }
        : { characterId: c.id, mode: 'prepare' },
    });
    return { character: await getCharacterDetail(c.id) };
  },
  { rateLimit: { bucket: 'llm', limit: 20, windowSec: 60 } },
);
