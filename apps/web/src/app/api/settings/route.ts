import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@studio/core/db';
import { jobs } from '@studio/core/db/schema';
import { getConfig } from '@studio/core/config';
import { getRedis } from '@studio/core/redis';
import { getQueue, QUEUE_NAMES } from '@studio/core/queues';
import { describeApiKeys, getDefaults, setDefaults } from '@studio/core/settings';
import { storageUsage } from '@studio/core/storage';
import { staticCapabilities, PROVIDER_IDS } from '@studio/core/providers/registry';
import { VIDEO_PROVIDER_LABELS, VIDEO_PROVIDERS } from '@studio/core/schemas';
import { api, parseJson } from '@/server/api';

let storageCache: { at: number; value: Awaited<ReturnType<typeof storageUsage>> } | undefined;

export const GET = api(async () => {
  const c = getConfig();
  const [keys, defaults] = await Promise.all([describeApiKeys(), getDefaults()]);
  if (!storageCache || Date.now() - storageCache.at > 60_000)
    storageCache = { at: Date.now(), value: await storageUsage() };

  let worker: { at: number; host: string; ffmpeg: string | null } | null = null;
  try {
    const hb = await getRedis().get('studio:worker:heartbeat');
    worker = hb ? JSON.parse(hb) : null;
  } catch {
    worker = null;
  }
  const queues: Record<string, Record<string, number> | { error: string }> = {};
  for (const name of QUEUE_NAMES) {
    try {
      queues[name] = await getQueue(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    } catch (err) {
      queues[name] = { error: (err as Error).message };
    }
  }
  const usageRows = await getDb()
    .select({
      type: jobs.type,
      provider: jobs.provider,
      count: sql<number>`count(*)::int`,
      cost: sql<number>`coalesce(sum(${jobs.costEstimateUsd}), 0)::float`,
      inputTokens: sql<number>`coalesce(sum((${jobs.usage}->>'inputTokens')::int), 0)::int`,
      outputTokens: sql<number>`coalesce(sum((${jobs.usage}->>'outputTokens')::int), 0)::int`,
      characters: sql<number>`coalesce(sum((${jobs.usage}->>'characters')::int), 0)::int`,
    })
    .from(jobs)
    .where(sql`${jobs.status} = 'completed' and ${jobs.createdAt} > now() - interval '30 days'`)
    .groupBy(jobs.type, jobs.provider);

  const providerConfigured = (id: string) =>
    c.MOCK_PROVIDERS || id === 'mock'
      ? true
      : id === 'runway'
        ? keys.runway.configured
        : keys.google.configured &&
          (id === 'veo' ? Boolean(c.GOOGLE_VEO_MODEL) : Boolean(c.GOOGLE_VIDEO_MODEL));

  return {
    app: {
      name: c.APP_NAME,
      url: c.APP_URL,
      authEnabled: c.AUTH_ENABLED,
      mockProviders: c.MOCK_PROVIDERS,
      maxUploadMb: c.MAX_UPLOAD_MB,
      dataRoot: c.DATA_ROOT,
    },
    keys,
    defaults,
    models: {
      openai: defaults.llmModel,
      openaiEnv: c.OPENAI_MODEL,
      vision: c.OPENAI_VISION_MODEL ?? defaults.llmModel,
      transcription: c.OPENAI_TRANSCRIPTION_MODEL,
      google: c.GOOGLE_VIDEO_MODEL ?? null,
      veo: c.GOOGLE_VEO_MODEL,
      runway: c.RUNWAY_VIDEO_MODEL,
      elevenlabs: c.ELEVENLABS_MODEL,
      image: c.GOOGLE_IMAGE_MODEL,
      kling: c.KLING_MOTION_MODEL,
    },
    providers: PROVIDER_IDS.map((id) => ({
      id,
      label: VIDEO_PROVIDER_LABELS[id],
      configured: providerConfigured(id),
      capabilities: staticCapabilities(id),
    })),
    worker: worker ? { ...worker, ageSec: Math.round((Date.now() - worker.at) / 1000) } : null,
    queues,
    storage: storageCache.value,
    usage: usageRows,
  };
});

const patchSchema = z.object({
  defaults: z
    .object({
      videoProvider: z.enum(VIDEO_PROVIDERS),
      llmModel: z.string().trim().max(100),
      voiceId: z.string().trim().max(100),
      voiceName: z.string().trim().max(200),
    })
    .partial(),
});

export const PATCH = api(async (req) => {
  const { defaults } = await parseJson(req, patchSchema);
  return { defaults: await setDefaults(defaults) };
});
