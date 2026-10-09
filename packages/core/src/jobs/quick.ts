import fs from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db';
import {
  assets,
  characters,
  jobs,
  projects,
  references,
  renders,
  scenes,
  type Job,
  type Scene,
} from '../db/schema';
import { UserFacingError } from '../errors';
import { enqueueJob } from '../queues';
import { getLlmOptional, getVideoProvider, staticCapabilities } from '../providers/registry';
import { pickDuration, type ProviderId } from '../providers/video/types';
import { getDefaults } from '../settings';
import { makeTempDir, removeTempDir, absPath } from '../storage';
import { makeThumbnail } from '../ffmpeg/analyze';
import { probe } from '../ffmpeg/probe';
import {
  ANIMATE_DEFAULT_PROMPT,
  LOOK_IDS,
  lookPrompt,
  PLATFORMS,
  audioSettingsSchema,
  brandingSettingsSchema,
  captionSettingsSchema,
  voiceSettingsSchema,
  type AspectRatio,
} from '../schemas';
import { normalizeQuickPlan, type QuickPlan } from '../providers/llm/openai';
import { renderDimensions } from './render';
import { loadBrandContext } from './brand';
import { cancelJob } from './cancel';
import { JobCancelledError, sleep, type JobContext, type JobHandler, type FailureHook } from './context';

/** Options chosen on the Create screen; stored as the pipeline job's payload. */
export const quickOptionsSchema = z.object({
  prompt: z.string().trim().min(3, 'Describe the video you want').max(4000),
  provider: z.string().max(40).nullable().default(null),
  voiceover: z.boolean().default(false),
  voiceId: z.string().max(100).default(''),
  captions: z.boolean().default(true),
  music: z.boolean().default(false),
  logo: z.boolean().default(true),
  /** Virtual character to feature (identity locked with its references). */
  characterId: z.string().uuid().nullable().default(null),
  look: z.enum(LOOK_IDS).default('ugc'),
  /** Burn short headline overlays onto the clips (off by default: clean footage). */
  onScreenText: z.boolean().default(false),
});
export type QuickOptions = z.infer<typeof quickOptionsSchema>;

/** Narration pace used to size the script for each clip. */
const WORDS_PER_SECOND = 2.4;
const POLL_MS = 2000;

interface QuickState {
  stage?: 'plan' | 'generate' | 'voiceover' | 'render' | 'done';
  sceneIds?: string[];
  voiceJobId?: string;
  renderId?: string;
  title?: string;
}

/** Split the requested length into clips the model can produce. */
export function planClipDurations(totalSec: number, durations: number[]): number[] {
  const sorted = [...durations].sort((a, b) => a - b);
  const max = sorted.at(-1) ?? 8;
  const count = Math.max(1, Math.ceil(totalSec / max - 0.001));
  const per = totalSec / count;
  return Array.from({ length: count }, () => pickDuration(per, sorted));
}

async function waitForJobs(ctx: JobContext, ids: string[], onProgress: (fraction: number) => Promise<void>) {
  const db = getDb();
  for (;;) {
    if (await ctx.isCancelled()) {
      for (const row of await db.select().from(jobs).where(inArray(jobs.id, ids))) await cancelJob(row);
      throw new JobCancelledError();
    }
    const rows = await db.select().from(jobs).where(inArray(jobs.id, ids));
    const failed = rows.find((r) => r.status === 'failed' || r.status === 'cancelled');
    if (failed) return { failed, rows };
    await onProgress(rows.reduce((a, r) => a + (r.status === 'completed' ? 1 : r.progress), 0) / ids.length);
    if (rows.length === ids.length && rows.every((r) => r.status === 'completed'))
      return { failed: undefined, rows };
    await sleep(POLL_MS, ctx.signal);
  }
}

