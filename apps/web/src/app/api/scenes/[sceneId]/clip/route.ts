import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { projects, scenes } from '@studio/core/db/schema';
import { createAsset } from '@studio/core/jobs/context';
import { UserFacingError } from '@studio/core/errors';
import { api } from '@/server/api';
import { receiveUpload } from '@/server/upload';
import { getProjectBundle, getProjectOr404, getSceneOr404 } from '@/server/data';
import { activeJobFor } from '@/server/jobs';

/** Replace a scene's footage with an uploaded clip. */
export const POST = api<{ sceneId: string }>(
  async (req, { params }) => {
    const scene = await getSceneOr404(params.sceneId);
    const project = await getProjectOr404(scene.projectId);
    if (await activeJobFor({ sceneId: scene.id, type: 'generation' })) {
      throw new UserFacingError('Cancel the running generation before uploading a replacement.', 409, 'busy');
    }
    const { file } = await receiveUpload(req, {
      allowed: ['video'],
      relDir: path.posix.join('projects', project.id, 'uploads'),
    });
    const asset = await createAsset({
      projectId: project.id,
      kind: 'clip',
      relPath: file.relPath,
      mime: file.sniff.mime,
      originalName: file.originalName,
      meta: { uploaded: true, sceneId: scene.id },
    });
    await getDb()
      .update(scenes)
      .set({
        clipAssetId: asset.id,
        clipSource: 'uploaded',
        status: 'completed',
        error: null,
        thumbnailAssetId: null,
        updatedAt: new Date(),
      })
      .where(eq(scenes.id, scene.id));
    await getDb().update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, project.id));
    return getProjectBundle(project.id);
  },
  { rateLimit: { bucket: 'upload', limit: 60, windowSec: 60 } },
);
