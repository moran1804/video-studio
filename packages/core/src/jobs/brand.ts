import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, brands, type Asset, type Brand } from '../db/schema';
import { UserFacingError } from '../errors';
import { getLlm } from '../providers/registry';
import { buildBrandGuide } from '../brand';
import { isUuid } from '../security/paths';
import { absPath, makeTempDir, removeTempDir } from '../storage';
import { extractPalette, makeThumbnail } from '../ffmpeg/analyze';
import { BRAND_IMAGERY_ROLES, LOGO_ROLES, paletteColor, type BrandAssetRole } from '../schemas';
import type { BrandProfileDraft } from '../providers/llm/openai';
import { analyzeDocument } from './analysis';
import type { FailureHook, JobHandler } from './context';

export const assetRole = (a: Asset): BrandAssetRole =>
  (a.meta?.role as BrandAssetRole | undefined) ?? (a.kind === 'logo' ? 'logo-primary' : 'other');

export interface BrandContext {
  brand: Brand;
  assets: Asset[];
  guide: string;
  /** Product / mood images usable as a fallback reference image. */
  imagery: Asset[];
}

/** Load a brand, its assets and the rendered design-system guide for AI prompts. */
export async function loadBrandContext(brandId: string | null | undefined): Promise<BrandContext | null> {
  if (!brandId) return null;
  const db = getDb();
  const [brand] = await db.select().from(brands).where(eq(brands.id, brandId));
  if (!brand) return null;
  const list = await db.select().from(assets).where(eq(assets.brandId, brand.id));
  const guide = buildBrandGuide({
    name: brand.name,
    defaultCta: brand.defaultCta,
    handles: brand.handles,
    introText: brand.introText,
    outroText: brand.outroText,
    colors: { primary: brand.primaryColor, secondary: brand.secondaryColor, accent: brand.accentColor },
    fonts: { heading: brand.headingFont, body: brand.bodyFont },
    designSystem: brand.designSystem ?? null,
    assets: list.map((a) => ({
      role: assetRole(a),
      label: String(a.meta?.label ?? a.originalName ?? ''),
      notes: String(a.meta?.notes ?? ''),
    })),
  });
  const imagery = list.filter(
    (a) => a.mime.startsWith('image/') && BRAND_IMAGERY_ROLES.includes(assetRole(a)),
  );
  return { brand, assets: list, guide, imagery };
}

const ROLE_ORDER: BrandAssetRole[] = [...LOGO_ROLES, 'product', 'mood', 'poster', 'other'];

/** Placeholder name used by the upload-first "New brand" flow until the AI suggests one. */
export const PLACEHOLDER_BRAND_NAME = 'New brand';

export interface BrandInference {
  profile: BrandProfileDraft;
  /** Role per classified image, aligned with `imageIds`. */
  roles: string[];
  imageIds: string[];
}

/**
 * Work out what to write back after a design-system run: roles for assets the
 * user left on "auto", the overlay logo, and profile fields. Never overwrites
 * values the user set: the name is only replaced while it is the placeholder.
 */
export function planBrandUpdates(
  brand: Pick<Brand, 'name' | 'logoAssetId' | 'defaultCta' | 'introText' | 'outroText' | 'handles'>,
  assets: Pick<Asset, 'id' | 'mime' | 'meta'>[],
  inf: BrandInference,
) {
  const roleUpdates = new Map<string, string>();
  for (const a of assets) {
    if (a.meta?.role !== 'auto') continue;
    const i = inf.imageIds.indexOf(a.id);
    if (i >= 0 && inf.roles[i]) roleUpdates.set(a.id, inf.roles[i]!);
    else roleUpdates.set(a.id, a.mime.startsWith('image/') ? 'mood' : 'guideline');
  }
  const roleOf = (a: Pick<Asset, 'id' | 'meta'>) => roleUpdates.get(a.id) ?? String(a.meta?.role ?? '');
  let logoAssetId = brand.logoAssetId;
  if (!logoAssetId) {
    const images = assets.filter((a) => a.mime.startsWith('image/'));
    logoAssetId =
      images.find((a) => roleOf(a) === 'logo-primary')?.id ??
      images.find((a) => roleOf(a).startsWith('logo-'))?.id ??
      null;
  }
  const p = inf.profile;
  const patch: Partial<Pick<Brand, 'name' | 'defaultCta' | 'introText' | 'outroText' | 'handles'>> = {};
  if (p.name && (!brand.name.trim() || brand.name === PLACEHOLDER_BRAND_NAME)) patch.name = p.name;
  if (p.defaultCta && !brand.defaultCta) patch.defaultCta = p.defaultCta;
  if (p.introText && !brand.introText) patch.introText = p.introText;
  if (p.outroText && !brand.outroText) patch.outroText = p.outroText;
  const handles = { ...brand.handles };
  let changed = false;
  for (const [k, v] of Object.entries(p.handles)) {
    if (v && !handles[k]) {
      handles[k] = v;
      changed = true;
    }
  }
  if (changed) patch.handles = handles;
  return { roleUpdates, logoAssetId, patch };
}

