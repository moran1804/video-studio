import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { assets, projects, references, scenes, type Reference } from '@studio/core/db/schema';
import { ANIMATE_DEFAULT_PROMPT } from '@studio/core/schemas';
import { staticCapabilities } from '@studio/core/providers/registry';
import type { ProviderId } from '@studio/core/providers/video/types';
import { getDefaults } from '@studio/core/settings';
import { UserFacingError } from '@studio/core/errors';

/**
 * Quick path for "animate this poster": marks the reference as animate and
 * appends a ready-to-generate scene that uses the image as its start frame.
 * No brief or storyboard is required.
 */
export async function createAnimateScene(
  ref: Reference,
  opts: { prompt?: string; durationSec?: number } = {},
) {
  const db = getDb();
  const [asset] = ref.assetId ? await db.select().from(assets).where(eq(assets.id, ref.assetId)) : [];
  if (!asset?.mime.startsWith('image/')) throw new UserFacingError('Only uploaded images can be animated.');
  const [project] = await db.select().from(projects).where(eq(projects.id, ref.projectId));
  if (!project) throw new UserFacingError('Project no longer exists');
  const provider = (project.defaultProvider ?? (await getDefaults()).videoProvider) as ProviderId;
  const durations = staticCapabilities(provider).durations;
  const wanted = opts.durationSec ?? Math.min(8, project.durationSec);
  const durationSec = [...durations].sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted))[0] ?? 6;

  await db
    .update(references)
    .set({
      usage: 'animate',
      category: ['image', 'logo', 'poster', 'artwork'].includes(ref.category) ? ref.category : 'artwork',
    })
    .where(eq(references.id, ref.id));
  const [{ next }] = await db
    .select({ next: sql<number>`coalesce(max(${scenes.position}) + 1, 0)::int` })
    .from(scenes)
    .where(eq(scenes.projectId, project.id));
  const [scene] = await db
    .insert(scenes)
    .values({
      projectId: project.id,
      position: next,
      purpose: `Animate ${ref.title || 'artwork'}`.slice(0, 200),
      durationSec,
      visualDescription: 'The uploaded artwork comes to life with subtle, cinematic motion.',
      prompt: opts.prompt?.trim() || ANIMATE_DEFAULT_PROMPT,
      referenceAssetIds: [asset.id],
      animateAssetId: asset.id,
      camera: 'Slow push-in with gentle parallax',
      transition: 'fade',
      provider,
    })
    .returning();
  await db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, project.id));
  return scene!;
}
