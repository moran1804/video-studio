import { asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, brands, scenes, type Asset, type Brand, type Project, type Scene } from '../db/schema';
import { buildTimeline, type Timeline } from '../timeline';
import { buildCaptionCues, buildOverlayCues, type CaptionCue, type OverlayCue } from '../captions';
import {
  brandingSettingsSchema,
  captionSettingsSchema,
  voiceSettingsSchema,
  type BrandingSettings,
  type CaptionSettings,
  type VoiceSettings,
} from '../schemas';
import type { TranscriptWord } from '../providers/llm/openai';

export interface ProjectTimelineData {
  scenes: Scene[];
  brand: Brand | null;
  timeline: Timeline;
  captionSettings: CaptionSettings;
  voiceSettings: VoiceSettings;
  branding: BrandingSettings;
  cues: CaptionCue[];
  overlays: OverlayCue[];
  voiceAssets: Map<string, Asset>;
  fullVoiceover?: Asset;
}

function wordsOf(asset: Asset | undefined): TranscriptWord[] | undefined {
  const w = asset?.meta?.words;
  return Array.isArray(w) ? (w as TranscriptWord[]) : undefined;
}

/** Load everything needed to lay out captions / voiceover on the final timeline. */
export async function loadProjectTimeline(project: Project): Promise<ProjectTimelineData> {
  const db = getDb();
  const list = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, project.id))
    .orderBy(asc(scenes.position));
  const brand = project.brandId
    ? ((await db.select().from(brands).where(eq(brands.id, project.brandId)))[0] ?? null)
    : null;
  const captionSettings = captionSettingsSchema.parse(project.captionSettings ?? {});
  const voiceSettings = voiceSettingsSchema.parse(project.voiceSettings ?? {});
  const branding = brandingSettingsSchema.parse(project.brandingSettings ?? {});

  const ids = [...list.map((s) => s.voiceoverAssetId), project.voiceoverAssetId].filter((x): x is string =>
    Boolean(x),
  );
  const voiceRows = ids.length ? await db.select().from(assets).where(inArray(assets.id, ids)) : [];
  const voiceAssets = new Map(voiceRows.map((a) => [a.id, a]));
  const fullVoiceover = project.voiceoverAssetId ? voiceAssets.get(project.voiceoverAssetId) : undefined;

  const introSec = branding.intro ? branding.cardDurationSec : 0;
  const outroSec = branding.outro ? branding.cardDurationSec : 0;
  const timeline = buildTimeline(
    list.map((s) => ({ id: s.id, durationSec: s.durationSec, transition: s.transition })),
    { introSec, outroSec },
  );

  const captionScenes = list.map((s) => ({
    id: s.id,
    voiceoverText: s.voiceoverText,
    onScreenText: s.onScreenText,
    words: wordsOf(s.voiceoverAssetId ? voiceAssets.get(s.voiceoverAssetId) : undefined),
  }));
  const cues = buildCaptionCues({
    timeline,
    scenes: captionScenes,
    globalWords: wordsOf(fullVoiceover),
    mode: voiceSettings.mode,
    source: captionSettings.source,
    maxWordsPerLine: captionSettings.maxWordsPerLine,
  });
  const overlays = captionSettings.showOnScreenText ? buildOverlayCues(timeline, captionScenes) : [];
  return {
    scenes: list,
    brand,
    timeline,
    captionSettings,
    voiceSettings,
    branding,
    cues,
    overlays,
    voiceAssets,
    fullVoiceover,
  };
}
