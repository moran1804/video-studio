import fs from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { projects, scenes, type Scene } from '../db/schema';
import { ProviderError, UserFacingError } from '../errors';
import { getConfig } from '../config';
import { getVideoProvider } from '../providers/registry';
import {
  pickAspectRatio,
  startFrameSize,
  type ProviderId,
  type ReferenceImage,
} from '../providers/video/types';
import { animatePrompt, withIdentity, type AspectRatio } from '../schemas';
import { generateKeyframe, loadCharacterContext } from './character';
import { absPath, makeTempDir, newProjectFileRel, removeTempDir, writeFileRel } from '../storage';
import { validateVideo } from '../ffmpeg/probe';
import { makeThumbnail, prepareReferenceImage, prepareStartFrame } from '../ffmpeg/analyze';
import { applyBrandToPrompt } from '../brand';
import { loadBrandContext } from './brand';
import {
  createAsset,
  getAsset,
  JobCancelledError,
  sleep,
  type FailureHook,
  type JobHandler,
} from './context';

async function referenceImageFor(
  scene: Scene,
  tempDir: string,
  fallbackIds: string[] = [],
): Promise<
  { image: ReferenceImage; source: 'scene' | 'brand' | 'animate' | 'keyframe'; assetId: string } | undefined
> {
  // Scene references win; brand imagery is only a fallback when the scene has none.
  const candidates = scene.referenceAssetIds.length
    ? scene.referenceAssetIds.map((id) => ({ id, source: 'scene' as const }))
    : fallbackIds.map((id) => ({ id, source: 'brand' as const }));
  for (const { id, source } of candidates) {
    const asset = await getAsset(id);
    if (!asset) continue;
    if (!asset.mime.startsWith('image/') && !asset.mime.startsWith('video/')) continue;
    const out = path.join(tempDir, `ref-${id}.jpg`);
    try {
      await prepareReferenceImage(absPath(asset.relPath), out);
      return { image: { data: await fs.readFile(out), mimeType: 'image/jpeg' }, source, assetId: id };
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/**
 * Everything a character shot needs: identity context, the keyframe (generated
 * once and stored on the scene) and, for motion transfer, the movement clip.
 */
async function prepareCharacterShot(
  scene: Scene,
  aspectRatio: AspectRatio,
  tempDir: string,
  maxRefs: number,
) {
  const context = await loadCharacterContext(scene.characterIds, tempDir, maxRefs);
  if (!context?.characters.length)
    throw new UserFacingError('The character for this scene no longer exists.');

  let motion: { data: Buffer; mimeType: string; durationSec: number } | undefined;
  let poseRef: ReferenceImage | undefined;
  if (scene.motionAssetId) {
    const clip = await getAsset(scene.motionAssetId);
    if (!clip || !clip.mime.startsWith('video/'))
      throw new UserFacingError('The movement video is missing. Upload it again.');
    motion = {
      data: await fs.readFile(absPath(clip.relPath)),
      mimeType: clip.mime,
      durationSec: clip.durationSec ?? scene.durationSec,
    };
    const first = path.join(tempDir, 'motion-first.jpg');
    await makeThumbnail(absPath(clip.relPath), first, 0, 1024);
    poseRef = { data: await fs.readFile(first), mimeType: 'image/jpeg' };
  }

  let keyframeAsset = scene.keyframeAssetId ? await getAsset(scene.keyframeAssetId) : undefined;
  if (!keyframeAsset) {
    const still = await generateKeyframe({
      scene: (scene.visualDescription || scene.prompt).trim(),
      context,
      look: scene.look,
      aspectRatio,
      extraReferences: poseRef ? [poseRef] : [],
      extraPrompt: poseRef
        ? 'Match the pose, framing, camera angle and setting of the last reference image (the first frame of a movement video), but with this person in it.'
        : '',
    });
    const rel = newProjectFileRel(
      scene.projectId,
      'generated',
      still.mimeType === 'image/png' ? '.png' : '.jpg',
    );
    await writeFileRel(rel, still.data);
    keyframeAsset = await createAsset({
      projectId: scene.projectId,
      kind: 'keyframe',
      relPath: rel,
      mime: still.mimeType,
      meta: { sceneId: scene.id, characters: context.characters.map((c) => c.id) },
    });
    await setScene(scene.id, { keyframeAssetId: keyframeAsset.id });
  }
  const frame = path.join(tempDir, 'keyframe.jpg');
  await prepareReferenceImage(absPath(keyframeAsset.relPath), frame);
  return {
    context,
    motion,
    keyframeAssetId: keyframeAsset.id,
    keyframe: { data: await fs.readFile(frame), mimeType: 'image/jpeg' as const },
  };
}

async function setScene(id: string, patch: Partial<Scene>) {
  await getDb()
    .update(scenes)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(scenes.id, id));
}

export const generationJob: JobHandler = async (ctx) => {
  const db = getDb();
  const c = getConfig();
  if (!ctx.job.sceneId) throw new UserFacingError('Job has no scene');
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, ctx.job.sceneId));
  if (!scene) throw new UserFacingError('Scene no longer exists');
  const [project] = await db.select().from(projects).where(eq(projects.id, scene.projectId));
  if (!project) throw new UserFacingError('Project no longer exists');

  // Copying movement from a video always goes through the motion-transfer model.
  const providerId = (scene.motionAssetId ? 'kling' : (ctx.job.provider ?? scene.provider)) as ProviderId;
  const provider = await getVideoProvider(providerId);
  const tempDir = await makeTempDir('gen');
  try {
    await setScene(scene.id, { status: 'generating', error: null });

    // 1. Submit (skipped when resuming after a restart).
    if (!ctx.job.providerJobId) {
      const prompt = (scene.prompt || scene.visualDescription).trim();
      if (!prompt) throw new UserFacingError('The scene has no video prompt.');
      const brandCtx = await loadBrandContext(project.brandId);
      const caps = provider.capabilities();
      let reference: Awaited<ReturnType<typeof referenceImageFor>>;
      let character: Awaited<ReturnType<typeof prepareCharacterShot>> | null = null;
      let scenePrompt = prompt;
      if (scene.animateAssetId) {
        // Animate mode: the uploaded image is the start frame, fitted without cropping.
        const artwork = await getAsset(scene.animateAssetId);
        if (!artwork || !artwork.mime.startsWith('image/')) {
          throw new UserFacingError(
            'The image to animate is missing. Pick another image in the scene editor.',
          );
        }
        const [fw, fh] = startFrameSize(
          pickAspectRatio(project.aspectRatio as AspectRatio, caps.aspectRatios),
        );
        const frame = path.join(tempDir, 'start-frame.jpg');
        await prepareStartFrame(absPath(artwork.relPath), frame, fw, fh);
        reference = {
          image: { data: await fs.readFile(frame), mimeType: 'image/jpeg' },
          source: 'animate',
          assetId: artwork.id,
        };
        scenePrompt = animatePrompt(prompt);
      } else if (scene.characterIds.length) {
        // Character mode: photoreal keyframe of the character in this scene (kept for retries),
        // then animate it with the character references attached.
        character = await prepareCharacterShot(
          scene,
          project.aspectRatio as AspectRatio,
          tempDir,
          caps.maxReferenceImages || 3,
        );
        reference = { image: character.keyframe, source: 'keyframe', assetId: character.keyframeAssetId };
        scenePrompt = withIdentity(prompt, character.context.characters, { look: scene.look, silent: true });
      } else {
        reference = await referenceImageFor(scene, tempDir, brandCtx?.imagery.map((a) => a.id) ?? []);
      }
      const branded = applyBrandToPrompt(scenePrompt, brandCtx?.brand.designSystem, caps.maxPromptChars);
      const vj = await provider.createVideo({
        prompt: branded.prompt,
        negativePrompt: branded.negativePrompt,
        aspectRatio: project.aspectRatio as AspectRatio,
        durationSec: character?.motion?.durationSec ?? scene.durationSec,
        referenceImage: reference?.image,
        characterReferences: character?.context.references,
        motionVideo: character?.motion,
        label: `Scene ${scene.position + 1}: ${scene.purpose || prompt}`,
      });
      await ctx.update({
        providerJobId: vj.providerJobId,
        provider: providerId,
        costEstimateUsd: vj.estimatedCostUsd ?? null,
        result: {
          submitted: vj.submitted,
          prompt: branded.prompt,
          negativePrompt: branded.negativePrompt,
          usedReferenceImage: Boolean(reference),
          referenceSource: reference?.source ?? null,
          referenceAssetId: reference?.assetId ?? null,
          brand: brandCtx?.brand.name ?? null,
          characters: character?.context.characters.map((c) => c.name) ?? [],
          characterReferences: character?.context.references.length ?? 0,
          keyframeAssetId: character?.keyframeAssetId ?? null,
          motion: Boolean(character?.motion),
        },
      });
    }
    const providerJobId = ctx.job.providerJobId!;

    // 2. Poll until finished.
    const pollMs =
      providerId === 'mock' || c.MOCK_PROVIDERS ? 750 : Math.max(2, c.GENERATION_POLL_SECONDS) * 1000;
    const deadline = Date.now() + c.GENERATION_TIMEOUT_MINUTES * 60_000;
    for (;;) {
      if (await ctx.isCancelled()) {
        await provider.cancelJob?.(providerJobId).catch(() => undefined);
        throw new JobCancelledError();
      }
      const status = await provider.getJobStatus(providerJobId);
      if (status.state === 'completed') break;
      if (status.state === 'failed') {
        throw new ProviderError(status.error ?? 'Generation failed', {
          provider: providerId,
          retryable: false,
        });
      }
      if (status.state === 'cancelled')
        throw new ProviderError('Cancelled by the provider', { provider: providerId, retryable: false });
      await ctx.setProgress(0.1 + 0.75 * (status.progress ?? 0.3));
      if (Date.now() > deadline) {
        throw new ProviderError(`Generation did not finish within ${c.GENERATION_TIMEOUT_MINUTES} minutes`, {
          provider: providerId,
          retryable: false,
        });
      }
      await sleep(pollMs, ctx.signal);
    }

    // 3. Download, validate, store.
    await ctx.setProgress(0.9);
    const video = await provider.downloadResult(providerJobId);
    const rel = newProjectFileRel(project.id, 'generated', '.mp4');
    const abs = await writeFileRel(rel, video.data);
    let info;
    try {
      info = await validateVideo(abs);
    } catch (err) {
      await fs.rm(abs, { force: true });
      throw new ProviderError(`Downloaded clip is invalid: ${(err as Error).message}`, {
        provider: providerId,
        retryable: true,
      });
    }
    const asset = await createAsset({
      projectId: project.id,
      kind: 'generated',
      relPath: rel,
      mime: 'video/mp4',
      originalName: `scene-${scene.position + 1}.mp4`,
      durationSec: info.durationSec,
      width: info.video?.width,
      height: info.video?.height,
      meta: {
        provider: providerId,
        model: provider.model,
        providerJobId,
        hasAudio: Boolean(info.audio),
        sourceUrl: video.sourceUrl,
      },
    });
    const thumbRel = newProjectFileRel(project.id, 'generated', '.jpg');
    let thumbId: string | null = null;
    try {
      await makeThumbnail(abs, absPath(thumbRel), Math.min(1, info.durationSec / 2));
      thumbId = (
        await createAsset({ projectId: project.id, kind: 'thumbnail', relPath: thumbRel, mime: 'image/jpeg' })
      ).id;
    } catch {
      /* thumbnails are best-effort */
    }
    await setScene(scene.id, {
      status: 'completed',
      clipAssetId: asset.id,
      clipSource: 'generated',
      thumbnailAssetId: thumbId,
      error: null,
    });
    if (thumbId && !project.thumbnailAssetId) {
      await db.update(projects).set({ thumbnailAssetId: thumbId }).where(eq(projects.id, project.id));
    }
    return { ...(ctx.job.result ?? {}), assetId: asset.id, durationSec: info.durationSec };
  } catch (err) {
    if (err instanceof JobCancelledError) await setScene(scene.id, { status: 'cancelled' });
    throw err;
  } finally {
    await removeTempDir(tempDir);
  }
};

export const generationFailure: FailureHook = async (job, message) => {
  if (!job.sceneId) return;
  await setScene(job.sceneId, { status: 'failed', error: message });
};
