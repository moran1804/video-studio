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
 * Gemini Omni Flash through the Gemini **Interactions API**
 * (`POST /interactions` → poll `GET /interactions/{id}` → download the video
 * file). Omni models do not support `predictLongRunning`; Veo keeps using
 * GoogleVideoProvider.
 *
 * The API has no duration or negative-prompt fields, so both are expressed in
 * the prompt. Videos are requested with `delivery: "uri"` so the interaction
 * document stays small and can be re-read after a worker restart.
 */
export interface GoogleOmniOptions {
  label: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  durations: number[];
  resolution?: string;
  costPerSecond?: number;
  timeoutMs?: number;
  /** Timeout for a synchronous (non-background) interaction. */
  syncTimeoutMs?: number;
  fetchImpl?: FetchImpl;
}

type Content = { type?: string; text?: string; uri?: string; data?: string; mime_type?: string };

export interface OmniInteraction {
  id?: string;
  status?: string; // in_progress | completed | failed | cancelled | incomplete …
  error?: { code?: number | string; message?: string };
  steps?: { type?: string; content?: Content[] }[];
  outputs?: Content[];
}

const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const FILE_RE = /\/files\/([A-Za-z0-9._-]+)/;
const API_REVISION = '2026-05-20';

export class GoogleOmniProvider implements VideoProvider {
  readonly id = 'google' as const;
  readonly label: string;
  readonly model: string;

  constructor(private readonly opts: GoogleOmniOptions) {
    this.label = opts.label;
    this.model = opts.model;
  }

  capabilities(): ProviderCapabilities {
    return {
      durations: this.opts.durations.filter((d) => d >= 3 && d <= 10).length
        ? this.opts.durations.filter((d) => d >= 3 && d <= 10)
        : [4, 6, 8],
      aspectRatios: ['16:9', '9:16'],
      supportsImage: true,
      supportsTextOnly: true,
      supportsCancel: false,
      maxPromptChars: 4000,
      // Google's guide lists 2–3 reference images per request.
      maxReferenceImages: 3,
    };
  }

  private headers(): Record<string, string> {
    return {
      'x-goog-api-key': this.opts.apiKey,
      'content-type': 'application/json',
      'api-revision': API_REVISION,
    };
  }

  /** Map the common request into an Interactions API body. */
  buildRequestBody(
    request: VideoGenerationRequest,
    background = true,
  ): { body: Record<string, unknown>; aspectRatio: AspectRatio; durationSec: number } {
    const caps = this.capabilities();
    const aspectRatio = pickAspectRatio(request.aspectRatio, caps.aspectRatios);
    const durationSec = pickDuration(request.durationSec, caps.durations);
    const extras = [`Duration: ${durationSec} seconds.`];
    if (request.negativePrompt) extras.push(`Avoid: ${request.negativePrompt}.`);
    const refs = (request.characterReferences ?? []).slice(0, caps.maxReferenceImages ?? 0);
    const image = (r: { data: Buffer; mimeType: string }) => ({
      type: 'image',
      data: r.data.toString('base64'),
      mime_type: r.mimeType,
    });
    let task = request.referenceImage ? 'image_to_video' : 'text_to_video';
    let text = `${request.prompt.slice(0, caps.maxPromptChars - 600)}\n\n${extras.join(' ')}`;
    let input: string | Record<string, unknown>[] = request.referenceImage
      ? [image(request.referenceImage), { type: 'text', text }]
      : text;
    if (refs.length) {
      // Reference-to-video: identity images first, then the opening frame as one more
      // reference, each bound to a role with <IMAGE_REF_n> tags.
      task = 'reference_to_video';
      const tags = refs.map((_, i) => `<IMAGE_REF_${i}>`).join(', ');
      const frame = request.referenceImage ? `<IMAGE_REF_${refs.length}>` : null;
      text =
        `The person in ${tags} is the main character – keep their face, hair, body and outfit identical.` +
        (frame ? ` Start from the composition, setting and pose shown in ${frame}.` : '') +
        `\n\n${text}`;
      input = [
        ...refs.map(image),
        ...(request.referenceImage ? [image(request.referenceImage)] : []),
        { type: 'text', text },
      ];
    }
    const responseFormat: Record<string, unknown> = {
      type: 'video',
      aspect_ratio: aspectRatio,
      delivery: 'uri',
    };
    if (this.opts.resolution) responseFormat.resolution = this.opts.resolution;
    const body: Record<string, unknown> = {
      model: this.model,
      input,
      response_format: responseFormat,
      generation_config: {
        video_config: { task },
      },
    };
    if (background) body.background = true;
    return { body, aspectRatio, durationSec };
  }

