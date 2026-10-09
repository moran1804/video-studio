import { asc, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { projects, references, scenes, type Project, type Reference } from '../db/schema';
import { UserFacingError } from '../errors';
import { getLlm, staticCapabilities } from '../providers/registry';
import type { BriefContext } from '../providers/llm/openai';
import type { ProviderId } from '../providers/video/types';
import { normalizeStoryboard, type ReferenceAnalysis } from '../schemas';
import { getDefaults } from '../settings';
import type { FailureHook, JobHandler } from './context';
import { loadBrandContext } from './brand';

/** An uploaded image the user asked to animate directly (poster, flyer, artwork…). */
export function isAnimatable(r: Reference): boolean {
  return (
    r.usage === 'animate' && Boolean(r.assetId) && ['image', 'logo', 'poster', 'artwork'].includes(r.category)
  );
}

export function summarizeAnalysis(a: ReferenceAnalysis | null | undefined): string {
  if (!a) return '';
  const bits: string[] = [];
  if (a.visual?.summary) bits.push(a.visual.summary);
  if (a.editing) bits.push(`${a.editing.pace} pace, avg shot ${a.editing.averageShotLengthSec}s`);
  if (a.technical?.aspectRatio) bits.push(`aspect ${a.technical.aspectRatio}`);
  if (a.visual?.lighting) bits.push(`lighting: ${a.visual.lighting}`);
  if (a.visual?.cameraMovements) bits.push(`camera: ${a.visual.cameraMovements}`);
  if (a.visual?.captionPlacement) bits.push(`captions: ${a.visual.captionPlacement}`);
  if (a.visual?.openingHook) bits.push(`hook: ${a.visual.openingHook}`);
  if (a.palette?.length) bits.push(`palette ${a.palette.slice(0, 5).join(' ')}`);
  if (a.audio?.energy) bits.push(`audio energy ${a.audio.energy}`);
  if (a.transcript) bits.push(`transcript: "${a.transcript.slice(0, 300)}"`);
  if (a.text) bits.push(`document text: ${a.text.slice(0, 1500)}`);
  if (a.link?.title) bits.push(`link title: ${a.link.title}`);
  return bits.join('; ');
}

export async function buildBriefContext(project: Project): Promise<{ ctx: BriefContext; refs: Reference[] }> {
  const db = getDb();
  const refs = await db
    .select()
    .from(references)
    .where(eq(references.projectId, project.id))
    .orderBy(asc(references.createdAt));
  const brandCtx = await loadBrandContext(project.brandId);
  const brand = brandCtx?.brand;
  return {
    refs,
    ctx: {
      project: {
        name: project.name,
        platform: project.platform,
        aspectRatio: project.aspectRatio,
        durationSec: project.durationSec,
        details: project.details as unknown as Record<string, string>,
      },
      brand: brand
        ? {
            name: brand.name,
            colors: [brand.primaryColor, brand.secondaryColor, brand.accentColor],
            fonts: [brand.headingFont, brand.bodyFont],
            defaultCta: brand.defaultCta,
            handles: brand.handles,
            guide: brandCtx?.guide,
          }
        : null,
      references: refs.map((r, index) => ({
        index,
        category: r.category,
        title: r.title || r.sourceUrl || 'Untitled',
        notes: r.notes,
        summary: summarizeAnalysis(r.analysis),
        usage: isAnimatable(r) ? 'animate' : 'inspiration',
      })),
    },
  };
}

async function loadProject(id: string | null): Promise<Project> {
  if (!id) throw new UserFacingError('Job has no project');
  const [p] = await getDb().select().from(projects).where(eq(projects.id, id));
  if (!p) throw new UserFacingError('Project no longer exists');
  return p;
}

export const briefJob: JobHandler = async (ctx) => {
  const project = await loadProject(ctx.job.projectId);
  const llm = await getLlm();
  await ctx.setProgress(0.1);
  const { ctx: briefCtx } = await buildBriefContext(project);
  const { brief, usage } = await llm.generateBrief(briefCtx);
  await getDb()
    .update(projects)
    .set({ brief, briefStatus: 'draft', updatedAt: new Date() })
    .where(eq(projects.id, project.id));
  if (usage)
    await ctx.update({ usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } });
  return { model: llm.model };
};

