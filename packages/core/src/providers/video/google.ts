import { ProviderError } from '../../errors';
import { providerFetch, providerJson, type FetchImpl } from '../http';
import type { AspectRatio } from '../../schemas';
import {
  pickAspectRatio,
  pickDuration,
  type GeneratedVideo,
  type ProviderCapabilities,
  type VideoGenerationRequest,
  type VideoJob,
  type VideoJobStatus,
  type VideoProvider,
} from './types';

/**
 * Google video generation through the Gemini API long-running operation flow
 * (`models/{model}:predictLongRunning` → poll `operations/*` → download the
 * file URI). Used for both Gemini Omni Flash (id "google") and Veo 3.1
 * (id "veo"); only the model id and capabilities differ.
 */
export interface GoogleVideoOptions {
  id: 'google' | 'veo';
  label: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  durations: number[];
  resolution?: string;
  costPerSecond?: number;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

interface GoogleOperation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  metadata?: Record<string, unknown>;
  response?: {
    generateVideoResponse?: {
      generatedSamples?: { video?: { uri?: string } }[];
      raiMediaFilteredCount?: number;
      raiMediaFilteredReasons?: string[];
    };
  };
}

const OPERATION_RE = /^models\/[A-Za-z0-9._-]+\/operations\/[A-Za-z0-9._-]+$|^operations\/[A-Za-z0-9._-]+$/;

export class GoogleVideoProvider implements VideoProvider {
  readonly id: 'google' | 'veo';
  readonly label: string;
  readonly model: string;

  constructor(private readonly opts: GoogleVideoOptions) {
    this.id = opts.id;
    this.label = opts.label;
    this.model = opts.model;
  }

  capabilities(): ProviderCapabilities {
    return {
      durations: this.opts.durations,
      aspectRatios: ['16:9', '9:16'],
      supportsImage: true,
      supportsTextOnly: true,
      supportsCancel: false,
      maxPromptChars: 4000,
      // Veo 3.1 "ingredients": up to 3 asset references, 8-second clips only.
      maxReferenceImages: 3,
      referenceDurations: [8],
    };
  }

  private headers(): Record<string, string> {
    return { 'x-goog-api-key': this.opts.apiKey, 'content-type': 'application/json' };
  }

  /** Map the common request into the Gemini API request body. */
  buildRequestBody(
    request: VideoGenerationRequest,
    opts: { negativeInPrompt?: boolean } = {},
  ): {
    body: Record<string, unknown>;
    aspectRatio: AspectRatio;
    durationSec: number;
  } {
    const caps = this.capabilities();
    const aspectRatio = pickAspectRatio(request.aspectRatio, caps.aspectRatios);
    const max = caps.maxReferenceImages ?? 0;
    let refs = (request.characterReferences ?? []).slice(0, max);
    let startFrame = request.referenceImage;
    // Veo 3.1 rejects a start frame together with reference images ("Unsupported video
    // generation request", confirmed live), so the keyframe becomes the last reference.
    if (refs.length && startFrame) {
      refs = [...refs.slice(0, max - 1), startFrame];
      startFrame = undefined;
    }
    const durationSec = pickDuration(
      request.durationSec,
      refs.length && caps.referenceDurations ? caps.referenceDurations : caps.durations,
    );
    // Veo rejects `negativePrompt` with reference images ("not supported in your use case"),
    // so in that case the things to avoid are written into the prompt instead.
    const negativeInPrompt = Boolean(request.negativePrompt) && (opts.negativeInPrompt ?? refs.length > 0);
    const promptText = negativeInPrompt
      ? `${request.prompt.trim()} Avoid: ${request.negativePrompt}.`
      : request.prompt;
    const instance: Record<string, unknown> = { prompt: promptText.slice(0, caps.maxPromptChars) };
    if (startFrame) {
      instance.image = {
        bytesBase64Encoded: startFrame.data.toString('base64'),
        mimeType: startFrame.mimeType,
      };
    }
    if (refs.length) {
      instance.referenceImages = refs.map((r) => ({
        image: { bytesBase64Encoded: r.data.toString('base64'), mimeType: r.mimeType },
        referenceType: 'asset',
      }));
    }
    const parameters: Record<string, unknown> = { aspectRatio, durationSeconds: durationSec };
    // People are expected in character shots; reference workflows only allow adults.
    if (refs.length) parameters.personGeneration = 'allow_adult';
    if (request.negativePrompt && !negativeInPrompt) parameters.negativePrompt = request.negativePrompt;
    if (this.opts.resolution) parameters.resolution = this.opts.resolution;
    if (request.seed !== undefined) parameters.seed = request.seed;
    return { body: { instances: [instance], parameters }, aspectRatio, durationSec };
  }

