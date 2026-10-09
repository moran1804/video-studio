import 'server-only';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import {
  assets,
  brands,
  characters,
  jobs,
  projects,
  references,
  renders,
  scenes,
  type Job,
} from '@studio/core/db/schema';
import type { QuickOptions } from '@studio/core/jobs/quick';
import { assetDTO } from './data';
import type { AssetDTO } from '@/lib/types';

export interface QuickItem {
  id: string;
  title: string;
  prompt: string;
  createdAt: string;
  platform: string;
  aspectRatio: string;
  durationSec: number;
  brand: { id: string; name: string } | null;
  options: QuickOptions | null;
  attachments: { id: string; url: string; usage: string; name: string }[];
  music: AssetDTO | null;
  job: {
    id: string;
    status: string;
    progress: number;
    stage: string | null;
    error: string | null;
    costEstimateUsd: number | null;
  } | null;
  video: AssetDTO | null;
  thumbnail: AssetDTO | null;
  /** Photoreal stills of the character, shown while the clips are generating. */
  keyframes: string[];
  character: { id: string; name: string } | null;
}

/** Recent one-shot videos for the Create screen, newest first. */
export async function listQuickItems(opts: { limit?: number; ids?: string[] } = {}): Promise<QuickItem[]> {
  const db = getDb();
  const where = opts.ids?.length
    ? inArray(projects.id, opts.ids)
    : sql`${projects.details}->>'source' = 'quick'`;
  const rows = await db
    .select()
    .from(projects)
    .where(where)
    .orderBy(desc(projects.createdAt))
    .limit(opts.limit ?? 30);
  if (!rows.length) return [];
  const ids = rows.map((p) => p.id);
  const [jobRows, renderRows, refRows, brandRows, sceneRows, characterRows] = await Promise.all([
    db
      .select()
      .from(jobs)
      .where(and(inArray(jobs.projectId, ids), eq(jobs.type, 'quick')))
      .orderBy(desc(jobs.createdAt)),
    db
      .select()
      .from(renders)
      .where(and(inArray(renders.projectId, ids), eq(renders.mode, 'final'), eq(renders.status, 'completed')))
      .orderBy(desc(renders.createdAt)),
    db.select().from(references).where(inArray(references.projectId, ids)),
    db.select({ id: brands.id, name: brands.name }).from(brands),
    db
      .select({
        projectId: scenes.projectId,
        position: scenes.position,
        keyframeAssetId: scenes.keyframeAssetId,
      })
      .from(scenes)
      .where(inArray(scenes.projectId, ids)),
    db.select({ id: characters.id, name: characters.name }).from(characters),
  ]);
  const assetIds = [
    ...renderRows.flatMap((r) => [r.videoAssetId, r.thumbnailAssetId]),
    ...refRows.map((r) => r.assetId),
    ...rows.map((p) => p.audioSettings?.musicAssetId ?? null),
  ].filter((x): x is string => Boolean(x));
  const assetRows = assetIds.length ? await db.select().from(assets).where(inArray(assets.id, assetIds)) : [];
  const asset = new Map(assetRows.map((a) => [a.id, a]));
  const latestJob = new Map<string, Job>();
  for (const j of jobRows) if (!latestJob.has(j.projectId!)) latestJob.set(j.projectId!, j);

  return rows.map((p) => {
    const job = latestJob.get(p.id);
    // Only show a video produced after the latest request started.
    const render = renderRows.find((r) => r.projectId === p.id && (!job || r.createdAt >= job.createdAt));
    const brand = brandRows.find((b) => b.id === p.brandId) ?? null;
    return {
      id: p.id,
      title: p.name,
      prompt: p.details?.request ?? p.name,
      createdAt: p.createdAt.toISOString(),
      platform: p.platform,
      aspectRatio: p.aspectRatio,
      durationSec: p.durationSec,
      brand,
      options: (job?.payload as QuickOptions | undefined) ?? null,
      attachments: refRows
        .filter((r) => r.projectId === p.id && r.assetId && asset.get(r.assetId)?.mime.startsWith('image/'))
        .map((r) => ({ id: r.id, url: `/api/files/${r.assetId}`, usage: r.usage, name: r.title })),
      music: assetDTO(asset.get(p.audioSettings?.musicAssetId ?? '')),
      job: job
        ? {
            id: job.id,
            status: job.status,
            progress: job.progress,
            stage: ((job.result as { stage?: string } | null)?.stage ?? null) as string | null,
            error: job.error,
            costEstimateUsd: job.costEstimateUsd,
          }
        : null,
      video: render ? assetDTO(asset.get(render.videoAssetId ?? '')) : null,
      thumbnail: render ? assetDTO(asset.get(render.thumbnailAssetId ?? '')) : null,
      keyframes: sceneRows
        .filter((sc) => sc.projectId === p.id && sc.keyframeAssetId)
        .sort((a, b) => a.position - b.position)
        .map((sc) => `/api/files/${sc.keyframeAssetId}`),
      character:
        characterRows.find((ch) => ch.id === (job?.payload as QuickOptions | undefined)?.characterId) ?? null,
    };
  });
}
