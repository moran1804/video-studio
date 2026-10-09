import type { ReferenceImage } from '../video/types';

/** Aspect ratios accepted by the Gemini image models. */
export const IMAGE_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

export interface ImageGenerationRequest {
  prompt: string;
  /** Character / scene references, in order. */
  references: ReferenceImage[];
  aspectRatio: ImageAspectRatio;
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: string;
}

export interface ImageProvider {
  readonly id: 'google' | 'mock';
  readonly model: string;
  generateImage(req: ImageGenerationRequest): Promise<GeneratedImage>;
  testConnection?(): Promise<{ ok: boolean; message: string }>;
}
