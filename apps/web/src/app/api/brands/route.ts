import { asc, inArray } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { assets, brands } from '@studio/core/db/schema';
import { brandInputSchema } from '@studio/core/schemas';
import { api, parseJson } from '@/server/api';
import { brandDTO } from '@/server/data';

export const GET = api(async () => {
  const db = getDb();
  const rows = await db.select().from(brands).orderBy(asc(brands.name));
  const logoIds = rows.map((b) => b.logoAssetId).filter((x): x is string => Boolean(x));
  const logos = logoIds.length ? await db.select().from(assets).where(inArray(assets.id, logoIds)) : [];
  const map = new Map(logos.map((l) => [l.id, l]));
  return { brands: rows.map((b) => brandDTO(b, b.logoAssetId ? map.get(b.logoAssetId) : null)) };
});

export const POST = api(async (req) => {
  const input = await parseJson(req, brandInputSchema);
  const [brand] = await getDb().insert(brands).values(input).returning();
  return { brand: brandDTO(brand!) };
});
