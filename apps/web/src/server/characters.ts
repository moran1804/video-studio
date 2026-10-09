import 'server-only';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { assets, characters, jobs, type Asset, type Character } from '@studio/core/db/schema';
import { NotFoundError } from '@studio/core/errors';
import { isUuid } from '@studio/core/security/paths';
import type { CharacterAssetDTO, CharacterDetailDTO, CharacterDTO } from '@/lib/types';
import { assetDTO, jobDTO } from './data';

export async function getCharacterOr404(id: string): Promise<Character> {
  if (!isUuid(id)) throw new NotFoundError('Character');
  const [c] = await getDb().select().from(characters).where(eq(characters.id, id));
  if (!c) throw new NotFoundError('Character');
  return c;
}

const charAsset = (a: Asset): CharacterAssetDTO => ({
  ...assetDTO(a)!,
  role: String(a.meta?.role ?? 'other'),
  approved: Boolean(a.meta?.approved),
});

function pickAvatar(list: Asset[]): Asset | null {
  const refs = list.filter((a) => a.kind === 'character_ref');
  return (
    refs.find((a) => a.meta?.role === 'ref-face' && a.meta?.approved) ??
    refs.find((a) => a.meta?.role === 'ref-face') ??
    list.find((a) => a.kind === 'character_upload' && a.mime.startsWith('image/')) ??
    null
  );
}

export function characterDTO(c: Character, list: Asset[]): CharacterDTO {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    notes: c.notes,
    status: c.status,
    consent: c.consent,
    avatar: assetDTO(pickAvatar(list)),
    createdAt: c.createdAt.toISOString(),
  };
}

export async function listCharacters(): Promise<CharacterDTO[]> {
  const db = getDb();
  const rows = await db.select().from(characters).orderBy(desc(characters.createdAt));
  if (!rows.length) return [];
  const list = await db
    .select()
    .from(assets)
    .where(
      inArray(
        assets.characterId,
        rows.map((r) => r.id),
      ),
    );
  return rows.map((c) =>
    characterDTO(
      c,
      list.filter((a) => a.characterId === c.id),
    ),
  );
}

export async function getCharacterDetail(id: string): Promise<CharacterDetailDTO> {
  const c = await getCharacterOr404(id);
  const db = getDb();
  const list = (await db.select().from(assets).where(eq(assets.characterId, c.id))).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, 'character'), sql`${jobs.payload}->>'characterId' = ${c.id}`))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return {
    ...characterDTO(c, list),
    uploads: list.filter((a) => a.kind === 'character_upload').map(charAsset),
    references: list.filter((a) => a.kind === 'character_ref').map(charAsset),
    testShots: list
      .filter((a) => a.kind === 'character_test')
      .map(charAsset)
      .reverse()
      .slice(0, 6),
    job: job ? jobDTO(job) : null,
  };
}

/** True while a character job (prepare / reference / test shot) is queued or running. */
export async function characterBusy(id: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, 'character'),
        inArray(jobs.status, ['queued', 'running']),
        sql`${jobs.payload}->>'characterId' = ${id}`,
      ),
    );
  return Boolean(row);
}
