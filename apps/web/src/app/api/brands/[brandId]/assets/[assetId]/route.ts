import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { assets, brands } from '@studio/core/db/schema';
import { BRAND_ASSET_ROLE_IDS } from '@studio/core/schemas';
import { deleteRel } from '@studio/core/storage';
import { NotFoundError } from '@studio/core/errors';
import { api, parseJson } from '@/server/api';
import { getAssetOr404, getBrandDetail, getBrandOr404 } from '@/server/data';

type P = { brandId: string; assetId: string };

async function load(params: P) {
  const brand = await getBrandOr404(params.brandId);
  const asset = await getAssetOr404(params.assetId);
  if (asset.brandId !== brand.id) throw new NotFoundError('Brand asset');
  return { brand, asset };
}

export const PATCH = api<P>(async (req, { params }) => {
  const { brand, asset } = await load(params);
  const input = await parseJson(
    req,
    z
      .object({
        role: z.enum(BRAND_ASSET_ROLE_IDS),
        label: z.string().trim().max(120),
        notes: z.string().trim().max(500),
      })
      .partial(),
  );
  await getDb()
    .update(assets)
    .set({ meta: { ...asset.meta, ...input } })
    .where(eq(assets.id, asset.id));
  return { brand: await getBrandDetail(brand.id) };
});

export const DELETE = api<P>(async (_req, { params }) => {
  const { brand, asset } = await load(params);
  const db = getDb();
  if (brand.logoAssetId === asset.id)
    await db.update(brands).set({ logoAssetId: null }).where(eq(brands.id, brand.id));
  await db.delete(assets).where(eq(assets.id, asset.id));
  await deleteRel(asset.relPath);
  return { brand: await getBrandDetail(brand.id) };
});