/** Generate a design system from the brand's uploaded logos, imagery and guideline documents. */
export const brandDesignJob: JobHandler = async (ctx) => {
  const payload = ctx.job.payload as { brandId?: string; mode?: string; notes?: string };
  const brandId = payload.brandId;
  const mode = payload.mode === 'create' ? 'create' : 'refresh';
  if (!isUuid(brandId)) throw new UserFacingError('Job has no brand');
  const loaded = await loadBrandContext(brandId);
  if (!loaded) throw new UserFacingError('Brand no longer exists');
  const { brand, assets: list } = loaded;
  const llm = await getLlm();
  const tempDir = await makeTempDir('brand');
  try {
    const images = list
      .filter((a) => a.mime.startsWith('image/'))
      .sort((a, b) => ROLE_ORDER.indexOf(assetRole(a)) - ROLE_ORDER.indexOf(assetRole(b)))
      .slice(0, 8);
    const thumbs: string[] = [];
    const imageIds: string[] = [];
    for (const a of images) {
      const out = path.join(tempDir, `${a.id}.jpg`);
      try {
        await makeThumbnail(absPath(a.relPath), out, 0, 768);
        thumbs.push(out);
        imageIds.push(a.id);
      } catch {
        /* skip unreadable image */
      }
    }
    await ctx.setProgress(0.3);
    const paletteHints = thumbs.length ? await extractPalette(thumbs, 8) : [];

    let documents = '';
    for (const a of list.filter((x) => x.mime === 'application/pdf' || x.mime.startsWith('text/'))) {
      try {
        const doc = await analyzeDocument(absPath(a.relPath), a.mime);
        if (doc.text) documents += `\n--- ${a.originalName ?? 'document'} ---\n${doc.text}`;
      } catch {
        /* skip */
      }
      if (documents.length > 20_000) break;
    }
    await ctx.setProgress(0.5);

    const result = await llm.generateDesignSystem({
      brandName: brand.name === PLACEHOLDER_BRAND_NAME ? '' : brand.name,
      notes: payload.notes,
      imageRoles: imageIds.map((id) => String(images.find((a) => a.id === id)?.meta?.role ?? 'auto')),
      existing: loaded.guide,
      documents: documents.slice(0, 20_000),
      paletteHints,
      assets: list.map((a) => ({ role: assetRole(a), label: String(a.meta?.label ?? a.originalName ?? '') })),
      images: await Promise.all(thumbs.map((t) => fs.readFile(t))),
    });
    const { designSystem, usage } = result;
    const db = getDb();
    const { roleUpdates, logoAssetId, patch } = planBrandUpdates(brand, list, {
      profile: result.profile,
      roles: result.assetRoles,
      imageIds,
    });
    for (const [id, role] of roleUpdates) {
      const a = list.find((x) => x.id === id)!;
      await db
        .update(assets)
        .set({ meta: { ...a.meta, role } })
        .where(eq(assets.id, id));
    }
    await db
      .update(brands)
      .set({
        ...patch,
        designSystem,
        designStatus: 'draft',
        logoAssetId,
        // Keep the core tokens used by overlays and cards in sync with the new palette.
        primaryColor: paletteColor(designSystem, 'primary', brand.primaryColor),
        secondaryColor: paletteColor(designSystem, 'secondary', brand.secondaryColor),
        accentColor: paletteColor(designSystem, 'accent', brand.accentColor),
        headingFont: designSystem.typography.headingFont,
        bodyFont: designSystem.typography.bodyFont,
        updatedAt: new Date(),
      })
      .where(eq(brands.id, brand.id));
    if (usage)
      await ctx.update({ usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } });
    return {
      images: thumbs.length,
      documents: documents.length > 0,
      model: llm.model,
      mode,
      classified: roleUpdates.size,
      named: patch.name ?? null,
    };
  } finally {
    await removeTempDir(tempDir);
  }
};

export const brandDesignFailure: FailureHook = async (job) => {
  const brandId = (job.payload as { brandId?: string }).brandId;
  if (!isUuid(brandId)) return;
  const [b] = await getDb().select().from(brands).where(eq(brands.id, brandId));
  if (b?.designStatus === 'generating') {
    await getDb()
      .update(brands)
      .set({ designStatus: b.designSystem ? 'draft' : 'none' })
      .where(eq(brands.id, b.id));
  }
};
