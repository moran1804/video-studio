import { eq, and, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { jobs, projects } from '@studio/core/db/schema';
import {
  ASPECT_RATIOS,
  PLATFORM_IDS,
  VIDEO_PROVIDERS,
  audioSettingsSchema,
  brandingSettingsSchema,
  captionSettingsSchema,
  projectDetailsSchema,
  voiceSettingsSchema,
} from '@studio/core/schemas';
import { deleteProjectDir } from '@studio/core/storage';
import { api, parseJson } from '@/server/api';
import { getProjectBundle, getProjectOr404 } from '@/server/data';
import { brandCaptionDefaults } from '@/server/brand';

type P = { id: string };

export const GET = api<P>(async (_req, { params }) => getProjectBundle(params.id));

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    platform: z.enum(PLATFORM_IDS),
    aspectRatio: z.enum(ASPECT_RATIOS),
    durationSec: z.number().int().min(5).max(180),
    details: projectDetailsSchema,
    brandId: z.string().uuid().nullable(),
    defaultProvider: z.enum(VIDEO_PROVIDERS).nullable(),
    voiceSettings: voiceSettingsSchema,
    audioSettings: audioSettingsSchema,
    captionSettings: captionSettingsSchema,
    brandingSettings: brandingSettingsSchema,
  })
  .partial();

export const PATCH = api<P>(async (req, { params }) => {
  const project = await getProjectOr404(params.id);
  const patch = await parseJson(req, patchSchema);
  if (patch.brandId && patch.brandId !== project.brandId && !patch.captionSettings) {
    patch.captionSettings = await brandCaptionDefaults(patch.brandId, project.captionSettings);
  }
  await getDb()
    .update(projects)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(projects.id, params.id));
  return getProjectBundle(params.id);
});

export const DELETE = api<P>(async (_req, { params }) => {
  await getProjectOr404(params.id);
  const db = getDb();
  // Signal running jobs to stop before the rows disappear.
  await db
    .update(jobs)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(eq(jobs.projectId, params.id), inArray(jobs.status, ['queued', 'running'])));
  await db.delete(projects).where(eq(projects.id, params.id));
  await deleteProjectDir(params.id);
  return { ok: true };
});
