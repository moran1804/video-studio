import path from 'node:path';
import { getConfig, parseDurations } from '../config';
import { dataRoot } from '../storage';
import { UserFacingError } from '../errors';
import { getApiKey, getDefaults } from '../settings';
import { GoogleVideoProvider } from './video/google';
import { GoogleOmniProvider, usesInteractionsApi } from './video/google-omni';
import { RunwayProvider } from './video/runway';
import { KlingMotionProvider } from './video/kling';
import { GeminiImageProvider } from './image/gemini-image';
import { MockImageProvider } from './image/mock';
import type { ImageProvider } from './image/types';
import { MockVideoProvider } from './video/mock';
import type { ProviderId, VideoProvider } from './video/types';
import { MockLlmClient, OpenAIClient, type LlmClient } from './llm/openai';
import { ElevenLabsClient, MockTtsClient, type TtsClient } from './tts/elevenlabs';

/** Providers selectable for regular scenes (Kling is only used for motion transfer). */
export const PROVIDER_IDS = ['google', 'veo', 'runway', 'mock'] as const satisfies readonly ProviderId[];

let mockOverride: MockVideoProvider | undefined;
/** Test hook to control the mock provider delay. */
export function setMockVideoProvider(p: MockVideoProvider | undefined): void {
  mockOverride = p;
}

export async function getVideoProvider(id: ProviderId): Promise<VideoProvider> {
  const c = getConfig();
  if (id === 'mock' || c.MOCK_PROVIDERS) {
    return (
      mockOverride ?? new MockVideoProvider({ imageCacheDir: path.join(dataRoot(), 'temp', 'mock-images') })
    );
  }
  const timeoutMs = c.HTTP_TIMEOUT_SECONDS * 1000;
  if (id === 'google' || id === 'veo') {
    const apiKey = await getApiKey('google');
    if (!apiKey)
      throw new UserFacingError(
        'Google Gemini API key is not configured. Add it in Settings.',
        400,
        'not_configured',
      );
    const model = id === 'veo' ? c.GOOGLE_VEO_MODEL : (c.GOOGLE_VIDEO_MODEL ?? '');
    if (id === 'google' && usesInteractionsApi(model)) {
      return new GoogleOmniProvider({
        label: 'Google Gemini Omni Flash',
        apiKey,
        model,
        baseUrl: c.GOOGLE_API_BASE_URL,
        durations: parseDurations(c.GOOGLE_VIDEO_DURATIONS),
        resolution: c.GOOGLE_VIDEO_RESOLUTION || undefined,
        costPerSecond: c.COST_PER_SECOND_GOOGLE,
        timeoutMs,
      });
    }
    return new GoogleVideoProvider({
      id,
      label: id === 'veo' ? 'Google Veo 3.1' : 'Google Gemini Omni Flash',
      apiKey,
      model: id === 'veo' ? c.GOOGLE_VEO_MODEL : (c.GOOGLE_VIDEO_MODEL ?? ''),
      baseUrl: c.GOOGLE_API_BASE_URL,
      durations: parseDurations(c.GOOGLE_VIDEO_DURATIONS),
      resolution: c.GOOGLE_VIDEO_RESOLUTION || undefined,
      costPerSecond: id === 'veo' ? c.COST_PER_SECOND_VEO : c.COST_PER_SECOND_GOOGLE,
      timeoutMs,
    });
  }
  if (id === 'runway') {
    const apiKey = await getApiKey('runway');
    if (!apiKey)
      throw new UserFacingError(
        'Runway API key is not configured. Add it in Settings.',
        400,
        'not_configured',
      );
    return new RunwayProvider({
      apiKey,
      model: c.RUNWAY_VIDEO_MODEL,
      baseUrl: c.RUNWAY_API_BASE_URL,
      apiVersion: c.RUNWAY_API_VERSION,
      durations: parseDurations(c.RUNWAY_VIDEO_DURATIONS),
      costPerSecond: c.COST_PER_SECOND_RUNWAY,
      timeoutMs,
    });
  }
  if (id === 'kling') {
    const apiKey = await getApiKey('kling');
    if (!apiKey)
      throw new UserFacingError(
        'Kling API key is not configured. Add it in Settings to copy movement from videos.',
        400,
        'not_configured',
      );
    return new KlingMotionProvider({
      apiKey,
      baseUrl: c.KLING_API_BASE_URL,
      model: c.KLING_MOTION_MODEL,
      mode: c.KLING_MOTION_MODE,
      costPerSecond: c.COST_PER_SECOND_KLING,
      timeoutMs,
    });
  }
  throw new UserFacingError(`Unknown video provider "${String(id)}"`);
}

