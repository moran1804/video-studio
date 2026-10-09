import 'server-only';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { assetRole, loadBrandContext } from '@studio/core/jobs/brand';
import { getDb } from '@studio/core/db';
import {
  assets,
  brands,
  jobs,
  projects,
  references,
  renders,
  scenes,
  type Asset,
  type Brand,
  type Job,
  type Project,
  type Reference,
  type Render,
  type Scene,
} from '@studio/core/db/schema';
import { NotFoundError } from '@studio/core/errors';
import { isUuid } from '@studio/core/security/paths';
import { deriveProjectStatus } from '@studio/core/status';
import {
  audioSettingsSchema,
  brandingSettingsSchema,
  captionSettingsSchema,
  voiceSettingsSchema,
} from '@studio/core/schemas';
import type {
  AssetDTO,
  BrandDetailDTO,
  BrandDTO,
  JobDTO,
  ProjectBundle,
  ProjectDTO,
  ProjectSummary,
  ReferenceDTO,
  RenderDTO,
  SceneDTO,
} from '@/lib/types';

export const fileUrl = (id: string | null | undefined) => (id ? `/api/files/${id}` : null);

export function assetDTO(a: Asset | undefined | null): AssetDTO | null {
  if (!a) return null;
  const words = Array.isArray(a.meta?.words) ? (a.meta.words as unknown[]).length : undefined;
  return {
    id: a.id,
    kind: a.kind,
    mime: a.mime,
    name: a.originalName,
    sizeBytes: a.sizeBytes,
    durationSec: a.durationSec,
    width: a.width,
    height: a.height,
    url: `/api/files/${a.id}`,
    downloadUrl: `/api/files/${a.id}?download=1`,
    createdAt: a.createdAt.toISOString(),
    meta:
      typeof a.meta?.text === 'string' || words !== undefined
        ? { text: (a.meta.text as string | undefined)?.slice(0, 2000), wordCount: words }
        : undefined,
  };
}

export function jobDTO(j: Job, projectName?: string | null): JobDTO {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    progress: j.progress,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    provider: j.provider,
    error: j.error,
    projectId: j.projectId,
    projectName,
    sceneId: j.sceneId,
    referenceId: j.referenceId,
    renderId: j.renderId,
    costEstimateUsd: j.costEstimateUsd,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

export function brandDTO(b: Brand, logo?: Asset | null): BrandDTO {
  return {
    id: b.id,
    name: b.name,
    logo: assetDTO(logo),
    primaryColor: b.primaryColor,
    secondaryColor: b.secondaryColor,
    accentColor: b.accentColor,
    headingFont: b.headingFont,
    bodyFont: b.bodyFont,
    introText: b.introText,
    outroText: b.outroText,
    defaultCta: b.defaultCta,
    handles: b.handles,
    designSystem: b.designSystem ?? null,
    designStatus: b.designStatus,
  };
}

/** Brand with its assets, latest design-system job and the rendered AI guide. */
export async function getBrandDetail(id: string): Promise<BrandDetailDTO> {
  const b = await getBrandOr404(id);
  const ctx = await loadBrandContext(b.id);
  const list = ctx?.assets ?? [];
  const logo = list.find((a) => a.id === b.logoAssetId) ?? null;
  const [job] = await getDb()
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, 'brand'), sql`${jobs.payload}->>'brandId' = ${b.id}`))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return {
    ...brandDTO(b, logo),
    assets: [...list]
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())
      .map((a) => ({
        ...assetDTO(a)!,
        role: assetRole(a),
        label: String(a.meta?.label ?? ''),
        notes: String(a.meta?.notes ?? ''),
        isOverlayLogo: a.id === b.logoAssetId,
      })),
    job: job ? jobDTO(job) : null,
    guide: ctx?.guide ?? '',
  };
}

