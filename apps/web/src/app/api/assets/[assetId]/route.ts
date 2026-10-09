import { eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { assets, projects } from '@studio/core/db/schema';
import { deleteRel } from '@studio/core/storage';
import { UserFacingError } from '@studio/core/errors';
import { api } from '@/server/api';
import { getAssetOr404, getProjectBundle, getProjectOr404 } from '@/server/data';

/** Delete an uploaded audio asset (music / SFX / uploaded voiceover). */
export const DELETE = api<{ assetId: string }>(async (_req, { params }) => {
  const asset = await getAssetOr404(params.assetId);
  if (!asset.projectId || !['music', 'sfx', 'voiceover'].includes(asset.kind)) {
    throw new UserFacingError('This file cannot be deleted here.', 400);
  }
  const project = await getProjectOr404(asset.projectId);
  const audio = {
    ...project.audioSettings,
    sfx: project.audioSettings.sfx.filter((s) => s.assetId !== asset.id),
  };
  if (audio.musicAssetId === asset.id) audio.musicAssetId = null;
  const db = getDb();
  await db
    .update(projects)
    .set({
      audioSettings: audio,
      voiceoverAssetId: project.voiceoverAssetId === asset.id ? null : project.voiceoverAssetId,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, project.id));
  await db.delete(assets).where(eq(assets.id, asset.id));
  await deleteRel(asset.relPath);
  return getProjectBundle(project.id);
});
