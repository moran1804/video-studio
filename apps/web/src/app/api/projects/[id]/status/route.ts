import crypto from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { jobs, projects, references, renders, scenes } from '@studio/core/db/schema';
import { api } from '@/server/api';
import { getProjectOr404 } from '@/server/data';

/**
 * Lightweight polling endpoint: returns a fingerprint of everything that
 * changes during background work, so the UI only refetches when needed.
 */
export const GET = api<{ id: string }>(async (_req, { params }) => {
  await getProjectOr404(params.id);
  const db = getDb();
  const [active, sceneRows, renderRows, refRows, proj] = await Promise.all([
    db
      .select({ id: jobs.id, status: jobs.status, progress: jobs.progress, error: jobs.error })
      .from(jobs)
      .where(and(eq(jobs.projectId, params.id), inArray(jobs.status, ['queued', 'running']))),
    db
      .select({ id: scenes.id, status: scenes.status, u: scenes.updatedAt })
      .from(scenes)
      .where(eq(scenes.projectId, params.id)),
    db
      .select({ id: renders.id, status: renders.status, progress: renders.progress })
      .from(renders)
      .where(eq(renders.projectId, params.id)),
    db
      .select({ id: references.id, status: references.analysisStatus })
      .from(references)
      .where(eq(references.projectId, params.id)),
    db
      .select({ u: projects.updatedAt, b: projects.briefStatus, v: projects.voiceoverAssetId })
      .from(projects)
      .where(eq(projects.id, params.id)),
  ]);
  const fingerprint = crypto
    .createHash('sha1')
    .update(
      JSON.stringify([
        active,
        sceneRows,
        renderRows.map((r) => [r.id, r.status, Math.round(r.progress * 50)]),
        refRows,
        proj,
      ]),
    )
    .digest('hex');
  return { activeJobs: active.length, fingerprint };
});
