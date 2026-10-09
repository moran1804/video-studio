import { describe, expect, it } from 'vitest';
import { GoogleVideoProvider } from '../../src/providers/video/google';
import { RunwayProvider } from '../../src/providers/video/runway';
import { pickAspectRatio, pickDuration } from '../../src/providers/video/types';
import { OpenAIClient, toStrictJsonSchema } from '../../src/providers/llm/openai';
import { alignmentToWords, ElevenLabsClient, synthesizeMockWav } from '../../src/providers/tts/elevenlabs';
import { MockVideoProvider } from '../../src/providers/video/mock';
import { providerFetch } from '../../src/providers/http';
import { ProviderError } from '../../src/errors';
import { briefSchema, storyboardSchema } from '../../src/schemas';
import { json, mockFetch } from './helpers';

const image = { data: Buffer.from('fakejpeg'), mimeType: 'image/jpeg' as const };

describe('provider helpers', () => {
  it('picks supported durations and aspect ratios', () => {
    expect(pickDuration(3, [4, 6, 8])).toBe(4);
    expect(pickDuration(6, [4, 6, 8])).toBe(6);
    expect(pickDuration(12, [4, 6, 8])).toBe(8);
    expect(pickAspectRatio('4:5', ['16:9', '9:16'])).toBe('9:16');
    expect(pickAspectRatio('1:1', ['16:9', '9:16'])).toBe('9:16');
    expect(pickAspectRatio('16:9', ['16:9', '9:16'])).toBe('16:9');
  });
});

describe('GoogleVideoProvider (Gemini Omni Flash / Veo)', () => {
  const make = (fetchImpl: ReturnType<typeof mockFetch>['fetch'], model = 'veo-3.1-generate-preview') =>
    new GoogleVideoProvider({
      id: 'veo',
      label: 'Veo',
      apiKey: 'AIzaTESTKEY',
      model,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      durations: [4, 6, 8],
      costPerSecond: 0.4,
      fetchImpl,
    });

  it('maps the common request into a predictLongRunning call', async () => {
    const m = mockFetch([() => json({ name: 'models/veo-3.1-generate-preview/operations/op123' })]);
    const job = await make(m.fetch).createVideo({
      prompt: 'A neon rooftop party',
      aspectRatio: '4:5',
      durationSec: 5,
      referenceImage: image,
      negativePrompt: 'blurry',
    });
    expect(job.providerJobId).toBe('models/veo-3.1-generate-preview/operations/op123');
    expect(job.submitted).toEqual({ aspectRatio: '9:16', durationSec: 6, model: 'veo-3.1-generate-preview' });
    expect(job.estimatedCostUsd).toBe(2.4);
    const call = m.calls[0]!;
    expect(call.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning',
    );
    expect(call.method).toBe('POST');
    expect(call.headers['x-goog-api-key']).toBe('AIzaTESTKEY');
    expect(call.body).toMatchObject({
      instances: [
        {
          prompt: 'A neon rooftop party',
          image: { bytesBase64Encoded: image.data.toString('base64'), mimeType: 'image/jpeg' },
        },
      ],
      parameters: { aspectRatio: '9:16', durationSeconds: 6, negativePrompt: 'blurry' },
    });
  });

  it('fails clearly when no model is configured', async () => {
    const m = mockFetch([() => json({})]);
    await expect(
      make(m.fetch, '').createVideo({ prompt: 'x', aspectRatio: '9:16', durationSec: 4 }),
    ).rejects.toThrow(/no model configured/);
    expect(m.calls).toHaveLength(0);
  });

  it('parses operation states', () => {
    expect(GoogleVideoProvider.parseOperation({ name: 'x', done: false })).toEqual({ state: 'generating' });
    expect(
      GoogleVideoProvider.parseOperation({ done: true, error: { code: 3, message: 'bad prompt' } }),
    ).toMatchObject({ state: 'failed', error: 'bad prompt' });
    expect(
      GoogleVideoProvider.parseOperation({
        done: true,
        response: {
          generateVideoResponse: {
            generatedSamples: [
              {
                video: {
                  uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media',
                },
              },
            ],
          },
        },
      }),
    ).toMatchObject({
      state: 'completed',
      resultUrls: ['https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media'],
    });
    expect(
      GoogleVideoProvider.parseOperation({
        done: true,
        response: { generateVideoResponse: { raiMediaFilteredReasons: ['celebrity'] } },
      }),
    ).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('safety filters'),
    });
  });

  it('downloads results only from Google hosts', async () => {
    const video = Buffer.alloc(5000, 1);
    const ok = mockFetch([
      () =>
        json({
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [
                {
                  video: {
                    uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc:download?alt=media',
                  },
                },
              ],
            },
          },
        }),
      () => new Response(video, { headers: { 'content-type': 'video/mp4' } }),
    ]);
    const res = await make(ok.fetch).downloadResult('models/veo/operations/abc');
    expect(res.data.length).toBe(5000);
    expect(ok.calls[1]!.headers['x-goog-api-key']).toBe('AIzaTESTKEY');

    const evil = mockFetch([
      () =>
        json({
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [{ video: { uri: 'https://evil.example.com/x.mp4' } }],
            },
          },
        }),
    ]);
    await expect(make(evil.fetch).downloadResult('models/veo/operations/abc')).rejects.toThrow(
      /unexpected download host/,
    );
  });

  it('rejects malformed operation ids', async () => {
    const m = mockFetch([() => json({})]);
    await expect(make(m.fetch).getJobStatus('../../etc/passwd')).rejects.toThrow(/invalid operation id/);
  });
});