/** Image model for character references and keyframes (Nano Banana Pro). */
export async function getImageProvider(): Promise<ImageProvider> {
  const c = getConfig();
  if (c.MOCK_PROVIDERS) return new MockImageProvider();
  const apiKey = await getApiKey('google');
  if (!apiKey)
    throw new UserFacingError(
      'Google Gemini API key is not configured (needed for character images). Add it in Settings.',
      400,
      'not_configured',
    );
  return new GeminiImageProvider({
    apiKey,
    model: c.GOOGLE_IMAGE_MODEL,
    baseUrl: c.GOOGLE_API_BASE_URL,
    timeoutMs: Math.max(180_000, c.HTTP_TIMEOUT_SECONDS * 1000),
  });
}

/** Capabilities without needing credentials (used by the storyboard UI). */
export function staticCapabilities(id: ProviderId) {
  const c = getConfig();
  if (id === 'mock' || c.MOCK_PROVIDERS) return new MockVideoProvider().capabilities();
  if (id === 'runway') {
    return new RunwayProvider({
      apiKey: '',
      model: c.RUNWAY_VIDEO_MODEL,
      baseUrl: '',
      apiVersion: '',
      durations: parseDurations(c.RUNWAY_VIDEO_DURATIONS),
    }).capabilities();
  }
  if (id === 'kling') {
    return new KlingMotionProvider({
      apiKey: '',
      baseUrl: '',
      model: c.KLING_MOTION_MODEL,
      mode: c.KLING_MOTION_MODE,
    }).capabilities();
  }
  if (id === 'google' && usesInteractionsApi(c.GOOGLE_VIDEO_MODEL ?? '')) {
    return new GoogleOmniProvider({
      label: '',
      apiKey: '',
      model: '',
      baseUrl: '',
      durations: parseDurations(c.GOOGLE_VIDEO_DURATIONS),
    }).capabilities();
  }
  return new GoogleVideoProvider({
    id,
    label: '',
    apiKey: '',
    model: '',
    baseUrl: '',
    durations: parseDurations(c.GOOGLE_VIDEO_DURATIONS),
  }).capabilities();
}

export async function getLlm(): Promise<LlmClient> {
  const c = getConfig();
  if (c.MOCK_PROVIDERS) return new MockLlmClient();
  const apiKey = await getApiKey('openai');
  if (!apiKey)
    throw new UserFacingError('OpenAI API key is not configured. Add it in Settings.', 400, 'not_configured');
  const defaults = await getDefaults();
  return new OpenAIClient({
    apiKey,
    baseUrl: c.OPENAI_BASE_URL,
    model: defaults.llmModel,
    visionModel: c.OPENAI_VISION_MODEL,
    transcriptionModel: c.OPENAI_TRANSCRIPTION_MODEL,
    timeoutMs: Math.max(120_000, c.HTTP_TIMEOUT_SECONDS * 1000),
  });
}

/** LLM if available, otherwise null (analysis degrades gracefully). */
export async function getLlmOptional(): Promise<LlmClient | null> {
  try {
    return await getLlm();
  } catch {
    return null;
  }
}

export async function getTts(): Promise<TtsClient> {
  const c = getConfig();
  if (c.MOCK_PROVIDERS) return new MockTtsClient();
  const apiKey = await getApiKey('elevenlabs');
  if (!apiKey)
    throw new UserFacingError(
      'ElevenLabs API key is not configured. Add it in Settings.',
      400,
      'not_configured',
    );
  return new ElevenLabsClient({
    apiKey,
    baseUrl: c.ELEVENLABS_API_BASE_URL,
    defaultModel: c.ELEVENLABS_MODEL,
  });
}
