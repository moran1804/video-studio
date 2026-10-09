import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { brands } from '@studio/core/db/schema';
import { createAsset } from '@studio/core/jobs/context';
import { api } from '@/server/api';
import { receiveUpload } from '@/server/upload';
import { getBrandDetail, getBrandOr404 } from '@/server/data';

type P = { brandId: string };

/**
 * Upload a primary logo and use it as the video overlay logo (PNG with
 * transparency recommended). Earlier logos stay in the brand's asset library.
 */
export const POST = api<P>(
  async (req, { params }) => {
    const brand = await getBrandOr404(params.brandId);
    const { file } = await receiveUpload(req, {
      allowed: ['image'],
      relDir: path.posix.join('brands', brand.id),
      maxBytes: 20 * 1024 * 1024,
    });
    const asset = await createAsset({
      brandId: brand.id,
      kind: 'brand_asset',
      relPath: file.relPath,
      mime: file.sniff.mime,
      originalName: file.originalName,
      meta: { role: 'logo-primary', label: 'Primary logo' },
    });
    await getDb()
      .update(brands)
      .set({ logoAssetId: asset.id, updatedAt: new Date() })
      .where(eq(brands.id, brand.id));
    return { brand: await getBrandDetail(brand.id) };
  },
  { rateLimit: { bucket: 'upload', limit: 60, windowSec: 60 } },
);

/** Stop overlaying a logo on videos (the asset itself is kept). */
export const DELETE = api<P>(async (_req, { params }) => {
  const brand = await getBrandOr404(params.brandId);
  await getDb()
    .update(brands)
    .set({ logoAssetId: null, updatedAt: new Date() })
    .where(eq(brands.id, brand.id));
  return { brand: await getBrandDetail(brand.id) };
});
