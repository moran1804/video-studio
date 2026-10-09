import fs from 'node:fs/promises';
import path from 'node:path';
import { UnrecoverableError, type Job as BullJob } from 'bullmq';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, jobs, type Asset, type Job } from '../db/schema';
import { isRetryable } from '../errors';
import { redactError } from '../security/redact';
import { getLogger } from '../logger';
import { absPath, ensureParentDir, fileSize } from '../storage';
import type { QueuePayload } from '../queues';

const log = getLogger('jobs');

export interface JobContext {
  job: Job;
  attempt: number;
  signal: AbortSignal;
  setProgress(fraction: number): Promise<void>;
  update(
    patch: Partial<Pick<Job, 'providerJobId' | 'costEstimateUsd' | 'usage' | 'result' | 'provider'>>,
  ): Promise<void>;
  isCancelled(): Promise<boolean>;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | void>;
export type FailureHook = (job: Job, message: string) => Promise<void>;

export class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled');
    this.name = 'JobCancelledError';
  }
}

export async function getJobRow(id: string): Promise<Job | undefined> {
  const [row] = await getDb().select().from(jobs).where(eq(jobs.id, id));
  return row;
}

async function patchJob(id: string, patch: Partial<Job>): Promise<void> {
  await getDb()
    .update(jobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(jobs.id, id));
}

/**
 * Wrap a queue handler with DB status tracking, progress throttling,
 * cancellation and retry classification. Non-retryable errors (or the final
 * attempt) mark the job failed and call the failure hook.
 */
export async function runTracked(
  bullJob: Pick<BullJob<QueuePayload>, 'data' | 'attemptsMade' | 'opts'>,
  handler: JobHandler,
  onFailure?: FailureHook,
): Promise<void> {
  const row = await getJobRow(bullJob.data.jobId);
  if (!row) {
    log.warn({ jobId: bullJob.data.jobId }, 'job row missing; skipping');
    return;
  }
  if (row.status === 'cancelled' || row.status === 'completed') return;

  const attempt = bullJob.attemptsMade + 1;
  const maxAttempts = bullJob.opts.attempts ?? 1;
  await patchJob(row.id, { status: 'running', attempts: attempt, startedAt: new Date(), error: null });

  const controller = new AbortController();
  let lastProgressWrite = 0;
  let lastProgress = -1;
  const cancelPoll = setInterval(async () => {
    try {
      const cur = await getJobRow(row.id);
      if (cur?.status === 'cancelled') controller.abort();
    } catch {
      /* ignore */
    }
  }, 3000);

  const ctx: JobContext = {
    job: row,
    attempt,
    signal: controller.signal,
    async setProgress(fraction) {
      const now = Date.now();
      const f = Math.max(0, Math.min(1, fraction));
      if (now - lastProgressWrite < 1000 && Math.abs(f - lastProgress) < 0.05 && f < 1) return;
      lastProgressWrite = now;
      lastProgress = f;
      await patchJob(row.id, { progress: f });
    },
    async update(patch) {
      Object.assign(ctx.job, patch);
      await patchJob(row.id, patch);
    },
    async isCancelled() {
      if (controller.signal.aborted) return true;
      const cur = await getJobRow(row.id);
      return cur?.status === 'cancelled';
    },
  };

  try {
    const result = await handler(ctx);
    if (await ctx.isCancelled()) return;
    await patchJob(row.id, {
      status: 'completed',
      progress: 1,
      finishedAt: new Date(),
      result: result ?? ctx.job.result ?? null,
    });
  } catch (err) {
    if (err instanceof JobCancelledError || (await ctx.isCancelled())) {
      log.info({ jobId: row.id }, 'job cancelled');
      return;
    }
    const message = redactError(err);
    const final = !isRetryable(err) || attempt >= maxAttempts;
    log.error({ jobId: row.id, type: row.type, attempt, final, err }, `job failed: ${message}`);
    if (final) {
      await patchJob(row.id, { status: 'failed', error: message, finishedAt: new Date() });
      if (onFailure) await onFailure(row, message).catch((e) => log.error({ err: e }, 'failure hook error'));
      throw new UnrecoverableError(message);
    }
    await patchJob(row.id, {
      status: 'queued',
      error: `Attempt ${attempt} of ${maxAttempts} failed: ${message}. Retrying…`,
    });
    throw err;
  } finally {
    clearInterval(cancelPoll);
  }
}

/** Register a file already written under DATA_ROOT as an asset row. */
export async function createAsset(values: {
  projectId?: string | null;
  brandId?: string | null;
  characterId?: string | null;
  kind: string;
  relPath: string;
  mime: string;
  originalName?: string | null;
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  meta?: Record<string, unknown>;
}): Promise<Asset> {
  const size = await fileSize(absPath(values.relPath)).catch(() => 0);
  const [row] = await getDb()
    .insert(assets)
    .values({
      projectId: values.projectId ?? null,
      brandId: values.brandId ?? null,
      characterId: values.characterId ?? null,
      kind: values.kind,
      relPath: values.relPath,
      mime: values.mime,
      originalName: values.originalName ?? null,
      sizeBytes: size,
      durationSec: values.durationSec ?? null,
      width: values.width ?? null,
      height: values.height ?? null,
      meta: values.meta ?? {},
    })
    .returning();
  return row!;
}

export async function getAsset(id: string | null | undefined): Promise<Asset | undefined> {
  if (!id) return undefined;
  const [row] = await getDb().select().from(assets).where(eq(assets.id, id));
  return row;
}

/** Copy a temp file into project storage at the given relative path. */
export async function moveIntoStorage(tempFile: string, relPath: string): Promise<string> {
  const abs = absPath(relPath);
  await ensureParentDir(abs);
  try {
    await fs.rename(tempFile, abs);
  } catch {
    await fs.copyFile(tempFile, abs);
    await fs.rm(tempFile, { force: true });
  }
  return abs;
}

export function extOf(p: string): string {
  return path.extname(p).toLowerCase();
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