  private post(body: Record<string, unknown>, timeoutMs?: number) {
    return providerJson<OmniInteraction>({
      provider: this.label,
      url: `${this.opts.baseUrl}/interactions`,
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs,
      // A retry could start (and bill) a second generation.
      retries: 0,
      fetchImpl: this.opts.fetchImpl,
    });
  }

  async createVideo(request: VideoGenerationRequest): Promise<VideoJob> {
    if (!this.model) {
      throw new ProviderError(`${this.label}: no model configured (set GOOGLE_VIDEO_MODEL)`, {
        provider: this.id,
        retryable: false,
      });
    }
    const { body, aspectRatio, durationSec } = this.buildRequestBody(request, true);
    let interaction: OmniInteraction;
    try {
      interaction = await this.post(body, this.opts.timeoutMs);
    } catch (err) {
      // Some models reject background execution: fall back to a blocking call.
      const msg = (err as Error).message ?? '';
      if (!(err instanceof ProviderError) || err.options.status !== 400 || !/background/i.test(msg))
        throw err;
      interaction = await this.post(
        this.buildRequestBody(request, false).body,
        this.opts.syncTimeoutMs ?? 600_000,
      );
    }
    if (!interaction.id || !ID_RE.test(interaction.id)) {
      const status = GoogleOmniProvider.parseInteraction(interaction);
      throw new ProviderError(
        status.state === 'failed'
          ? `${this.label}: ${status.error}`
          : `${this.label}: unexpected response (no interaction id)`,
        { provider: this.id, retryable: status.state !== 'failed' },
      );
    }
    return {
      providerJobId: interaction.id,
      provider: this.id,
      submitted: { aspectRatio, durationSec, model: this.model },
      estimatedCostUsd: this.opts.costPerSecond
        ? +(this.opts.costPerSecond * durationSec).toFixed(2)
        : undefined,
    };
  }

  /** All output content blocks, newest step last. */
  private static contents(i: OmniInteraction): Content[] {
    const fromSteps = (i.steps ?? [])
      .filter((s) => s.type === 'model_output')
      .flatMap((s) => s.content ?? []);
    return [...fromSteps, ...(i.outputs ?? [])];
  }

