import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, projects, scenes, type Scene } from '../db/schema';
import { UserFacingError } from '../errors';
import { getLlm, getTts } from '../providers/registry';
import { absPath, newProjectFileRel, writeFileRel } from '../storage';
import { probe } from '../ffmpeg/probe';
import { voiceSettingsSchema } from '../schemas';
import { getDefaults } from '../settings';
import { createAsset, getAsset, type FailureHook, type JobHandler } from './context';

export interface VoiceoverPayload {
  mode: 'full' | 'per-scene';
  sceneIds?: string[];
}

async function synthToAsset(
  projectId: string,
  text: string,
  label: string,
  voice: { id: string; settings: ReturnType<typeof voiceSettingsSchema.parse> },
) {
  const tts = await getTts();
  const out = await tts.synthesize({ text, voiceId: voice.id, settings: voice.settings });
  const rel = newProjectFileRel(projectId, 'audio', out.ext);
  const abs = await writeFileRel(rel, out.audio);
  let duration: number | undefined;
  try {
    duration = (await probe(abs)).durationSec;
  } catch {
    duration = out.words.at(-1)?.end;
  }
  const asset = await createAsset({
    projectId,
    kind: 'voiceover',
    relPath: rel,
    mime: out.mime,
    originalName: `${label}${out.ext}`,
    durationSec: duration ?? null,
    meta: { text, words: out.words, provider: tts.id, voiceId: voice.id, characters: out.characters },
  });
  return { asset, characters: out.characters };
}

export const voiceoverJob: JobHandler = async (ctx) => {
  const db = getDb();
  const payload = ctx.job.payload as unknown as VoiceoverPayload;
  if (!ctx.job.projectId) throw new UserFacingError('Job has no project');
  const [project] = await db.select().from(projects).where(eq(projects.id, ctx.job.projectId));
  if (!project) throw new UserFacingError('Project no longer exists');
  const settings = voiceSettingsSchema.parse(project.voiceSettings ?? {});
  const defaults = await getDefaults();
  const voiceId = settings.voiceId || defaults.voiceId;
  if (!voiceId) throw new UserFacingError('Choose a voice in the Voice & Audio tab first.');
  const voice = { id: voiceId, settings };

  let list: Scene[] = await db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, project.id))
    .orderBy(asc(scenes.position));
  let characters = 0;

  if (payload.mode === 'full') {
    const text = list
      .map((s) => s.voiceoverText.trim())
      .filter(Boolean)
      .join(' ');
    if (!text) throw new UserFacingError('The storyboard has no voiceover text.');
    await ctx.setProgress(0.2);
    const { asset, characters: n } = await synthToAsset(project.id, text, 'voiceover-full', voice);
    characters += n;
    await db
      .update(projects)
      .set({ voiceoverAssetId: asset.id, updatedAt: new Date() })
      .where(eq(projects.id, project.id));
    await ctx.update({ usage: { characters } });
    return { assetId: asset.id };
  }

  if (payload.sceneIds?.length) list = list.filter((s) => payload.sceneIds!.includes(s.id));
  const withText = list.filter((s) => s.voiceoverText.trim());
  if (!withText.length) throw new UserFacingError('No scenes with voiceover text.');
  for (let i = 0; i < withText.length; i++) {
    const s = withText[i]!;
    const { asset, characters: n } = await synthToAsset(
      project.id,
      s.voiceoverText.trim(),
      `voiceover-scene-${s.position + 1}`,
      voice,
    );
    characters += n;
    await db
      .update(scenes)
      .set({ voiceoverAssetId: asset.id, updatedAt: new Date() })
      .where(eq(scenes.id, s.id));
    await ctx.setProgress((i + 1) / withText.length);
  }
  await ctx.update({ usage: { characters } });
  return { scenes: withText.length };
};

export const voiceoverFailure: FailureHook = async () => {
  /* failures are shown through the job list */
};

/** Transcribe an uploaded voiceover so captions can follow real speech timing. */
export const transcribeJob: JobHandler = async (ctx) => {
  const assetId = (ctx.job.payload as { assetId?: string }).assetId;
  const asset = await getAsset(assetId);
  if (!asset || !ctx.job.projectId || asset.projectId !== ctx.job.projectId)
    throw new UserFacingError('Audio asset not found');
  const llm = await getLlm();
  const transcript = await llm.transcribe(absPath(asset.relPath));
  await getDb()
    .update(assets)
    .set({ meta: { ...asset.meta, text: transcript.text, words: transcript.words ?? [] } })
    .where(and(eq(assets.id, asset.id), inArray(assets.kind, ['voiceover'])));
  return { words: transcript.words?.length ?? 0 };
};
