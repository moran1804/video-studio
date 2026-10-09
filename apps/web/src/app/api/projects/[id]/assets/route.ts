import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { projects } from '@studio/core/db/schema';
import { createAsset } from '@studio/core/jobs/context';
import { enqueueJob } from '@studio/core/queues';
import { voiceSettingsSchema } from '@studio/core/schemas';
import { getLlmOptional } from '@studio/core/providers/registry';
import { UserFacingError } from '@studio/core/errors';
import { api } from '@/server/api';
import { receiveUpload } from '@/server/upload';
import { getProjectBundle, getProjectOr404 } from '@/server/data';

const KINDS = ['music', 'sfx', 'voiceover'] as const;

/** Upload licensed music, sound effects or a personally recorded voiceover. */
export const POST = api<{ id: string }>(
  async (req, { params }) => {
    const project = await getProjectOr404(params.id);
    const kindParam = req.nextUrl.searchParams.get('kind') ?? '';
    if (!(KINDS as readonly string[]).includes(kindParam))
      throw new UserFacingError('kind must be music, sfx or voiceover');
    const kind = kindParam as (typeof KINDS)[number];
    const { file } = await receiveUpload(req, {
      allowed: ['audio'],
      relDir: path.posix.join('projects', project.id, 'audio'),
    });
    const asset = await createAsset({
      projectId: project.id,
      kind,
      relPath: file.relPath,
      mime: file.sniff.mime,
      originalName: file.originalName,
      meta: { uploaded: true },
    });
    const db = getDb();
    if (kind === 'voiceover') {
      const voice = { ...voiceSettingsSchema.parse(project.voiceSettings ?? {}), mode: 'uploaded' as const };
      await db
        .update(projects)
        .set({ voiceoverAssetId: asset.id, voiceSettings: voice, updatedAt: new Date() })
        .where(eq(projects.id, project.id));
      // Transcribe for accurate caption timing when a language model is available.
      if (await getLlmOptional())
        await enqueueJob({ type: 'transcribe', projectId: project.id, payload: { assetId: asset.id } });
    } else if (kind === 'music' && !project.audioSettings?.musicAssetId) {
      await db
        .update(projects)
        .set({ audioSettings: { ...project.audioSettings, musicAssetId: asset.id }, updatedAt: new Date() })
        .where(eq(projects.id, project.id));
    }
    return getProjectBundle(project.id);
  },
  { rateLimit: { bucket: 'upload', limit: 60, windowSec: 60 } },
);