  async createVideo(request: VideoGenerationRequest): Promise<VideoJob> {
    if (!this.model) {
      throw new ProviderError(
        `${this.label}: no model configured (set ${this.id === 'veo' ? 'GOOGLE_VEO_MODEL' : 'GOOGLE_VIDEO_MODEL'})`,
        {
          provider: this.id,
          retryable: false,
        },
      );
    }
    let { body, aspectRatio, durationSec } = this.buildRequestBody(request);
    const submit = (b: Record<string, unknown>) =>
      providerJson<GoogleOperation>({
        provider: this.label,
        url: `${this.opts.baseUrl}/models/${encodeURIComponent(this.model)}:predictLongRunning`,
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(b),
        timeoutMs: this.opts.timeoutMs,
        // Only transient errors are retried; a 400 is handled below.
        fetchImpl: this.opts.fetchImpl,
      });
    let op: GoogleOperation;
    try {
      op = await submit(body);
    } catch (err) {
      if (!(err instanceof ProviderError) || err.options.status !== 400) throw err;
      if (/negative/i.test(err.message) && request.negativePrompt) {
        // This model/mode doesn't take a negative prompt: move it into the prompt text.
        ({ body, aspectRatio, durationSec } = this.buildRequestBody(request, { negativeInPrompt: true }));
        op = await submit(body);
      } else {
        throw err;
      }
    }
    if (!op.name || !OPERATION_RE.test(op.name)) {
      throw new ProviderError(`${this.label}: unexpected response (no operation name)`, {
        provider: this.id,
        retryable: true,
      });
    }
    return {
      providerJobId: op.name,
      provider: this.id,
      submitted: { aspectRatio, durationSec, model: this.model },
      estimatedCostUsd: this.opts.costPerSecond
        ? +(this.opts.costPerSecond * durationSec).toFixed(2)
        : undefined,
    };
  }

  private async getOperation(jobId: string): Promise<GoogleOperation> {
    if (!OPERATION_RE.test(jobId))
      throw new ProviderError(`${this.label}: invalid operation id`, { provider: this.id, retryable: false });
    return providerJson<GoogleOperation>({
      provider: this.label,
      url: `${this.opts.baseUrl}/${jobId}`,
      headers: this.headers(),
      timeoutMs: this.opts.timeoutMs,
      fetchImpl: this.opts.fetchImpl,
    });
  }

  /** Map a Gemini operation document into the common status shape. */
  static parseOperation(op: GoogleOperation): VideoJobStatus {
    if (op.error) return { state: 'failed', error: op.error.message ?? `error code ${op.error.code}` };
    if (!op.done) return { state: 'generating' };
    const resp = op.response?.generateVideoResponse;
    const uris = (resp?.generatedSamples ?? [])
      .map((s) => s.video?.uri)
      .filter((u): u is string => Boolean(u));
    if (!uris.length) {
      const reasons = resp?.raiMediaFilteredReasons?.join('; ');
      return {
        state: 'failed',
        error: reasons
          ? `Blocked by the provider's safety filters: ${reasons}`
          : 'The provider returned no video.',
      };
    }
    return { state: 'completed', progress: 1, resultUrls: uris };
  }

  async getJobStatus(jobId: string): Promise<VideoJobStatus> {
    return GoogleVideoProvider.parseOperation(await this.getOperation(jobId));
  }

  async downloadResult(jobId: string): Promise<GeneratedVideo> {
    const status = await this.getJobStatus(jobId);
    if (status.state !== 'completed' || !status.resultUrls?.length) {
      throw new ProviderError(`${this.label}: result not ready`, { provider: this.id, retryable: true });
    }
    const uri = status.resultUrls[0]!;
    const url = new URL(uri);
    if (
      url.protocol !== 'https:' ||
      !/(^|\.)googleapis\.com$|(^|\.)googleusercontent\.com$/.test(url.hostname)
    ) {
      throw new ProviderError(`${this.label}: unexpected download host ${url.hostname}`, {
        provider: this.id,
        retryable: false,
      });
    }
    const res = await providerFetch({
      provider: this.label,
      url: uri,
      headers: { 'x-goog-api-key': this.opts.apiKey },
      timeoutMs: 300_000,
      fetchImpl: this.opts.fetchImpl,
    });
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length < 1000)
      throw new ProviderError(`${this.label}: downloaded file is empty`, {
        provider: this.id,
        retryable: true,
      });
    return { data, mimeType: res.headers.get('content-type') || 'video/mp4', sourceUrl: uri };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const data = await providerJson<{ models?: { name: string }[] }>({
      provider: this.label,
      url: `${this.opts.baseUrl}/models?pageSize=200`,
      headers: this.headers(),
      retries: 0,
      timeoutMs: 15_000,
      fetchImpl: this.opts.fetchImpl,
    });
    const names = (data.models ?? []).map((m) => m.name.replace(/^models\//, ''));
    if (!this.model) return { ok: true, message: `API key valid. No model configured for ${this.label}.` };
    const found = names.includes(this.model);
    return {
      ok: true,
      message: found
        ? `Connected. Model ${this.model} is available.`
        : `Connected, but model "${this.model}" was not listed for this key (it may still work if access is gated).`,
    };
  }

  static async listVideoModels(apiKey: string, baseUrl: string, fetchImpl?: FetchImpl): Promise<string[]> {
    const data = await providerJson<{ models?: { name: string; supportedGenerationMethods?: string[] }[] }>({
      provider: 'Google',
      url: `${baseUrl}/models?pageSize=200`,
      headers: { 'x-goog-api-key': apiKey },
      retries: 0,
      timeoutMs: 15_000,
      fetchImpl,
    });
    return (data.models ?? [])
      .filter(
        (m) => m.supportedGenerationMethods?.includes('predictLongRunning') || /veo|video|omni/i.test(m.name),
      )
      .map((m) => m.name.replace(/^models\//, ''));
  }
}