function projectDTO(p: Project, status: { key: string; label: string }): ProjectDTO {
  return {
    id: p.id,
    name: p.name,
    platform: p.platform,
    aspectRatio: p.aspectRatio,
    durationSec: p.durationSec,
    details: p.details,
    brandId: p.brandId,
    defaultProvider: p.defaultProvider,
    brief: p.brief ?? null,
    briefStatus: p.briefStatus,
    voiceSettings: voiceSettingsSchema.parse(p.voiceSettings ?? {}),
    audioSettings: audioSettingsSchema.parse(p.audioSettings ?? {}),
    captionSettings: captionSettingsSchema.parse(p.captionSettings ?? {}),
    brandingSettings: brandingSettingsSchema.parse(p.brandingSettings ?? {}),
    status,
    thumbnailUrl: fileUrl(p.thumbnailAssetId),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function getProjectOr404(id: string): Promise<Project> {
  if (!isUuid(id)) throw new NotFoundError('Project');
  const [p] = await getDb().select().from(projects).where(eq(projects.id, id));
  if (!p) throw new NotFoundError('Project');
  return p;
}

export async function getSceneOr404(id: string): Promise<Scene> {
  if (!isUuid(id)) throw new NotFoundError('Scene');
  const [s] = await getDb().select().from(scenes).where(eq(scenes.id, id));
  if (!s) throw new NotFoundError('Scene');
  return s;
}

export async function getReferenceOr404(id: string): Promise<Reference> {
  if (!isUuid(id)) throw new NotFoundError('Reference');
  const [r] = await getDb().select().from(references).where(eq(references.id, id));
  if (!r) throw new NotFoundError('Reference');
  return r;
}

export async function getAssetOr404(id: string): Promise<Asset> {
  if (!isUuid(id)) throw new NotFoundError('File');
  const [a] = await getDb().select().from(assets).where(eq(assets.id, id));
  if (!a) throw new NotFoundError('File');
  return a;
}

export async function getBrandOr404(id: string): Promise<Brand> {
  if (!isUuid(id)) throw new NotFoundError('Brand');
  const [b] = await getDb().select().from(brands).where(eq(brands.id, id));
  if (!b) throw new NotFoundError('Brand');
  return b;
}

const ACTIVE = ['queued', 'running'];

function statusFor(p: Project, sceneRows: Scene[], jobRows: Job[], renderRows: Render[]) {
  const active = jobRows.filter((j) => ACTIVE.includes(j.status));
  const failed = latestFailures(jobRows);
  return deriveProjectStatus({
    briefStatus: p.briefStatus,
    sceneStatuses: sceneRows.map((s) => s.status),
    activeJobTypes: active.map((j) => j.type),
    failedJobCount: failed.length,
    hasFinalExport: renderRows.some((r) => r.mode === 'final' && r.status === 'completed'),
  });
}

/** Failed jobs that have not been superseded by a later success for the same target. */
function latestFailures(jobRows: Job[]): Job[] {
  const byTarget = new Map<string, Job>();
  for (const j of [...jobRows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const key = `${j.type}:${j.sceneId ?? ''}:${j.referenceId ?? ''}:${j.type === 'render' ? 'r' : (j.renderId ?? '')}`;
    byTarget.set(key, j);
  }
  return [...byTarget.values()].filter((j) => j.status === 'failed');
}

export async function getProjectBundle(id: string): Promise<ProjectBundle> {
  const db = getDb();
  const p = await getProjectOr404(id);
  const [sceneRows, refRows, renderRows, jobRows, assetRows] = await Promise.all([
    db.select().from(scenes).where(eq(scenes.projectId, id)).orderBy(asc(scenes.position)),
    db.select().from(references).where(eq(references.projectId, id)).orderBy(asc(references.createdAt)),
    db.select().from(renders).where(eq(renders.projectId, id)).orderBy(desc(renders.createdAt)).limit(30),
    db.select().from(jobs).where(eq(jobs.projectId, id)).orderBy(desc(jobs.createdAt)).limit(300),
    db.select().from(assets).where(eq(assets.projectId, id)),
  ]);
  const assetMap = new Map(assetRows.map((a) => [a.id, a]));
  const brandRow = p.brandId
    ? (await db.select().from(brands).where(eq(brands.id, p.brandId)))[0]
    : undefined;
  const brandLogo = brandRow?.logoAssetId
    ? (await db.select().from(assets).where(eq(assets.id, brandRow.logoAssetId)))[0]
    : undefined;

  const latestJobFor = (pred: (j: Job) => boolean) => jobRows.find(pred);
  const sceneDTOs: SceneDTO[] = sceneRows.map((s) => {
    const job = latestJobFor((j) => j.sceneId === s.id && j.type === 'generation');
    return {
      id: s.id,
      position: s.position,
      purpose: s.purpose,
      durationSec: s.durationSec,
      visualDescription: s.visualDescription,
      prompt: s.prompt,
      referenceAssetIds: s.referenceAssetIds,
      animateAssetId: s.animateAssetId,
      animateUrl: fileUrl(s.animateAssetId),
      camera: s.camera,
      lighting: s.lighting,
      onScreenText: s.onScreenText,
      voiceoverText: s.voiceoverText,
      transition: s.transition,
      audioDirection: s.audioDirection,
      provider: s.provider,
      status: s.status,
      error: s.error,
      clipSource: s.clipSource,
      clip: assetDTO(s.clipAssetId ? assetMap.get(s.clipAssetId) : undefined),
      thumbnailUrl: fileUrl(s.thumbnailAssetId),
      voiceover: assetDTO(s.voiceoverAssetId ? assetMap.get(s.voiceoverAssetId) : undefined),
      job: job ? jobDTO(job) : null,
    };
  });
  const refDTOs: ReferenceDTO[] = refRows.map((r) => ({
    id: r.id,
    kind: r.kind,
    category: r.category,
    title: r.title,
    notes: r.notes,
    usage: r.usage,
    sourceUrl: r.sourceUrl,
    platform: r.platform,
    asset: assetDTO(r.assetId ? assetMap.get(r.assetId) : undefined),
    thumbnailUrl:
      fileUrl(r.thumbnailAssetId) ??
      (r.assetId && assetMap.get(r.assetId)?.mime.startsWith('image/') ? fileUrl(r.assetId) : null),
    analysisStatus: r.analysisStatus,
    analysis: r.analysis ?? null,
    frameUrls: (r.analysis?.frames ?? []).map((f) => `/api/files/${f}`),
    error: r.error,
    createdAt: r.createdAt.toISOString(),
  }));
  const renderDTOs: RenderDTO[] = renderRows.map((r) => ({
    id: r.id,
    mode: r.mode,
    status: r.status,
    progress: r.progress,
    width: r.width,
    height: r.height,
    durationSec: r.durationSec,
    video: assetDTO(r.videoAssetId ? assetMap.get(r.videoAssetId) : undefined),
    srt: assetDTO(r.srtAssetId ? assetMap.get(r.srtAssetId) : undefined),
    thumbnailUrl: fileUrl(r.thumbnailAssetId),
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }));
  const audioAssets = assetRows
    .filter((a) => ['music', 'sfx'].includes(a.kind) || (a.kind === 'voiceover' && a.meta?.uploaded === true))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((a) => assetDTO(a)!);
  const failed = latestFailures(jobRows);
  const visibleJobs = [
    ...jobRows.filter((j) => ACTIVE.includes(j.status)),
    ...failed,
    ...jobRows.filter((j) => j.status === 'completed').slice(0, 20),
  ];
  return {
    project: projectDTO(p, statusFor(p, sceneRows, jobRows, renderRows)),
    scenes: sceneDTOs,
    references: refDTOs,
    renders: renderDTOs,
    jobs: [...new Map(visibleJobs.map((j) => [j.id, j])).values()].map((j) => jobDTO(j)),
    audioAssets,
    voiceover: assetDTO(p.voiceoverAssetId ? assetMap.get(p.voiceoverAssetId) : undefined),
    brand: brandRow ? brandDTO(brandRow, brandLogo) : null,
    activeJobs: jobRows.filter((j) => ACTIVE.includes(j.status)).length,
  };
}

export async function listProjectSummaries(): Promise<ProjectSummary[]> {
  const db = getDb();
  const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [sceneRows, jobRows, renderRows] = await Promise.all([
    db
      .select({ id: scenes.id, projectId: scenes.projectId, status: scenes.status })
      .from(scenes)
      .where(inArray(scenes.projectId, ids)),
    db
      .select()
      .from(jobs)
      .where(
        and(
          inArray(jobs.projectId, ids),
          or(inArray(jobs.status, ['queued', 'running', 'failed']), eq(jobs.status, 'completed')),
        ),
      )
      .orderBy(desc(jobs.createdAt))
      .limit(3000),
    db.select().from(renders).where(inArray(renders.projectId, ids)).orderBy(desc(renders.createdAt)),
  ]);
  const exportIds = renderRows
    .filter((r) => r.mode === 'final' && r.status === 'completed' && r.videoAssetId)
    .map((r) => r.videoAssetId!);
  const exportAssets = exportIds.length
    ? await db.select().from(assets).where(inArray(assets.id, exportIds))
    : [];
  const exportMap = new Map(exportAssets.map((a) => [a.id, a]));

  return rows.map((p) => {
    const ps = sceneRows.filter((s) => s.projectId === p.id) as Scene[];
    const pj = jobRows.filter((j) => j.projectId === p.id);
    const pr = renderRows.filter((r) => r.projectId === p.id);
    const latestFinal = pr.find(
      (r) =>
        r.mode === 'final' && r.status === 'completed' && r.videoAssetId && exportMap.has(r.videoAssetId),
    );
    const running = pr.find((r) => r.status === 'running' || r.status === 'queued');
    return {
      id: p.id,
      name: p.name,
      platform: p.platform,
      aspectRatio: p.aspectRatio,
      durationSec: p.durationSec,
      createdAt: p.createdAt.toISOString(),
      status: statusFor(p, ps, pj, pr),
      thumbnailUrl: fileUrl(p.thumbnailAssetId),
      latestExport: latestFinal
        ? {
            url: `/api/files/${latestFinal.videoAssetId}`,
            downloadUrl: `/api/files/${latestFinal.videoAssetId}?download=1`,
            createdAt: latestFinal.createdAt.toISOString(),
          }
        : null,
      progress: {
        active: pj.filter((j) => ACTIVE.includes(j.status)).length,
        completedScenes: ps.filter((s) => s.status === 'completed').length,
        totalScenes: ps.length,
        renderProgress: running ? running.progress : null,
      },
      failedJobs: latestFailures(pj).map((j) => jobDTO(j, p.name)),
    };
  });
}

export async function touchProject(id: string): Promise<void> {
  await getDb().update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, id));
}
