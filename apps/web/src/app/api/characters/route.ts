import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { characters } from '@studio/core/db/schema';
import { api, parseJson } from '@/server/api';
import { getCharacterDetail, listCharacters } from '@/server/characters';

export const GET = api(async () => ({ characters: await listCharacters() }));

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the character a name').max(120),
  notes: z.string().trim().max(2000).default(''),
  consent: z.literal(true, {
    message: 'Confirm the character is a fictional adult, or that you have permission from the person shown.',
  }),
});

/** Create a virtual character (uploads and preparation follow). */
export const POST = api(async (req) => {
  const input = await parseJson(req, createSchema);
  const [row] = await getDb()
    .insert(characters)
    .values({ name: input.name, notes: input.notes, consent: true })
    .returning();
  return { character: await getCharacterDetail(row!.id) };
});
