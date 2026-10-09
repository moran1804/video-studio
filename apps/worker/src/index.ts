import http from 'node:http';
import os from 'node:os';
import { Worker, type Job as BullJob } from 'bullmq';
import { getConfig, validateRuntimeConfig, ConfigError } from '@studio/core/config';
import { getLogger } from '@studio/core/logger';
import { getPool, closeDb } from '@studio/core/db';
import { createRedis, getRedis, closeRedis } from '@studio/core/redis';
import {
  closeQueues,
  QUEUE_NAMES,
  type JobType,
  type QueueName,
  type QueuePayload,
} from '@studio/core/queues';
import { ensureBaseLayout, cleanStaleTemp } from '@studio/core/storage';
import { ffmpegVersion } from '@studio/core/ffmpeg/exec';
import { runTracked } from '@studio/core/jobs/context';
import { HANDLERS } from '@studio/core/jobs/registry';
import { recoverJobs } from '@studio/core/jobs/recovery';
import { registerSecret } from '@studio/core/security/redact';

process.env.SERVICE_NAME = 'worker';
const log = getLogger('worker');

async function main() {
  let config;
  try {
    config = getConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }
  const { errors, warnings } = validateRuntimeConfig('worker', config);
  warnings.forEach((w) => log.warn(`config: ${w}`));
  if (errors.length) {
    errors.forEach((e) => log.error(`config: ${e}`));
    process.exit(1);
  }
  [
    config.OPENAI_API_KEY,
    config.GOOGLE_GEMINI_API_KEY,
    config.RUNWAY_API_KEY,
    config.ELEVENLABS_API_KEY,
    config.SESSION_SECRET,
  ].forEach(registerSecret);

  await ensureBaseLayout();
  const removed = await cleanStaleTemp(12);
  if (removed) log.info({ removed }, 'removed stale temp directories');

  const version = await ffmpegVersion();
  if (!version) log.error('ffmpeg was not found in PATH – rendering and analysis will fail');
  else log.info({ ffmpeg: version }, 'ffmpeg available');

  const concurrency: Record<QueueName, number> = {
    analysis: 2,
    llm: 3,
    generation: Math.max(1, config.GENERATION_CONCURRENCY),
    voiceover: 2,
    render: Math.max(1, config.RENDER_CONCURRENCY),
    // Orchestrators mostly wait on the other queues.
    pipeline: 4,
  };

  const workers = QUEUE_NAMES.map((name) => {
    const w = new Worker<QueuePayload>(
      name,
      async (job: BullJob<QueuePayload>) => {
        const entry = HANDLERS[job.name as JobType];
        if (!entry) throw new Error(`No handler for job type ${job.name}`);
        await runTracked(job, entry.handler, entry.onFailure);
      },
      {
        connection: createRedis(),
        prefix: 'studio',
        concurrency: concurrency[name],
        // Long-running jobs keep their lock renewed; stalled jobs (worker crash) are retried.
        lockDuration: 60_000,
        stalledInterval: 30_000,
        maxStalledCount: 3,
      },
    );
    w.on('error', (err) => log.error({ err, queue: name }, 'worker error'));
    return w;
  });

  // Reconcile DB and queues after (re)start.
  await recoverJobs().catch((err) => log.error({ err }, 'job recovery failed'));

  // Heartbeat for the Settings page / health checks.
  const heartbeat = async () => {
    try {
      await getRedis().set(
        'studio:worker:heartbeat',
        JSON.stringify({
          at: Date.now(),
          host: os.hostname(),
          ffmpeg: version,
          pid: process.pid,
          concurrency,
        }),
        'EX',
        60,
      );
    } catch (err) {
      log.warn({ err }, 'heartbeat failed');
    }
  };
  await heartbeat();
  const hbTimer = setInterval(heartbeat, 15_000);

  const server = http.createServer(async (req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    try {
      await getPool().query('select 1');
      await getRedis().ping();
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, ffmpeg: Boolean(version) }));
    } catch (err) {
      res
        .writeHead(503, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: String((err as Error).message) }));
    }
  });
  server.listen(config.WORKER_HEALTH_PORT, '0.0.0.0', () =>
    log.info({ port: config.WORKER_HEALTH_PORT }, 'worker health endpoint listening'),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down worker (waiting for active jobs to reach a safe point)');
    clearInterval(hbTimer);
    server.close();
    const force = setTimeout(() => process.exit(0), 25_000);
    await Promise.allSettled(workers.map((w) => w.close()));
    await closeQueues().catch(() => undefined);
    await closeRedis();
    await closeDb();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  log.info('worker started');
}

process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'));
main().catch((err) => {
  log.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