describe('RunwayProvider', () => {
  const make = (fetchImpl: ReturnType<typeof mockFetch>['fetch']) =>
    new RunwayProvider({
      apiKey: 'key_test',
      model: 'gen4.5',
      baseUrl: 'https://api.dev.runwayml.com',
      apiVersion: '2024-11-06',
      durations: [5, 10],
      fetchImpl,
    });

  it('uses text_to_video without an image and image_to_video with one', async () => {
    const m = mockFetch([() => json({ id: 'task-0001-abcd' }), () => json({ id: 'task-0002-abcd' })]);
    const p = make(m.fetch);
    await p.createVideo({ prompt: 'Sunset drone shot', aspectRatio: '9:16', durationSec: 4 });
    await p.createVideo({ prompt: 'Animate', aspectRatio: '4:5', durationSec: 7, referenceImage: image });
    expect(m.calls[0]!.url).toBe('https://api.dev.runwayml.com/v1/text_to_video');
    expect(m.calls[0]!.body).toEqual({
      model: 'gen4.5',
      promptText: 'Sunset drone shot',
      ratio: '720:1280',
      duration: 5,
    });
    expect(m.calls[0]!.headers.authorization).toBe('Bearer key_test');
    expect(m.calls[0]!.headers['x-runway-version']).toBe('2024-11-06');
    expect(m.calls[1]!.url).toBe('https://api.dev.runwayml.com/v1/image_to_video');
    expect(m.calls[1]!.body).toMatchObject({
      ratio: '832:1104',
      duration: 10,
      promptImage: expect.stringMatching(/^data:image\/jpeg;base64,/),
    });
  });

  it('parses task states', () => {
    expect(RunwayProvider.parseTask({ id: 'a', status: 'PENDING' }).state).toBe('queued');
    expect(RunwayProvider.parseTask({ id: 'a', status: 'THROTTLED' }).state).toBe('queued');
    expect(RunwayProvider.parseTask({ id: 'a', status: 'RUNNING', progress: 0.4 })).toEqual({
      state: 'generating',
      progress: 0.4,
    });
    expect(
      RunwayProvider.parseTask({ id: 'a', status: 'SUCCEEDED', output: ['https://x/y.mp4'] }),
    ).toMatchObject({ state: 'completed' });
    expect(RunwayProvider.parseTask({ id: 'a', status: 'SUCCEEDED' }).state).toBe('failed');
    expect(RunwayProvider.parseTask({ id: 'a', status: 'FAILED', failure: 'moderation' })).toMatchObject({
      state: 'failed',
      error: 'moderation',
    });
    expect(RunwayProvider.parseTask({ id: 'a', status: 'CANCELLED' }).state).toBe('cancelled');
  });

  it('cancels with DELETE and explains text-only rejections', async () => {
    const m = mockFetch([() => new Response(null, { status: 204 })]);
    await make(m.fetch).cancelJob('task-0001-abcd');
    expect(m.calls[0]).toMatchObject({
      method: 'DELETE',
      url: 'https://api.dev.runwayml.com/v1/tasks/task-0001-abcd',
    });

    const bad = mockFetch([() => json({ error: 'promptImage is required' }, 400)]);
    await expect(
      make(bad.fetch).createVideo({ prompt: 'x', aspectRatio: '9:16', durationSec: 5 }),
    ).rejects.toThrow(/attach a reference image/);
  });
});