async function planScenes(ctx: JobContext, projectId: string, opts: QuickOptions, provider: ProviderId) {
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new UserFacingError('Video no longer exists');

  // Start fresh: a retry replaces the previous attempt's clips.
  const old = await db.select().from(scenes).where(eq(scenes.projectId, projectId));
  if (old.length) {
    const active = await db
      .select()
      .from(jobs)
      .where(
        and(
          inArray(
            jobs.sceneId,
            old.map((s) => s.id),
          ),
          inArray(jobs.status, ['queued', 'running']),
        ),
      );
    for (const j of active) await cancelJob(j);
    await db.delete(scenes).where(eq(scenes.projectId, projectId));
  }

  const refs = await db
    .select({ ref: references, asset: assets })
    .from(references)
    .leftJoin(assets, eq(assets.id, references.assetId))
    .where(eq(references.projectId, projectId))
    .orderBy(asc(references.createdAt));
  const images = refs.filter((r) => r.asset?.mime.startsWith('image/'));
  // "Copy this movement": one clip as long as the movement video (motion transfer).
  const motion = opts.characterId
    ? refs.find((r) => r.ref.usage === 'motion' && r.asset?.mime.startsWith('video/'))
    : undefined;
  const [character] = opts.characterId
    ? await db.select().from(characters).where(eq(characters.id, opts.characterId))
    : [];
  const toAnimate = images.filter((r) => r.ref.usage === 'animate');
  const inspiration = images.filter((r) => r.ref.usage !== 'animate');

  if (motion?.asset && !motion.asset.durationSec) {
    // Probe once here (the web container has no ffprobe) and remember it.
    const info = await probe(absPath(motion.asset.relPath));
    if (info.durationSec < 3 || info.durationSec > 30) {
      throw new UserFacingError(
        `The movement video must be 3–30 seconds long (it is ${Math.round(info.durationSec)} s).`,
      );
    }
    motion.asset.durationSec = info.durationSec;
    await db.update(assets).set({ durationSec: info.durationSec }).where(eq(assets.id, motion.asset.id));
  }
  const caps = staticCapabilities(provider);
  const durations = motion
    ? [Math.min(30, Math.max(3, Math.round(motion.asset!.durationSec ?? project.durationSec)))]
    : planClipDurations(
        project.durationSec,
        // Veo locks clips to 8 s when character references are attached.
        character && caps.referenceDurations ? caps.referenceDurations : caps.durations,
      );
  const clips = durations.map((d, i) => ({ durationSec: d, animatesImage: i < toAnimate.length }));
  const brand = await loadBrandContext(project.brandId);
  const platform = PLATFORMS.find((p) => p.id === project.platform)?.label ?? project.platform;

  const llm = await getLlmOptional();
  let plan: QuickPlan;
  if (llm) {
    const tempDir = await makeTempDir('quick');
    try {
      const thumbs: Buffer[] = [];
      for (const r of images.slice(0, 4)) {
        const out = path.join(tempDir, `${r.asset!.id}.jpg`);
        try {
          await makeThumbnail(absPath(r.asset!.relPath), out, 0, 768);
          thumbs.push(await fs.readFile(out));
        } catch {
          /* unreadable image: skip */
        }
      }
      const res = await llm.planQuickVideo({
        request: opts.prompt,
        platform,
        aspectRatio: project.aspectRatio,
        clips,
        voiceover: opts.voiceover,
        onScreenText: opts.onScreenText,
        wordsPerSecond: WORDS_PER_SECOND,
        brandGuide: brand?.guide,
        character: character
          ? {
              description: character.description || character.name,
              look: lookPrompt(opts.look),
              motion: Boolean(motion),
            }
          : undefined,
        attachments: images.map((r) => ({
          title: r.ref.title || r.asset!.originalName || 'image',
          usage: r.ref.usage === 'animate' ? 'animate' : 'inspiration',
          notes: r.ref.notes,
        })),
        images: thumbs,
      });
      plan = res.plan;
      if (res.usage)
        await ctx.update({
          usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens },
        });
    } finally {
      await removeTempDir(tempDir);
    }
  } else {
    // No language model configured: use the request as-is.
    plan = normalizeQuickPlan(
      {
        title: opts.prompt.slice(0, 60),
        clips: clips.map((c) => ({
          prompt: c.animatesImage ? ANIMATE_DEFAULT_PROMPT : opts.prompt,
          voiceoverText: opts.prompt,
          onScreenText: '',
        })),
      },
      { clips, voiceover: opts.voiceover, request: opts.prompt, onScreenText: opts.onScreenText },
    );
  }

  const rows = await db
    .insert(scenes)
    .values(
      plan.clips.map((c, i) => ({
        projectId,
        position: i,
        purpose: `Clip ${i + 1}`,
        durationSec: durations[i]!,
        visualDescription: c.prompt,
        prompt: c.prompt,
        voiceoverText: c.voiceoverText,
        onScreenText: c.onScreenText,
        transition: 'fade' as const,
        provider,
        animateAssetId: clips[i]!.animatesImage && !character ? toAnimate[i]!.asset!.id : null,
        referenceAssetIds: inspiration.slice(0, 3).map((r) => r.asset!.id),
        characterIds: character ? [character.id] : [],
        motionAssetId: motion?.asset?.id ?? null,
        look: opts.look,
      })),
    )
    .returning();
  await db
    .update(projects)
    .set({ name: plan.title, updatedAt: new Date() })
    .where(eq(projects.id, projectId));
  return { sceneIds: rows.map((r) => r.id), title: plan.title };
}

/** Make sure every clip has (or is getting) footage; returns the generation job ids. */
async function startClips(projectId: string, sceneIds: string[]): Promise<string[]> {
  const db = getDb();
  const list = await db
    .select()
    .from(scenes)
    .where(inArray(scenes.id, sceneIds))
    .orderBy(asc(scenes.position));
  const ids: string[] = [];
  for (const scene of list) {
    const [latest] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.sceneId, scene.id), eq(jobs.type, 'generation')))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    // Reuse finished or in-flight work (e.g. after a worker restart).
    if (latest && ['completed', 'queued', 'running'].includes(latest.status)) ids.push(latest.id);
    else ids.push((await startClip(projectId, scene)).id);
  }
  return ids;
}

