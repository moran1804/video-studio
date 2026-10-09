import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { projects, renders, type Render } from '../db/schema';
import { UserFacingError } from '../errors';
import { audioSettingsSchema, type AspectRatio } from '../schemas';
import { absPath, makeTempDir, newProjectFileRel, removeTempDir, writeFileRel } from '../storage';
import { toAss, toSrt } from '../captions';
import { renderVideo, type CardSpec } from '../ffmpeg/render';
import { makeThumbnail } from '../ffmpeg/analyze';
import { createAsset, getAsset, moveIntoStorage, type FailureHook, type JobHandler } from './context';
import { loadProjectTimeline } from './caption-data';
import { sanitizeFilename } from '../security/paths';

async function setRender(id: string, patch: Partial<Render>) {
  await getDb().update(renders).set(patch).where(eq(renders.id, id));
}

export const renderJob: JobHandler = async (ctx) => {
  const db = getDb();
  if (!ctx.job.renderId) throw new UserFacingError('Job has no render');
  const [render] = await db.select().from(renders).where(eq(renders.id, ctx.job.renderId));
  if (!render) throw new UserFacingError('Render no longer exists');
  const [project] = await db.select().from(projects).where(eq(projects.id, render.projectId));
  if (!project) throw new UserFacingError('Project no longer exists');

  await setRender(render.id, { status: 'running', progress: 0, error: null });
  const data = await loadProjectTimeline(project);
  if (!data.scenes.length) throw new UserFacingError('The storyboard has no scenes.');
  const missing = data.scenes.filter((s) => !s.clipAssetId).map((s) => s.position + 1);
  if (missing.length)
    throw new UserFacingError(
      `Scenes without footage: ${missing.join(', ')}. Generate or upload clips first.`,
    );

  const audio = audioSettingsSchema.parse(project.audioSettings ?? {});
  const tempDir = await makeTempDir('render');
  try {
    // Scene clips
    const sceneInputs = [];
    for (const s of data.scenes) {
      const clip = await getAsset(s.clipAssetId);
      if (!clip) throw new UserFacingError(`Scene ${s.position + 1}: clip file is missing.`);
      sceneInputs.push({ clipPath: absPath(clip.relPath), durationSec: s.durationSec });
    }

    // Voiceover placement
    const voiceovers: { path: string; startSec: number; volume: number }[] = [];
    const mode = data.voiceSettings.mode;
    if ((mode === 'full' || mode === 'uploaded') && data.fullVoiceover) {
      voiceovers.push({
        path: absPath(data.fullVoiceover.relPath),
        startSec: data.timeline.entries[0]?.start ?? 0,
        volume: audio.voiceVolume,
      });
    } else if (mode === 'per-scene') {
      data.scenes.forEach((s, i) => {
        const a = s.voiceoverAssetId ? data.voiceAssets.get(s.voiceoverAssetId) : undefined;
        if (a)
          voiceovers.push({
            path: absPath(a.relPath),
            startSec: data.timeline.entries[i]!.start + 0.1,
            volume: audio.voiceVolume,
          });
      });
    }

    // Music + SFX
    const musicAsset = await getAsset(audio.musicAssetId);
    const sfx = [];
    for (const cue of audio.sfx) {
      const a = await getAsset(cue.assetId);
      if (a && a.projectId === project.id)
        sfx.push({ path: absPath(a.relPath), atSec: cue.atSec, volume: cue.volume });
    }

    // Branding
    const brand = data.brand;
    const logoAsset = brand?.logoAssetId ? await getAsset(brand.logoAssetId) : undefined;
    const handles = brand ? Object.values(brand.handles).filter(Boolean).join('  ·  ') : '';
    const cardBase = {
      backgroundColor: brand?.secondaryColor ?? '#111827',
      textColor: '#FFFFFF',
      fontFamily: brand?.headingFont ?? 'Montserrat',
      logoPath: logoAsset ? absPath(logoAsset.relPath) : undefined,
      durationSec: data.branding.cardDurationSec,
    };
    const intro: CardSpec | undefined = data.branding.intro
      ? {
          ...cardBase,
          backgroundColor: brand?.primaryColor ?? '#7C3AED',
          title: brand?.introText || project.name,
          subtitle: brand?.name ?? '',
        }
      : undefined;
    const outro: CardSpec | undefined = data.branding.outro
      ? {
          ...cardBase,
          title: brand?.outroText || project.details.callToAction || brand?.defaultCta || project.name,
          subtitle: handles || brand?.name || '',
        }
      : undefined;

    // Captions / overlays / watermark (ASS)
    const w = render.width;
    const h = render.height;
    let assPath: string | undefined;
    const burnCaptions = data.captionSettings.enabled && data.captionSettings.burnIn && data.cues.length > 0;
    if (burnCaptions || data.overlays.length || data.branding.watermarkText) {
      assPath = path.join(tempDir, 'captions.ass');
      await fs.writeFile(
        assPath,
        toAss(data.cues, data.overlays, {
          width: w,
          height: h,
          settings: data.captionSettings,
          headlineFont: brand?.headingFont,
          headlineColor: brand?.primaryColor,
          watermarkText: data.branding.watermarkText || undefined,
          watermarkOpacity: data.branding.watermarkOpacity,
          totalSec: data.timeline.totalSec,
        }),
      );
    }

    const outTemp = path.join(tempDir, 'output.mp4');
    const result = await renderVideo({
      mode: render.mode as 'preview' | 'final',
      width: w,
      height: h,
      fps: 30,
      timeline: data.timeline,
      scenes: sceneInputs,
      intro,
      outro,
      originalAudio: audio.originalAudio,
      originalVolume: audio.originalVolume,
      voiceovers,
      music: musicAsset
        ? {
            path: absPath(musicAsset.relPath),
            volume: audio.musicVolume,
            loop: audio.musicLoop,
            fadeInSec: audio.musicFadeInSec,
            fadeOutSec: audio.musicFadeOutSec,
            duck: audio.ducking && voiceovers.length > 0,
          }
        : undefined,
      sfx,
      assPath,
      logo:
        logoAsset && data.branding.showLogo
          ? {
              path: absPath(logoAsset.relPath),
              position: data.branding.logoPosition,
              scale: data.branding.logoScale,
              opacity: data.branding.logoOpacity,
            }
          : undefined,
      outPath: outTemp,
      tempDir,
      signal: ctx.signal,
      onProgress: (f) => {
        void ctx.setProgress(f);
        void setRender(render.id, { progress: f });
      },
    });

    // Store outputs
    const sub = render.mode === 'final' ? 'exports' : 'previews';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const baseName = sanitizeFilename(`${project.name}-${render.mode}-${stamp}`, 'video');
    const videoRel = newProjectFileRel(project.id, sub, '.mp4');
    await moveIntoStorage(outTemp, videoRel);
    const videoAsset = await createAsset({
      projectId: project.id,
      kind: render.mode === 'final' ? 'export' : 'preview',
      relPath: videoRel,
      mime: 'video/mp4',
      originalName: `${baseName}.mp4`,
      durationSec: result.durationSec,
      width: w,
      height: h,
      meta: { renderId: render.id },
    });
    let srtId: string | null = null;
    if (data.cues.length) {
      const srtRel = newProjectFileRel(project.id, sub, '.srt');
      await writeFileRel(srtRel, toSrt(data.cues));
      srtId = (
        await createAsset({
          projectId: project.id,
          kind: 'srt',
          relPath: srtRel,
          mime: 'application/x-subrip',
          originalName: `${baseName}.srt`,
        })
      ).id;
    }
    let thumbId: string | null = null;
    try {
      const thumbRel = newProjectFileRel(project.id, sub, '.jpg');
      await makeThumbnail(
        absPath(videoRel),
        absPath(thumbRel),
        Math.min(result.durationSec / 3, (intro?.durationSec ?? 0) + 1),
      );
      thumbId = (
        await createAsset({ projectId: project.id, kind: 'thumbnail', relPath: thumbRel, mime: 'image/jpeg' })
      ).id;
    } catch {
      /* best effort */
    }
    await setRender(render.id, {
      status: 'completed',
      progress: 1,
      videoAssetId: videoAsset.id,
      srtAssetId: srtId,
      thumbnailAssetId: thumbId,
      durationSec: result.durationSec,
      finishedAt: new Date(),
      log: result.graph.slice(0, 20_000),
    });
    if (render.mode === 'final' && thumbId) {
      await db
        .update(projects)
        .set({ thumbnailAssetId: thumbId, updatedAt: new Date() })
        .where(eq(projects.id, project.id));
    }
    return { videoAssetId: videoAsset.id, durationSec: result.durationSec };
  } finally {
    await removeTempDir(tempDir);
  }
};

export const renderFailure: FailureHook = async (job, message) => {
  if (!job.renderId) return;
  await setRender(job.renderId, { status: 'failed', error: message, finishedAt: new Date() });
};

export function renderDimensions(aspectRatio: AspectRatio, mode: 'preview' | 'final') {
  const full = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] }[
    aspectRatio
  ] ?? [1080, 1920];
  if (mode === 'final') return { width: full[0]!, height: full[1]! };
  return { width: Math.round(full[0]! / 4) * 2, height: Math.round(full[1]! / 4) * 2 };
}