describe('OpenAIClient', () => {
  const make = (fetchImpl: ReturnType<typeof mockFetch>['fetch']) =>
    new OpenAIClient({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      transcriptionModel: 'gpt-4o-transcribe',
      fetchImpl,
    });

  const brief = {
    concept: 'c',
    openingHook: 'h',
    narrativeStructure: 'n',
    visualDirection: 'v',
    colourAndLighting: 'cl',
    editingPace: 'e',
    suggestedVoiceover: 's',
    captionStyle: 'cs',
    musicDirection: 'm',
    closingCta: 'cta',
  };

  it('produces strict JSON schemas', () => {
    const s = toStrictJsonSchema(storyboardSchema) as {
      additionalProperties: boolean;
      required: string[];
      properties: {
        scenes: {
          items: {
            additionalProperties: boolean;
            required: string[];
            properties: Record<string, { type?: string; enum?: string[]; minimum?: number }>;
          };
        };
      };
    };
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(['scenes']);
    const item = s.properties.scenes.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toContain('transition');
    expect(item.properties.transition!.enum).toContain('fade');
    expect(JSON.stringify(s)).not.toMatch(/"minimum"|"\$schema"/);
  });

  it('sends a structured-output request and validates the response', async () => {
    const m = mockFetch([
      () =>
        json({
          output: [
            { type: 'reasoning' },
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(brief) }] },
          ],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
    ]);
    const res = await make(m.fetch).generateBrief({
      project: { name: 'P', platform: 'tiktok', aspectRatio: '9:16', durationSec: 20, details: {} },
      references: [],
    });
    expect(res.brief).toEqual(briefSchema.parse(brief));
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    const body = m.calls[0]!.body as {
      model: string;
      text: { format: { type: string; strict: boolean; name: string } };
    };
    expect(m.calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(body.model).toBe('gpt-test');
    expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true, name: 'creative_brief' });
  });

  it('treats refusals as fatal and malformed output as retryable', async () => {
    const refusal = mockFetch([
      () => json({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }),
    ]);
    const err = await make(refusal.fetch)
      .generateBrief({
        project: { name: 'P', platform: 't', aspectRatio: '9:16', durationSec: 20, details: {} },
        references: [],
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);

    const bad = mockFetch([
      () =>
        json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"concept": 1}' }] }] }),
    ]);
    const err2 = await make(bad.fetch)
      .generateBrief({
        project: { name: 'P', platform: 't', aspectRatio: '9:16', durationSec: 20, details: {} },
        references: [],
      })
      .catch((e) => e);
    expect(err2).toBeInstanceOf(ProviderError);
    expect(err2.retryable).toBe(true);
  });
});