export const briefFailure: FailureHook = async (job) => {
  if (!job.projectId) return;
  const [p] = await getDb().select().from(projects).where(eq(projects.id, job.projectId));
  if (p && p.briefStatus === 'generating') {
    await getDb()
      .update(projects)
      .set({ briefStatus: p.brief ? 'draft' : 'none' })
      .where(eq(projects.id, job.projectId));
  }
};

export const storyboardJob: JobHandler = async (ctx) => {
  const project = await loadProject(ctx.job.projectId);
  if (!project.brief) throw new UserFacingError('Generate and approve a creative brief first.');
  const llm = await getLlm();
  const defaults = await getDefaults();
  const provider = (project.defaultProvider as ProviderId | null) ?? defaults.videoProvider;
  const caps = staticCapabilities(provider);
  const maxSceneSec = Math.max(...caps.durations);
  const minSceneSec = Math.min(2, Math.min(...caps.durations));
  await ctx.setProgress(0.1);
  const { ctx: bctx, refs } = await buildBriefContext(project);
  const { storyboard, usage } = await llm.generateStoryboard({
    ...bctx,
    brief: project.brief,
    maxSceneSec,
    minSceneSec,
  });
  const normalized = normalizeStoryboard(storyboard, {
    targetDurationSec: project.durationSec,
    referenceCount: refs.length,
    minSceneSec,
    maxSceneSec,
    animateIndexes: refs.map((r, i) => (isAnimatable(r) ? i : -1)).filter((i) => i >= 0),
  });
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.delete(scenes).where(eq(scenes.projectId, project.id));
    await tx.insert(scenes).values(
      normalized.scenes.map((s, i) => ({
        projectId: project.id,
        position: i,
        purpose: s.purpose,
        durationSec: s.durationSec,
        visualDescription: s.visualDescription,
        prompt: s.prompt,
        referenceAssetIds: s.referenceIndexes
          .map((idx) => refs[idx])
          .map((r) => r?.assetId ?? r?.thumbnailAssetId)
          .filter((x): x is string => Boolean(x)),
        animateAssetId:
          s.animateReferenceIndex >= 0 ? (refs[s.animateReferenceIndex]?.assetId ?? null) : null,
        camera: s.camera,
        lighting: s.lighting,
        onScreenText: s.onScreenText,
        voiceoverText: s.voiceoverText,
        transition: s.transition,
        audioDirection: s.audioDirection,
        provider,
        status: 'draft',
      })),
    );
  });
  if (usage)
    await ctx.update({ usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } });
  return { scenes: normalized.scenes.length, model: llm.model };
};

export const promptJob: JobHandler = async (ctx) => {
  const db = getDb();
  if (!ctx.job.sceneId) throw new UserFacingError('Job has no scene');
  const [scene] = await db.select().from(scenes).where(eq(scenes.id, ctx.job.sceneId));
  if (!scene) throw new UserFacingError('Scene no longer exists');
  const project = await loadProject(scene.projectId);
  const llm = await getLlm();
  const refs = await db.select().from(references).where(eq(references.projectId, project.id));
  const notes = refs
    .filter(
      (r) =>
        (r.assetId && scene.referenceAssetIds.includes(r.assetId)) ||
        (r.thumbnailAssetId && scene.referenceAssetIds.includes(r.thumbnailAssetId)),
    )
    .map((r) => [r.notes, summarizeAnalysis(r.analysis)].filter(Boolean).join(' – '))
    .filter(Boolean);
  const caps = staticCapabilities(scene.provider as ProviderId);
  const { prompt, usage } = await llm.improvePrompt({
    brief: project.brief ?? null,
    aspectRatio: project.aspectRatio,
    scene,
    referenceNotes: notes,
    maxChars: caps.maxPromptChars,
    brandGuide: (await loadBrandContext(project.brandId))?.guide,
  });
  await db.update(scenes).set({ prompt, updatedAt: new Date() }).where(eq(scenes.id, scene.id));
  if (usage)
    await ctx.update({ usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } });
  return { prompt };
};
