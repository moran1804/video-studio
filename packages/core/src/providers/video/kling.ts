import crypto from 'node:crypto';
import { ProviderError } from '../../errors';
import { providerFetch, providerJson, type FetchImpl } from '../http';
import type {
  GeneratedVideo,
  ProviderCapabilities,
  VideoGenerationRequest,
  VideoJob,
  VideoJobStatus,
  VideoProvider,
} from './types';

/**
 * Kling Motion Control: the character in an image performs the movement of a
 * reference video (e.g. a trending dance). `POST /v1/videos/motion-control`,
 * poll `GET /v1/videos/motion-control/{task_id}`, download the result URL.
 *
 * Auth: a Bearer API key, or a legacy "ACCESS_KEY:SECRET_KEY" pair from which a
 * short-lived HS256 JWT is signed for every request.
 */
export interface KlingOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  mode: 'std' | 'pro';
  costPerSecond?: number;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

interface KlingEnvelope<T> {
  code?: number;
  message?: string;
  data?: T;
}

interface KlingTask {
  task_id?: string;
  task_status?: string; // submitted | processing | succeed | failed
  task_status_msg?: string;
  task_result?: { videos?: { id?: string; url?: string; duration?: string | number }[] };
}

const TASK_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DOWNLOAD_HOSTS =
  /(^|\.)(klingai\.com|kling\.ai|kwai\.net|kwaicdn\.com|kuaishou\.com|klingai\.kuaishou\.com)$/;

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Sign a Kling JWT from an access/secret key pair (HS256, 30-minute lifetime). */
export function signKlingJwt(
  accessKey: string,
  secretKey: string,
  nowSec = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: accessKey, exp: nowSec + 1800, nbf: nowSec - 5 }));
  const sig = crypto.createHmac('sha256', secretKey).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export class KlingMotionProvider implements VideoProvider {
  readonly id = 'kling' as const;
  readonly label = 'Kling Motion Control';
  readonly model: string;

  constructor(private readonly opts: KlingOptions) {
    this.model = opts.model;
  }

  capabilities(): ProviderCapabilities {
    return {
      durations: [3, 5, 10, 15, 20, 30],
      aspectRatios: ['9:16', '16:9', '1:1'],
      supportsImage: true,
      supportsTextOnly: false,
      supportsCancel: false,
      maxPromptChars: 2500,
    };
  }

  private authHeader(): string {
    const key = this.opts.apiKey.trim();
    const pair = key.match(/^([^:\s]+):([^:\s]+)$/);
    return `Bearer ${pair ? signKlingJwt(pair[1]!, pair[2]!) : key}`;
  }

  private headers(): Record<string, string> {
    return { authorization: this.authHeader(), 'content-type': 'application/json; charset=utf-8' };
  }

  /** Kling wraps every response in { code, message, data }; code 0 means success. */
  private static unwrap<T>(env: KlingEnvelope<T>, label: string): T {
    if (env.code !== undefined && env.code !== 0) {
      const msg = env.message ?? `error code ${env.code}`;
      const auth =
        /auth|token|signature|key/i.test(msg) || env.code === 1000 || env.code === 1001 || env.code === 1002;
      throw new ProviderError(`${label}: ${msg}${auth ? ' – check the Kling API key' : ''}`, {
        provider: 'kling',
        retryable: false,
        code: auth ? 'auth' : undefined,
      });
    }
    if (!env.data)
      throw new ProviderError(`${label}: empty response`, { provider: 'kling', retryable: true });
    return env.data;
  }

  buildRequestBody(request: VideoGenerationRequest): Record<string, unknown> {
    if (!request.referenceImage) {
      throw new ProviderError('Kling motion control needs an image of the character.', {
        provider: 'kling',
        retryable: false,
      });
    }
    if (!request.motionVideo) {
      throw new ProviderError('Kling motion control needs a video to copy the movement from.', {
        provider: 'kling',
        retryable: false,
      });
    }
    return {
      model_name: this.model,
      image_url: request.referenceImage.data.toString('base64'),
      // A public URL when available, otherwise the clip itself (base64).
      video_url: request.motionVideo.url ?? request.motionVideo.data.toString('base64'),
      prompt: request.prompt.slice(0, this.capabilities().maxPromptChars),
      character_orientation: 'video',
      mode: this.opts.mode,
      keep_original_sound: 'no',
    };
  }

  async createVideo(request: VideoGenerationRequest): Promise<VideoJob> {
    const body = this.buildRequestBody(request);
    let data: KlingTask;
    try {
      data = KlingMotionProvider.unwrap(
        await providerJson<KlingEnvelope<KlingTask>>({
          provider: this.label,
          url: `${this.opts.baseUrl}/v1/videos/motion-control`,
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          timeoutMs: this.opts.timeoutMs ?? 120_000,
          retries: 0, // a retry could start (and bill) a second task
          fetchImpl: this.opts.fetchImpl,
        }),
        this.label,
      );
    } catch (err) {
      if (
        !request.motionVideo?.url &&
        err instanceof ProviderError &&
        /video/i.test(err.message) &&
        !err.retryable
      ) {
        throw new ProviderError(
          `${err.message}. Kling may need the movement video as a public link: paste a direct .mp4 URL instead of uploading.`,
          { provider: 'kling', retryable: false },
        );
      }
      throw err;
    }
    if (!data.task_id || !TASK_RE.test(data.task_id)) {
      throw new ProviderError(`${this.label}: unexpected response (no task id)`, {
        provider: 'kling',
        retryable: true,
      });
    }
    const durationSec = Math.min(
      30,
      Math.max(3, Math.round(request.motionVideo?.durationSec ?? request.durationSec)),
    );
    return {
      providerJobId: data.task_id,
      provider: 'kling',
      submitted: { aspectRatio: request.aspectRatio, durationSec, model: this.model },
      estimatedCostUsd: this.opts.costPerSecond
        ? +(this.opts.costPerSecond * durationSec).toFixed(2)
        : undefined,
    };
  }

  static parseTask(t: KlingTask): VideoJobStatus {
    const status = (t.task_status ?? '').toLowerCase();
    if (status === 'failed')
      return { state: 'failed', error: t.task_status_msg || 'Kling reported a failure' };
    if (status !== 'succeed') return { state: 'generating', progress: status === 'processing' ? 0.5 : 0.1 };
    const urls = (t.task_result?.videos ?? []).map((v) => v.url).filter((u): u is string => Boolean(u));
    if (!urls.length) return { state: 'failed', error: 'Kling returned no video' };
    return { state: 'completed', progress: 1, resultUrls: urls };
  }

  private async getTask(jobId: string): Promise<KlingTask> {
    if (!TASK_RE.test(jobId))
      throw new ProviderError(`${this.label}: invalid task id`, { provider: 'kling', retryable: false });
    return KlingMotionProvider.unwrap(
      await providerJson<KlingEnvelope<KlingTask>>({
        provider: this.label,
        url: `${this.opts.baseUrl}/v1/videos/motion-control/${encodeURIComponent(jobId)}`,
        headers: this.headers(),
        timeoutMs: this.opts.timeoutMs,
        fetchImpl: this.opts.fetchImpl,
      }),
      this.label,
    );
  }

  async getJobStatus(jobId: string): Promise<VideoJobStatus> {
    return KlingMotionProvider.parseTask(await this.getTask(jobId));
  }

  async downloadResult(jobId: string): Promise<GeneratedVideo> {
    const status = await this.getJobStatus(jobId);
    if (status.state !== 'completed' || !status.resultUrls?.length) {
      throw new ProviderError(`${this.label}: result not ready`, { provider: 'kling', retryable: true });
    }
    const url = new URL(status.resultUrls[0]!);
    if (url.protocol !== 'https:' || !DOWNLOAD_HOSTS.test(url.hostname)) {
      throw new ProviderError(`${this.label}: unexpected download host ${url.hostname}`, {
        provider: 'kling',
        retryable: false,
      });
    }
    const res = await providerFetch({
      provider: this.label,
      url: url.toString(),
      timeoutMs: 300_000,
      fetchImpl: this.opts.fetchImpl,
    });
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length < 1000) {
      throw new ProviderError(`${this.label}: downloaded file is empty`, {
        provider: 'kling',
        retryable: true,
      });
    }
    return { data, mimeType: res.headers.get('content-type') || 'video/mp4', sourceUrl: url.toString() };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    // Listing recent tasks is a cheap authenticated call.
    KlingMotionProvider.unwrap(
      await providerJson<KlingEnvelope<unknown>>({
        provider: this.label,
        url: `${this.opts.baseUrl}/v1/videos/motion-control?pageNum=1&pageSize=1`,
        headers: this.headers(),
        retries: 0,
        timeoutMs: 15_000,
        fetchImpl: this.opts.fetchImpl,
      }),
      this.label,
    );
    return { ok: true, message: `Connected. Motion model ${this.model} (${this.opts.mode}).` };
  }
}
