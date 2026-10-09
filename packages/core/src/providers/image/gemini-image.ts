import { ProviderError } from '../../errors';
import { providerJson, type FetchImpl } from '../http';
import type { GeneratedImage, ImageGenerationRequest, ImageProvider } from './types';

interface GenerateContentResponse {
  candidates?: {
    finishReason?: string;
    content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] };
  }[];
  promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
}

/**
 * Photoreal stills with Gemini image models (Nano Banana Pro by default):
 * `models/{model}:generateContent` with reference images as inline parts and
 * `responseModalities: ['IMAGE']`.
 */
export class GeminiImageProvider implements ImageProvider {
  readonly id = 'google' as const;
  readonly model: string;

  constructor(
    private readonly opts: {
      apiKey: string;
      model: string;
      baseUrl: string;
      timeoutMs?: number;
      fetchImpl?: FetchImpl;
    },
  ) {
    this.model = opts.model;
  }

  buildRequestBody(req: ImageGenerationRequest): Record<string, unknown> {
    const parts: Record<string, unknown>[] = req.references.slice(0, 8).map((r) => ({
      inlineData: { mimeType: r.mimeType, data: r.data.toString('base64') },
    }));
    parts.push({ text: req.prompt.slice(0, 8000) });
    return {
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: req.aspectRatio } },
    };
  }

  /** Pull the image out of a generateContent response, or explain why there is none. */
  static parseResponse(res: GenerateContentResponse): GeneratedImage {
    if (res.promptFeedback?.blockReason) {
      throw new ProviderError(
        `Blocked by the provider's safety filters: ${res.promptFeedback.blockReasonMessage ?? res.promptFeedback.blockReason}`,
        { provider: 'google', retryable: false, code: 'safety' },
      );
    }
    const cand = res.candidates?.[0];
    const img = cand?.content?.parts?.find((p) => p.inlineData?.data);
    if (img?.inlineData?.data) {
      return {
        data: Buffer.from(img.inlineData.data, 'base64'),
        mimeType: img.inlineData.mimeType || 'image/png',
      };
    }
    const said = cand?.content?.parts
      ?.map((p) => p.text ?? '')
      .join(' ')
      .trim();
    const reason = cand?.finishReason && cand.finishReason !== 'STOP' ? ` (${cand.finishReason})` : '';
    throw new ProviderError(
      `The image model returned no image${reason}${said ? `: ${said.slice(0, 300)}` : ''}`,
      {
        provider: 'google',
        retryable: !reason.includes('SAFETY') && !said,
        code: reason.includes('SAFETY') || reason.includes('PROHIBITED') ? 'safety' : undefined,
      },
    );
  }

  async generateImage(req: ImageGenerationRequest): Promise<GeneratedImage> {
    const res = await providerJson<GenerateContentResponse>({
      provider: 'Google image',
      url: `${this.opts.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`,
      method: 'POST',
      headers: { 'x-goog-api-key': this.opts.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(this.buildRequestBody(req)),
      timeoutMs: this.opts.timeoutMs ?? 180_000,
      retries: 1,
      fetchImpl: this.opts.fetchImpl,
    });
    return GeminiImageProvider.parseResponse(res);
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const data = await providerJson<{ name?: string; displayName?: string }>({
      provider: 'Google image',
      url: `${this.opts.baseUrl}/models/${encodeURIComponent(this.model)}`,
      headers: { 'x-goog-api-key': this.opts.apiKey },
      retries: 0,
      timeoutMs: 15_000,
      fetchImpl: this.opts.fetchImpl,
    });
    return { ok: true, message: `Connected. Image model ${data.displayName ?? this.model} is available.` };
  }
}
