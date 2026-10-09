import 'server-only';
import { eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { brands } from '@studio/core/db/schema';
import { captionSettingsSchema, paletteColor, type CaptionSettings } from '@studio/core/schemas';

/**
 * Captions follow the brand when a project selects it: the design system's
 * caption font and accent colour (for word highlighting) become the defaults.
 */
export async function brandCaptionDefaults(
  brandId: string | null | undefined,
  current: unknown,
): Promise<CaptionSettings> {
  const base = captionSettingsSchema.parse(current ?? {});
  if (!brandId) return base;
  const [brand] = await getDb().select().from(brands).where(eq(brands.id, brandId));
  if (!brand) return base;
  const ds = brand.designSystem;
  return {
    ...base,
    font: ds?.typography.captionFont ?? base.font,
    highlightColor: paletteColor(ds, 'accent', brand.accentColor),
    preset: 'custom',
  };
}
