import type { AspectRatio } from '../../schemas';

/** `kling` is only used for motion transfer (copy movement from a video). */
export type ProviderId = 'google' | 'veo' | 'runway' | 'kling' | 'mock';

export interface ReferenceImage {
  /** JPEG or PNG bytes (already resized to a provider-friendly size). */
  data: Buffer;
  mimeType: 'image/jpeg' | 'image/png';
}

export interface VideoGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  aspectRatio: AspectRatio;
  durationSec: number;
  /** Start frame (first frame of the clip). */
  referenceImage?: ReferenceImage;
  /** Identity references for the people in the shot (Veo "ingredients", Omni reference-to-video). */
  characterReferences?: ReferenceImage[];
  /** Motion source for motion-transfer providers (Kling). */
  motionVideo?: { data: Buffer; mimeType: string; durationSec: number; url?: string };
  /** Free-form text drawn on mock clips; ignored by real providers. */
  label?: string;
  seed?: number;
  generateAudio?: boolean;
}

export interface VideoJob {
  providerJobId: string;
  provider: ProviderId;
  /** Parameters actually sent, after mapping (for display / debugging). */
  submitted: { aspectRatio: string; durationSec: number; model: string };
  estimatedCostUsd?: number;
}

export type VideoJobState = 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled';

export interface VideoJobStatus {
  state: VideoJobState;
  progress?: number; // 0..1
  error?: string;
  /** Provider-side result locations, stored for troubleshooting. */
  resultUrls?: string[];
}

export interface GeneratedVideo {
  data: Buffer;
  mimeType: string;
  /** The provider's own URL (not exposed to browsers). */
  sourceUrl?: string;
}

export interface ProviderCapabilities {
  durations: number[];
  aspectRatios: AspectRatio[];
  supportsImage: boolean;
  supportsTextOnly: boolean;
  supportsCancel: boolean;
  maxPromptChars: number;
  /** How many character reference images the model accepts (0 = none). */
  maxReferenceImages?: number;
  /** Durations allowed when character references are sent (e.g. Veo: 8 s only). */
  referenceDurations?: number[];
}

export interface VideoProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly model: string;
  capabilities(): ProviderCapabilities;
  createVideo(request: VideoGenerationRequest): Promise<VideoJob>;
  getJobStatus(jobId: string): Promise<VideoJobStatus>;
  downloadResult(jobId: string): Promise<GeneratedVideo>;
  cancelJob?(jobId: string): Promise<void>;
  testConnection?(): Promise<{ ok: boolean; message: string }>;
}

/** Start-frame size sent for image-to-video (720p class, provider-friendly). */
export function startFrameSize(ar: AspectRatio): [number, number] {
  return ({ '9:16': [720, 1280], '16:9': [1280, 720], '1:1': [1024, 1024], '4:5': [864, 1080] } as const)[
    ar
  ] as [number, number];
}

/** Pick the closest supported duration that is >= requested (or the max). */
export function pickDuration(requested: number, supported: number[]): number {
  const sorted = [...supported].sort((a, b) => a - b);
  return sorted.find((d) => d >= requested) ?? sorted[sorted.length - 1] ?? requested;
}

/**
 * Pick the provider aspect ratio to request. Unsupported ratios are generated
 * at the closest supported ratio and cropped during rendering.
 */
export function pickAspectRatio(requested: AspectRatio, supported: AspectRatio[]): AspectRatio {
  if (supported.includes(requested)) return requested;
  const value = (ar: AspectRatio) => {
    const [w, h] = ar.split(':').map(Number) as [number, number];
    return w / h;
  };
  // Prefer a taller-or-equal source for portrait targets so a centre crop works well.
  const target = value(requested);
  return (
    [...supported].sort((a, b) => Math.abs(value(a) - target) - Math.abs(value(b) - target))[0] ?? requested
  );
}