  /** Map an interaction document into the common status shape. */
  static parseInteraction(i: OmniInteraction): VideoJobStatus {
    const status = (i.status ?? '').toLowerCase();
    if (i.error || status === 'failed' || status === 'cancelled' || status === 'incomplete') {
      return { state: 'failed', error: i.error?.message ?? `Generation ${status || 'failed'}` };
    }
    if (status && status !== 'completed') return { state: 'generating' };
    const content = GoogleOmniProvider.contents(i);
    const video = content.find((c) => c.type === 'video' && (c.uri || c.data));
    if (!video) {
      const said = content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text)
        .join(' ')
        .slice(0, 300);
      return {
        state: 'failed',
        error: said ? `The model returned no video: ${said}` : 'The provider returned no video.',
      };
    }
    return { state: 'completed', progress: 1, resultUrls: video.uri ? [video.uri] : [] };
  }

  private async getInteraction(jobId: string): Promise<OmniInteraction> {
    if (!ID_RE.test(jobId)) {
      throw new ProviderError(`${this.label}: invalid interaction id`, {
        provider: this.id,
        retryable: false,
      });
    }
    return providerJson<OmniInteraction>({
      provider: this.label,
      url: `${this.opts.baseUrl}/interactions/${encodeURIComponent(jobId)}`,
      headers: this.headers(),
      timeoutMs: this.opts.timeoutMs,
      fetchImpl: this.opts.fetchImpl,
    });
  }

  async getJobStatus(jobId: string): Promise<VideoJobStatus> {
    const status = GoogleOmniProvider.parseInteraction(await this.getInteraction(jobId));
    const uri = status.resultUrls?.[0];
    const file = uri?.match(FILE_RE)?.[1];
    if (status.state !== 'completed' || !file) return status;
    // The video file may still be processing after the interaction completes.
    const meta = await providerJson<{ state?: string; error?: { message?: string } }>({
      provider: this.label,
      url: `${this.opts.baseUrl}/files/${encodeURIComponent(file)}`,
      headers: this.headers(),
      timeoutMs: this.opts.timeoutMs,
      fetchImpl: this.opts.fetchImpl,
    }).catch(() => ({ state: 'ACTIVE' as string, error: undefined }));
    if (meta.state === 'PROCESSING') return { state: 'generating', progress: 0.95 };
    if (meta.state === 'FAILED')
      return { state: 'failed', error: meta.error?.message ?? 'Video processing failed' };
    return status;
  }

  async downloadResult(jobId: string): Promise<GeneratedVideo> {
    const interaction = await this.getInteraction(jobId);
    const status = GoogleOmniProvider.parseInteraction(interaction);
    if (status.state !== 'completed') {
      throw new ProviderError(`${this.label}: result not ready`, { provider: this.id, retryable: true });
    }
    const video = GoogleOmniProvider.contents(interaction).find(
      (c) => c.type === 'video' && (c.uri || c.data),
    )!;
    if (video.data) {
      return { data: Buffer.from(video.data, 'base64'), mimeType: video.mime_type || 'video/mp4' };
    }
    const url = new URL(video.uri!);
    if (
      url.protocol !== 'https:' ||
      !/(^|\.)googleapis\.com$|(^|\.)googleusercontent\.com$/.test(url.hostname)
    ) {
      throw new ProviderError(`${this.label}: unexpected download host ${url.hostname}`, {
        provider: this.id,
        retryable: false,
      });
    }
    if (!url.searchParams.has('alt')) url.searchParams.set('alt', 'media');
    const res = await providerFetch({
      provider: this.label,
      url: url.toString(),
      headers: { 'x-goog-api-key': this.opts.apiKey },
      timeoutMs: 300_000,
      fetchImpl: this.opts.fetchImpl,
    });
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length < 1000) {
      throw new ProviderError(`${this.label}: downloaded file is empty`, {
        provider: this.id,
        retryable: true,
      });
    }
    return { data, mimeType: res.headers.get('content-type') || 'video/mp4', sourceUrl: video.uri };
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const data = await providerJson<{ models?: { name: string; supportedGenerationMethods?: string[] }[] }>({
      provider: this.label,
      url: `${this.opts.baseUrl}/models?pageSize=200`,
      headers: { 'x-goog-api-key': this.opts.apiKey },
      retries: 0,
      timeoutMs: 15_000,
      fetchImpl: this.opts.fetchImpl,
    });
    if (!this.model) return { ok: true, message: `API key valid. No model configured for ${this.label}.` };
    const found = (data.models ?? []).some((m) => m.name.replace(/^models\//, '') === this.model);
    return {
      ok: true,
      message: found
        ? `Connected. Model ${this.model} is available (Interactions API).`
        : `Connected, but model "${this.model}" was not listed for this key.`,
    };
  }
}

/** Omni-family models use the Interactions API; Veo models use predictLongRunning. */
export const usesInteractionsApi = (model: string) => Boolean(model) && !/^veo/i.test(model);
