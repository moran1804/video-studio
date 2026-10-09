import { providerJson, type FetchImpl } from '../http';
import { ProviderError } from '../../errors';
import type { VoiceSettings } from '../../schemas';
import type { TranscriptWord } from '../llm/openai';

export interface Voice {
  id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  previewUrl?: string;
}

export interface SynthesisResult {
  audio: Buffer;
  mime: 'audio/mpeg' | 'audio/wav';
  ext: '.mp3' | '.wav';
  words: TranscriptWord[];
  characters: number;
}

export interface TtsClient {
  readonly id: 'elevenlabs' | 'mock';
  listVoices(): Promise<Voice[]>;
  synthesize(args: { text: string; voiceId: string; settings: VoiceSettings }): Promise<SynthesisResult>;
  testConnection(): Promise<{ ok: boolean; message: string }>;
  usage(): Promise<{ characterCount?: number; characterLimit?: number; tier?: string } | null>;
}

/** Collapse character-level alignment into word timings. */
export function alignmentToWords(alignment: {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let current = '';
  let start = 0;
  let end = 0;
  const {
    characters: chars,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  } = alignment;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (/\s/.test(ch)) {
      if (current) words.push({ word: current, start, end });
      current = '';
      continue;
    }
    if (!current) start = starts[i] ?? end;
    current += ch;
    end = ends[i] ?? start;
  }
  if (current) words.push({ word: current, start, end });
  return words;
}

export class ElevenLabsClient implements TtsClient {
  readonly id = 'elevenlabs' as const;

  constructor(
    private readonly opts: { apiKey: string; baseUrl: string; defaultModel: string; fetchImpl?: FetchImpl },
  ) {}

  private headers(): Record<string, string> {
    return { 'xi-api-key': this.opts.apiKey, 'content-type': 'application/json' };
  }

  async listVoices(): Promise<Voice[]> {
    const res = await providerJson<{
      voices?: {
        voice_id: string;
        name: string;
        category?: string;
        labels?: Record<string, string>;
        preview_url?: string;
      }[];
    }>({
      provider: 'ElevenLabs',
      url: `${this.opts.baseUrl}/v1/voices`,
      headers: this.headers(),
      timeoutMs: 20_000,
      fetchImpl: this.opts.fetchImpl,
    });
    return (res.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      category: v.category,
      labels: v.labels,
      previewUrl: v.preview_url,
    }));
  }

  buildBody(text: string, settings: VoiceSettings): Record<string, unknown> {
    return {
      text,
      model_id: settings.modelId || this.opts.defaultModel,
      voice_settings: {
        stability: settings.stability,
        similarity_boost: settings.similarityBoost,
        style: settings.style,
        use_speaker_boost: settings.speakerBoost,
        speed: settings.speed,
      },
    };
  }

  async synthesize(args: {
    text: string;
    voiceId: string;
    settings: VoiceSettings;
  }): Promise<SynthesisResult> {
    if (!/^[A-Za-z0-9]{8,64}$/.test(args.voiceId)) {
      throw new ProviderError('ElevenLabs: choose a valid voice first', {
        provider: 'elevenlabs',
        retryable: false,
      });
    }
    const res = await providerJson<{
      audio_base64?: string;
      alignment?: {
        characters: string[];
        character_start_times_seconds: number[];
        character_end_times_seconds: number[];
      };
    }>({
      provider: 'ElevenLabs',
      url: `${this.opts.baseUrl}/v1/text-to-speech/${args.voiceId}/with-timestamps?output_format=mp3_44100_128`,
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(args.text, args.settings)),
      timeoutMs: 180_000,
      fetchImpl: this.opts.fetchImpl,
    });
    if (!res.audio_base64)
      throw new ProviderError('ElevenLabs returned no audio', { provider: 'elevenlabs', retryable: true });
    return {
      audio: Buffer.from(res.audio_base64, 'base64'),
      mime: 'audio/mpeg',
      ext: '.mp3',
      words: res.alignment ? alignmentToWords(res.alignment) : [],
      characters: args.text.length,
    };
  }

  async usage() {
    const res = await providerJson<{ character_count?: number; character_limit?: number; tier?: string }>({
      provider: 'ElevenLabs',
      url: `${this.opts.baseUrl}/v1/user/subscription`,
      headers: this.headers(),
      retries: 0,
      timeoutMs: 15_000,
      fetchImpl: this.opts.fetchImpl,
    });
    return { characterCount: res.character_count, characterLimit: res.character_limit, tier: res.tier };
  }

  async testConnection() {
    const voices = await this.listVoices();
    return { ok: true, message: `Connected. ${voices.length} voices available.` };
  }
}

// ---------------------------------------------------------------------------
// Mock TTS: pure JS WAV synthesis with word timings (no network, no FFmpeg)
// ---------------------------------------------------------------------------

export function synthesizeMockWav(
  text: string,
  speed = 1,
): { wav: Buffer; words: TranscriptWord[]; durationSec: number } {
  const sampleRate = 22050;
  const tokens = text.split(/\s+/).filter(Boolean);
  const words: TranscriptWord[] = [];
  let t = 0.15;
  const segments: { start: number; end: number; freq: number }[] = [];
  tokens.forEach((w, i) => {
    const len = (0.18 + Math.min(12, w.length) * 0.035) / speed;
    words.push({ word: w, start: +t.toFixed(3), end: +(t + len).toFixed(3) });
    segments.push({ start: t, end: t + len, freq: 180 + ((i * 37) % 120) });
    t += len + 0.08 / speed;
    if (/[.!?]$/.test(w)) t += 0.25 / speed;
  });
  const durationSec = Math.max(0.5, t + 0.2);
  const n = Math.ceil(durationSec * sampleRate);
  const pcm = Buffer.alloc(n * 2);
  for (const seg of segments) {
    const s0 = Math.floor(seg.start * sampleRate);
    const s1 = Math.min(n, Math.floor(seg.end * sampleRate));
    for (let s = s0; s < s1; s++) {
      const local = (s - s0) / (s1 - s0);
      const env = Math.sin(Math.PI * local);
      const v = Math.sin((2 * Math.PI * seg.freq * s) / sampleRate) * 0.35 * env;
      pcm.writeInt16LE(Math.round(v * 32767), s * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return { wav: Buffer.concat([header, pcm]), words, durationSec };
}

export const MOCK_VOICES: Voice[] = [
  { id: 'mockvoice01', name: 'Mock – Warm Narrator', category: 'mock', labels: { accent: 'neutral' } },
  { id: 'mockvoice02', name: 'Mock – Energetic Host', category: 'mock', labels: { accent: 'neutral' } },
];

export class MockTtsClient implements TtsClient {
  readonly id = 'mock' as const;
  async listVoices() {
    return MOCK_VOICES;
  }
  async synthesize(args: {
    text: string;
    voiceId: string;
    settings: VoiceSettings;
  }): Promise<SynthesisResult> {
    const { wav, words } = synthesizeMockWav(args.text, args.settings.speed);
    return { audio: wav, mime: 'audio/wav', ext: '.wav', words, characters: args.text.length };
  }
  async testConnection() {
    return { ok: true, message: 'Mock voice provider (MOCK_PROVIDERS=true).' };
  }
  async usage() {
    return null;
  }
}
