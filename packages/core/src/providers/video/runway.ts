import { ProviderError } from '../../errors';
import { providerFetch, providerJson, type FetchImpl } from '../http';
import type { AspectRatio } from '../../schemas';
import {
  pickDuration,
  type GeneratedVideo,
  type ProviderCapabilities,
  type VideoGenerationRequest,
  type VideoJob,
  type VideoJobStatus,
  type VideoProvider,
} from './types';

export interface RunwayOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  apiVersion: string;
  durations: number[];
  costPerSecond?: number;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

export const RUNWAY_RATIOS: Record<AspectRatio, string> = {
  '9:16': '720:1280',
  '16:9': '1280:720',
  '1:1': '960:960',
  '4:5': '832:1104',
};

interface RunwayTask {
  id: string;
  status: 'PENDING' | 'THROTTLED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  progress?: number;
  output?: string[];
  failure?: string;
  failureCode?: string;
}

const TASK_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export class RunwayProvider implements VideoProvider {
  readonly id = 'runway' as const;
  readonly label = 'Runway';
  readonly model: string;

  constructor(private readonly opts: RunwayOptions) {
    this.model = opts.model;
  }

  capabilities(): ProviderCapabilities {
    return {
      durations: this.opts.durations,
      aspectRatios: ['9:16', '16:9', '1:1', '4:5'],
      supportsImage: true,
      supportsTextOnly: true,
      supportsCancel: true,
      maxPromptChars: 1000,
    };
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.apiKey}`,
      'x-runway-version': this.opts.apiVersion,
      'content-type': 'application/json',
    };
  }

  buildRequest(request: VideoGenerationRequest): {
    path: string;
    body: Record<string, unknown>;
    durationSec: number;
    ratio: string;
  } {
    const durationSec = pickDuration(request.durationSec, this.opts.durations);
    const ratio = RUNWAY_RATIOS[request.aspectRatio];
    const body: Record<string, unknown> = {
      model: this.model,
      promptText: request.prompt.slice(0, this.capabilities().maxPromptChars),
      ratio,
      duration: durationSec,
    };
    if (request.seed !== undefined) body.seed = request.seed;
    if (request.referenceImage) {
      body.promptImage = `data:${request.referenceImage.mimeType};base64,${request.referenceImage.data.toString('base64')}`;
      return { path: '/v1/image_to_video', body, durationSec, ratio };
    }
    return { path: '/v1/text_to_video', body, durationSec, ratio };
  }

  async createVideo(request: VideoGenerationRequest): Promise<VideoJob> {
    const { path, body, durationSec, ratio } = this.buildRequest(request);
    let task: { id?: string };
    try {
      task = await providerJson<{ id?: string }>({
        provider: this.label,
        url: `${this.opts.baseUrl}${path}`,
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        timeoutMs: this.opts.timeoutMs,
        fetchImpl: this.opts.fetchImpl,
      });
    } catch (err) {
      if (
        err instanceof ProviderError &&
        path === '/v1/text_to_video' &&
        (err.options.status === 400 || err.options.status === 404)
      ) {
        throw new ProviderError(
          `${err.message}. If model "${this.model}" does not support text-only generation, attach a reference image to the scene.`,
          { ...err.options },
        );
      }
      throw err;
    }
    if (!task.id || !TASK_ID_RE.test(task.id)) {
      throw new ProviderError('Runway: unexpected response (no task id)', {
        provider: this.id,
        retryable: true,
      });
    }
    return {
      providerJobId: task.id,
      provider: this.id,
      submitted: { aspectRatio: ratio, durationSec, model: this.model },
      estimatedCostUsd: this.opts.costPerSecond
        ? +(this.opts.costPerSecond * durationSec).toFixed(2)
        : undefined,
    };
  }

  private async getTask(jobId: string): Promise<RunwayTask> {
    if (!TASK_ID_RE.test(jobId))
      throw new ProviderError('Runway: invalid task id', { provider: this.id, retryable: false });
    return providerJson<RunwayTask>({
      provider: this.label,
      url: `${this.opts.baseUrl}/v1/tasks/${jobId}`,
      headers: this.headers(),
      timeoutMs: this.opts.timeoutMs,
      fetchImpl: this.opts.fetchImpl,
    });
  }

  static parseTask(task: RunwayTask): VideoJobStatus {
    switch (task.status) {
      case 'PENDING':
      case 'THROTTLED':
        return { state: 'queued', progress: task.progress };
      case 'RUNNING':
        return { state: 'generating', progress: task.progress };
      case 'SUCCEEDED':
        if (!task.output?.length) return { state: 'failed', error: 'Runway returned no output.' };
        return { state: 'completed', progress: 1, resultUrls: task.output };
      case 'CANCELLED':
        return { state: 'cancelled' };
      case 'FAILED':
        return { state: 'failed', error: task.failure ?? task.failureCode ?? 'Runway generation failed.' };
      default:
        return { state: 'failed', error: `Unknown Runway status "${String((task as RunwayTask).status)}"` };
    }
  }

  async getJobStatus(jobId: string): Promise<VideoJobStatus> {
    return RunwayProvider.parseTask(await this.getTask(jobId));
  }

  async downloadResult(jobId: string): Promise<GeneratedVideo> {
    const status = await this.getJobStatus(jobId);
    if (status.state !== 'completed' || !status.resultUrls?.length) {
      throw new ProviderError('Runway: result not ready', { provider: this.id, retryable: true });
    }
    const uri = status.resultUrls[0]!;
    if (!uri.startsWith('https://'))
      throw new ProviderError('Runway: insecure output URL', { provider: this.id, retryable: false });
    const res = await providerFetch({
      provider: this.label,
      url: uri,
      timeoutMs: 300_000,
      fetchImpl: this.opts.fetchImpl,
    });
    const data = Buffer.from(await res.arrayBuffer());
    return { data, mimeType: res.headers.get('content-type') || 'video/mp4', sourceUrl: uri.split('?')[0] };
  }

  async cancelJob(jobId: string): Promise<void> {
    if (!TASK_ID_RE.test(jobId)) return;
    await providerFetch({
      provider: this.label,
      url: `${this.opts.baseUrl}/v1/tasks/${jobId}`,
      method: 'DELETE',
      headers: this.headers(),
      retries: 1,
      fetchImpl: this.opts.fetchImpl,
    });
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const org = await providerJson<{ creditBalance?: number }>({
      provider: this.label,
      url: `${this.opts.baseUrl}/v1/organization`,
      headers: this.headers(),
      retries: 0,
      timeoutMs: 15_000,
      fetchImpl: this.opts.fetchImpl,
    });
    return {
      ok: true,
      message: `Connected.${org.creditBalance !== undefined ? ` Credit balance: ${org.creditBalance}.` : ''} Model: ${this.model}.`,
    };
  }
}
