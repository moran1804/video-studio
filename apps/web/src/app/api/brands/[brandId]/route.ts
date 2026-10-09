import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { assets, brands } from '@studio/core/db/schema';
import { brandInputSchema, designSystemSchema, paletteColor } from '@studio/core/schemas';
import { deleteRel } from '@studio/core/storage';
import { UserFacingError } from '@studio/core/errors';
import { api, parseJson } from '@/server/api';
import { getBrandDetail, getBrandOr404 } from '@/server/data';

type P = { brandId: string };

const patchSchema = brandInputSchema.partial().extend({
  designSystem: designSystemSchema.nullable().optional(),
  designStatus: z.enum(['none', 'draft', 'approved']).optional(),
  logoAssetId: z.string().uuid().nullable().optional(),
});

export const GET = api<P>(async (_req, { params }) => ({ brand: await getBrandDetail(params.brandId) }));

export const PATCH = api<P>(async (req, { params }) => {
  const brand = await getBrandOr404(params.brandId);
  const input = await parseJson(req, patchSchema);
  const db = getDb();
  if (input.logoAssetId) {
    const [a] = await db.select().from(assets).where(eq(assets.id, input.logoAssetId));
    if (!a || a.brandId !== brand.id || !a.mime.startsWith('image/')) {
      throw new UserFacingError('The overlay logo must be an image uploaded to this brand.');
    }
  }
  const update: Partial<typeof brands.$inferInsert> = { ...input, updatedAt: new Date() };
  // Keep the core brand tokens (used by overlays, cards and captions) in sync with the design system.
  const ds = input.designSystem;
  if (ds) {
    update.primaryColor = paletteColor(ds, 'primary', input.primaryColor ?? brand.primaryColor);
    update.secondaryColor = paletteColor(ds, 'secondary', input.secondaryColor ?? brand.secondaryColor);
    update.accentColor = paletteColor(ds, 'accent', input.accentColor ?? brand.accentColor);
    update.headingFont = ds.typography.headingFont;
    update.bodyFont = ds.typography.bodyFont;
    if (!input.designStatus && brand.designStatus === 'none') update.designStatus = 'draft';
  }
  await db.update(brands).set(update).where(eq(brands.id, brand.id));
  return { brand: await getBrandDetail(brand.id) };
});

export const DELETE = api<P>(async (_req, { params }) => {
  const b = await getBrandOr404(params.brandId);
  const db = getDb();
  const owned = await db.select().from(assets).where(eq(assets.brandId, b.id));
  await db.delete(brands).where(eq(brands.id, b.id));
  for (const a of owned) await deleteRel(a.relPath);
  return { ok: true };
});