async function startClip(projectId: string, scene: Scene): Promise<Job> {
  await getDb()
    .update(scenes)
    .set({ status: 'queued', error: null, updatedAt: new Date() })
    .where(eq(scenes.id, scene.id));
  return enqueueJob({ type: 'generation', projectId, sceneId: scene.id, provider: scene.provider });
}

/**
 * One request → one finished video: plan the clip(s) with the language model,
 * generate them, add the voiceover and render the final MP4. Each step reuses
 * the regular jobs; progress and restarts are tracked in the job's `result`.
 */
export const quickVideoJob: JobHandler = async (ctx) => {
  const projectId = ctx.job.projectId;
  if (!projectId) throw new UserFacingError('Job has no video');
  const opts = quickOptionsSchema.parse(ctx.job.payload ?? {});
  const db = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new UserFacingError('Video no longer exists');
  const provider = (opts.provider ||
    project.defaultProvider ||
    (await getDefaults()).videoProvider) as ProviderId;
  await getVideoProvider(provider); // fail fast when the model is not configured

  let state: QuickState = { ...((ctx.job.result as QuickState | null) ?? {}) };
  const save = async (patch: QuickState) => {
    state = { ...state, ...patch };
    await ctx.update({ result: state as Record<string, unknown> });
  };

  // 1. Plan
  if (!state.sceneIds?.length) {
    await save({ stage: 'plan' });
    await ctx.setProgress(0.02);
    await save({ ...(await planScenes(ctx, projectId, opts, provider)), stage: 'generate' });
  }
  await ctx.setProgress(0.08);

  // 2. Generate clips
  const genIds = await startClips(projectId, state.sceneIds!);
  const gen = await waitForJobs(ctx, genIds, (f) => ctx.setProgress(0.08 + f * 0.62));
  if (gen.failed) {
    const n = state.sceneIds!.indexOf(gen.failed.sceneId ?? '') + 1;
    throw new UserFacingError(
      `${genIds.length > 1 ? `Clip ${n}: ` : ''}${gen.failed.error ?? 'Video generation was cancelled'}`,
    );
  }

  // 3. Voiceover
  const voice = voiceSettingsSchema.parse(project.voiceSettings ?? {});
  if (opts.voiceover) {
    await save({ stage: 'voiceover' });
    const voiceId = opts.voiceId || voice.voiceId || (await getDefaults()).voiceId;
    if (!voiceId) throw new UserFacingError('Choose a voice for the voiceover.');
    if (!state.voiceJobId) {
      await db
        .update(projects)
        .set({ voiceSettings: { ...voice, mode: 'full', voiceId }, updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      await save({
        voiceJobId: (await enqueueJob({ type: 'voiceover', projectId, payload: { mode: 'full' } })).id,
      });
    }
    const vo = await waitForJobs(ctx, [state.voiceJobId!], (f) => ctx.setProgress(0.7 + f * 0.08));
    if (vo.failed) throw new UserFacingError(`Voiceover: ${vo.failed.error ?? 'cancelled'}`);
  } else if (voice.mode !== 'none') {
    await db
      .update(projects)
      .set({ voiceSettings: { ...voice, mode: 'none' }, voiceoverAssetId: null, updatedAt: new Date() })
      .where(eq(projects.id, projectId));
  }

  // 4. Render
  await save({ stage: 'render' });
  if (!state.renderId) {
    const [fresh] = await db.select().from(projects).where(eq(projects.id, projectId));
    const captions = captionSettingsSchema.parse(fresh!.captionSettings ?? {});
    const branding = brandingSettingsSchema.parse(fresh!.brandingSettings ?? {});
    const audio = audioSettingsSchema.parse(fresh!.audioSettings ?? {});
    const withBrand = Boolean(fresh!.brandId) && opts.logo;
    await db
      .update(projects)
      .set({
        captionSettings: {
          ...captions,
          enabled: opts.captions && opts.voiceover,
          showOnScreenText: opts.onScreenText,
        },
        brandingSettings: { ...branding, showLogo: withBrand, intro: false, outro: withBrand },
        audioSettings: { ...audio, musicAssetId: opts.music ? audio.musicAssetId : null },
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));
    const dims = renderDimensions(fresh!.aspectRatio as AspectRatio, 'final');
    const [render] = await db
      .insert(renders)
      .values({ projectId, mode: 'final', status: 'queued', width: dims.width, height: dims.height })
      .returning();
    await enqueueJob({ type: 'render', projectId, renderId: render!.id });
    await save({ renderId: render!.id });
  }
  const [renderJob] = await db.select().from(jobs).where(eq(jobs.renderId, state.renderId!));
  if (!renderJob) throw new UserFacingError('The render could not be started.');
  const rendered = await waitForJobs(ctx, [renderJob.id], (f) => ctx.setProgress(0.78 + f * 0.21));
  if (rendered.failed) throw new UserFacingError(`Rendering: ${rendered.failed.error ?? 'cancelled'}`);

  await save({ stage: 'done' });
  return state as Record<string, unknown>;
};

export const quickVideoFailure: FailureHook = async () => {
  /* the job row carries the error; child jobs keep their own state */
};
