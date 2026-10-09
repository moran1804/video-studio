import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { brands } from '@studio/core/db/schema';
import { createAsset } from '@studio/core/jobs/context';
import { BRAND_ASSET_ROLE_IDS, LOGO_ROLES, type BrandAssetRole } from '@studio/core/schemas';
import { UserFacingError } from '@studio/core/errors';
import { api } from '@/server/api';
import { receiveUpload } from '@/server/upload';
import { getBrandDetail, getBrandOr404 } from '@/server/data';

/** Upload a brand asset: logos, product / mood imagery or a guidelines document. */
export const POST = api<{ brandId: string }>(
  async (req, { params }) => {
    const brand = await getBrandOr404(params.brandId);
    const { fields, file } = await receiveUpload(req, {
      allowed: ['image', 'pdf', 'document'],
      relDir: path.posix.join('brands', brand.id),
      maxBytes: 100 * 1024 * 1024,
    });
    const isImage = file.sniff.cls === 'image';
    // 'auto' = let the design-system run work out what this is (logo, poster, product…).
    const auto = fields.role === 'auto';
    const role = (
      auto
        ? isImage
          ? 'auto'
          : 'guideline'
        : (BRAND_ASSET_ROLE_IDS as readonly string[]).includes(fields.role ?? '')
          ? fields.role
          : isImage
            ? 'other'
            : 'guideline'
    ) as BrandAssetRole | 'auto';
    if (!isImage && role !== 'guideline' && role !== 'other') {
      throw new UserFacingError('Logos and imagery must be image files (PNG, JPEG, WebP or GIF).');
    }
    const asset = await createAsset({
      brandId: brand.id,
      kind: 'brand_asset',
      relPath: file.relPath,
      mime: file.sniff.mime,
      originalName: file.originalName,
      meta: { role, label: (fields.label ?? '').slice(0, 120), notes: (fields.notes ?? '').slice(0, 500) },
    });
    // The first primary logo becomes the video overlay logo automatically.
    if (
      isImage &&
      role !== 'auto' &&
      LOGO_ROLES.includes(role) &&
      (!brand.logoAssetId || role === 'logo-primary')
    ) {
      if (!brand.logoAssetId || fields.setOverlay === 'true' || role === 'logo-primary') {
        await getDb()
          .update(brands)
          .set({ logoAssetId: asset.id, updatedAt: new Date() })
          .where(eq(brands.id, brand.id));
      }
    }
    return { brand: await getBrandDetail(brand.id) };
  },
  { rateLimit: { bucket: 'upload', limit: 60, windowSec: 60 } },
);