describe('ElevenLabs', () => {
  it('collapses character alignment into words', () => {
    const text = 'Hi there you';
    const chars = text.split('');
    const words = alignmentToWords({
      characters: chars,
      character_start_times_seconds: chars.map((_, i) => i * 0.1),
      character_end_times_seconds: chars.map((_, i) => i * 0.1 + 0.1),
    });
    expect(words.map((w) => w.word)).toEqual(['Hi', 'there', 'you']);
    expect(words[1]!.start).toBeCloseTo(0.3);
    expect(words[1]!.end).toBeCloseTo(0.8);
  });

  it('maps voice settings and returns audio + timings', async () => {
    const m = mockFetch([
      () =>
        json({
          audio_base64: Buffer.from('ID3fakeaudio').toString('base64'),
          alignment: {
            characters: ['G', 'o'],
            character_start_times_seconds: [0, 0.1],
            character_end_times_seconds: [0.1, 0.2],
          },
        }),
    ]);
    const client = new ElevenLabsClient({
      apiKey: 'xi-test',
      baseUrl: 'https://api.elevenlabs.io',
      defaultModel: 'eleven_multilingual_v2',
      fetchImpl: m.fetch,
    });
    const out = await client.synthesize({
      text: 'Go',
      voiceId: 'abcdEFGH1234',
      settings: {
        mode: 'per-scene',
        voiceId: 'abcdEFGH1234',
        voiceName: '',
        modelId: '',
        stability: 0.3,
        similarityBoost: 0.8,
        style: 0.1,
        speakerBoost: true,
        speed: 1.1,
      },
    });
    expect(out.words).toEqual([{ word: 'Go', start: 0, end: 0.2 }]);
    expect(m.calls[0]!.url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/abcdEFGH1234/with-timestamps?output_format=mp3_44100_128',
    );
    expect(m.calls[0]!.headers['xi-api-key']).toBe('xi-test');
    expect(m.calls[0]!.body).toEqual({
      text: 'Go',
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.3,
        similarity_boost: 0.8,
        style: 0.1,
        use_speaker_boost: true,
        speed: 1.1,
      },
    });
  });

  it('rejects invalid voice ids before calling the API', async () => {
    const m = mockFetch([() => json({})]);
    const client = new ElevenLabsClient({
      apiKey: 'x',
      baseUrl: 'https://api.elevenlabs.io',
      defaultModel: 'm',
      fetchImpl: m.fetch,
    });
    await expect(
      client.synthesize({ text: 'x', voiceId: '../../v1/user', settings: {} as never }),
    ).rejects.toThrow(/valid voice/);
    expect(m.calls).toHaveLength(0);
  });

  it('mock TTS produces a valid WAV with word timings', () => {
    const { wav, words, durationSec } = synthesizeMockWav('Hello brave new world.');
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(words).toHaveLength(4);
    expect(words[3]!.end).toBeLessThan(durationSec);
  });
});

describe('MockVideoProvider', () => {
  it('encodes the request in a restart-safe job id and supports forced failure', async () => {
    const p = new MockVideoProvider({ delayMs: 0 });
    const job = await p.createVideo({ prompt: 'hello', aspectRatio: '9:16', durationSec: 3 });
    expect(job.providerJobId.startsWith('mock_')).toBe(true);
    expect((await p.getJobStatus(job.providerJobId)).state).toBe('completed');
    const bad = await p.createVideo({ prompt: 'x [mock-fail]', aspectRatio: '9:16', durationSec: 3 });
    expect((await p.getJobStatus(bad.providerJobId)).state).toBe('failed');
  });
});

describe('providerFetch retries', () => {
  it('retries retryable statuses and respects Retry-After', async () => {
    const m = mockFetch([
      () => json({ error: { message: 'busy' } }, 503),
      () => json({ error: { message: 'slow down' } }, 429, { 'retry-after': '0' }),
      () => json({ ok: true }),
    ]);
    const res = await providerFetch({
      provider: 'Test',
      url: 'https://api.test/x',
      fetchImpl: m.fetch,
      retryBaseMs: 1,
    });
    expect(await res.json()).toEqual({ ok: true });
    expect(m.calls).toHaveLength(3);
  });

  it('does not retry auth errors and produces a friendly message', async () => {
    const m = mockFetch([() => json({ error: { message: 'Invalid key sk-proj-SHOULDNOTLEAK12345' } }, 401)]);
    const err = await providerFetch({
      provider: 'OpenAI',
      url: 'https://api.test/x',
      fetchImpl: m.fetch,
      retryBaseMs: 1,
    }).catch((e) => e);
    expect(m.calls).toHaveLength(1);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/authentication failed/);
    expect(err.message).not.toContain('SHOULDNOTLEAK');
  });

  it('gives up after the configured retries on network errors', async () => {
    let n = 0;
    const err = await providerFetch({
      provider: 'Net',
      url: 'https://api.test/x',
      retries: 2,
      retryBaseMs: 1,
      fetchImpl: async () => {
        n++;
        throw new Error('ECONNRESET');
      },
    }).catch((e) => e);
    expect(n).toBe(3);
    expect(err.retryable).toBe(true);
  });
});
