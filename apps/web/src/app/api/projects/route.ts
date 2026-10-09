import { getDb } from '@studio/core/db';
import { projects } from '@studio/core/db/schema';
import {
  createProjectSchema,
  defaultAudioSettings,
  defaultBrandingSettings,
  defaultCaptionSettings,
  defaultVoiceSettings,
} from '@studio/core/schemas';
import { getDefaults } from '@studio/core/settings';
import { ensureProjectDirs } from '@studio/core/storage';
import { api, parseJson } from '@/server/api';
import { listProjectSummaries } from '@/server/data';
import { brandCaptionDefaults } from '@/server/brand';

export const GET = api(async () => ({ projects: await listProjectSummaries() }));

const SAFE_ZONE_FOR: Record<string, 'tiktok' | 'reels' | 'shorts' | 'none'> = {
  tiktok: 'tiktok',
  instagram_reels: 'reels',
  facebook_instagram_promo: 'reels',
  youtube_shorts: 'shorts',
  landscape_promo: 'none',
};

export const POST = api(async (req) => {
  const input = await parseJson(req, createProjectSchema);
  const defaults = await getDefaults();
  const voice = { ...defaultVoiceSettings(), voiceId: defaults.voiceId, voiceName: defaults.voiceName };
  if (/no voice|none|without voice/i.test(input.details.voiceoverPreference)) voice.mode = 'none';
  const captions = await brandCaptionDefaults(input.brandId, {
    ...defaultCaptionSettings(),
    safeZone: SAFE_ZONE_FOR[input.platform] ?? 'none',
  });
  const [project] = await getDb()
    .insert(projects)
    .values({
      name: input.name,
      platform: input.platform,
      aspectRatio: input.aspectRatio,
      durationSec: input.durationSec,
      details: input.details,
      brandId: input.brandId ?? null,
      defaultProvider: input.defaultProvider ?? null,
      voiceSettings: voice,
      audioSettings: defaultAudioSettings(),
      captionSettings: captions,
      brandingSettings: { ...defaultBrandingSettings(), outro: Boolean(input.brandId) },
    })
    .returning();
  await ensureProjectDirs(project!.id);
  return { id: project!.id };
});
