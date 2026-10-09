import { and, eq } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { projects, references } from '@studio/core/db/schema';
import { enqueueJob } from '@studio/core/queues';
import { quickOptionsSchema } from '@studio/core/jobs/quick';
import { getImageProvider, getTts, getVideoProvider } from '@studio/core/providers/registry';
import { VIDEO_PROVIDERS } from '@studio/core/schemas';
import type { ProviderId } from '@studio/core/providers/video/types';
import { getDefaults } from '@studio/core/settings';
import { UserFacingError } from '@studio/core/errors';
import { api, parseJson } from '@/server/api';
import { getProjectOr404 } from '@/server/data';
import { activeJobFor } from '@/server/jobs';
import { listQuickItems } from '@/server/quick';
import { getCharacterOr404 } from '@/server/characters';

/** Start (or restart) the one-shot pipeline: plan → generate → voiceover → render. */
export const POST = api<{ id: string }>(
  async (req, { params }) => {
    const project = await getProjectOr404(params.id);
    const opts = await parseJson(req, quickOptionsSchema);
    if (opts.provider && !(VIDEO_PROVIDERS as readonly string[]).includes(opts.provider)) {
      throw new UserFacingError('Unknown video model');
    }
    if (await activeJobFor({ projectId: project.id, type: 'quick' })) {
      throw new UserFacingError('This video is already being made.', 409, 'busy');
    }
    // Fail fast on missing configuration instead of after minutes of work.
    const defaults = await getDefaults();
    if (opts.characterId) {
      const character = await getCharacterOr404(opts.characterId);
      if (character.status === 'none' || character.status === 'preparing') {
        throw new UserFacingError(
          `${character.name} isn't ready yet – prepare and approve the references first.`,
        );
      }
      await getImageProvider();
      // Veo 3.1 is the most reliable model for photoreal people with reference images.
      if (!opts.provider) opts.provider = 'veo';
      const [motion] = await getDb()
        .select({ id: references.id })
        .from(references)
        .where(and(eq(references.projectId, project.id), eq(references.usage, 'motion')));
      if (motion) await getVideoProvider('kling');
    }
    await getVideoProvider(
      (opts.provider || project.defaultProvider || defaults.videoProvider) as ProviderId,
    );
    if (opts.voiceover) {
      const tts = await getTts();
      // "Default voice": the Settings default, else the first voice on the account.
      if (!opts.voiceId) opts.voiceId = defaults.voiceId || ((await tts.listVoices())[0]?.id ?? '');
      if (!opts.voiceId) throw new UserFacingError('No voices are available on your ElevenLabs account.');
    }
    await getDb()
      .update(projects)
      .set({
        details: { ...project.details, source: 'quick', request: opts.prompt },
        defaultProvider: opts.provider || project.defaultProvider,
        updatedAt: new Date(),
      })
      .where(eq(projects.id, project.id));
    await enqueueJob({ type: 'quick', projectId: project.id, payload: opts });
    return { item: (await listQuickItems({ ids: [project.id] }))[0] };
  },
  { rateLimit: { bucket: 'generate', limit: 30, windowSec: 60 } },
);
