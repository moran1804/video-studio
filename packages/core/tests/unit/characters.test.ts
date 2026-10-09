import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GoogleVideoProvider } from '../../src/providers/video/google';
import { GoogleOmniProvider } from '../../src/providers/video/google-omni';
import { KlingMotionProvider, signKlingJwt } from '../../src/providers/video/kling';
import { GeminiImageProvider } from '../../src/providers/image/gemini-image';
import { lookPrompt, withIdentity } from '../../src/schemas';
import { keyframePrompt, referencePrompt } from '../../src/jobs/character';
import { json, mockFetch } from './helpers';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const img = (s: string) => ({ data: Buffer.from(s), mimeType: 'image/jpeg' as const });
const maya = {
  name: 'Maya',
  description: 'adult woman, shoulder-length wavy black hair, olive bomber jacket',
};

describe('Veo 3.1 with character references', () => {
  const veo = (fetchImpl?: ReturnType<typeof mockFetch>['fetch']) =>
    new GoogleVideoProvider({
      id: 'veo',
      label: 'Veo',
      apiKey: 'k',
      model: 'veo-3.1-generate-preview',
      baseUrl: BASE,
      durations: [4, 6, 8],
      fetchImpl,
    });

  it('sends up to 3 asset references, forces 8 s and adult-only people', () => {
    const { body, durationSec } = veo().buildRequestBody({
      prompt: 'p',
      aspectRatio: '9:16',
      durationSec: 4,
      referenceImage: img('frame'),
      characterReferences: [img('a'), img('b'), img('c'), img('d')],
    });
    const b = body as any;
    expect(durationSec).toBe(8);
    expect(b.parameters).toMatchObject({ durationSeconds: 8, personGeneration: 'allow_adult' });
    expect(b.instances[0].referenceImages).toHaveLength(3);
    expect(b.instances[0].referenceImages[0]).toEqual({
      image: { bytesBase64Encoded: Buffer.from('a').toString('base64'), mimeType: 'image/jpeg' },
      referenceType: 'asset',
    });
    // Veo rejects a start frame with references (confirmed live): the keyframe is the last reference.
    expect(b.instances[0].image).toBeUndefined();
    expect(
      b.instances[0].referenceImages.map((r: any) =>
        Buffer.from(r.image.bytesBase64Encoded, 'base64').toString(),
      ),
    ).toEqual(['a', 'b', 'frame']);
  });

  it('writes the negative prompt into the text when references are attached (Veo rejects the field)', () => {
    const { body } = veo().buildRequestBody({
      prompt: 'She jogs.',
      negativePrompt: 'logos, watermarks',
      aspectRatio: '9:16',
      durationSec: 8,
      characterReferences: [img('a')],
    });
    const b = body as any;
    expect(b.parameters.negativePrompt).toBeUndefined();
    expect(b.instances[0].prompt).toBe('She jogs. Avoid: logos, watermarks.');
    // Without references the field is still used.
    const plain = veo().buildRequestBody({
      prompt: 'x',
      negativePrompt: 'logos',
      aspectRatio: '9:16',
      durationSec: 8,
    }).body as any;
    expect(plain.parameters.negativePrompt).toBe('logos');
  });

  it('retries without the negative prompt field when Veo rejects it', async () => {
    const m = mockFetch([
      () =>
        json({ error: { code: 400, message: 'Negative prompt is not supported in your use case.' } }, 400),
      () => json({ name: 'models/veo-3.1-generate-preview/operations/n1' }),
    ]);
    const job = await veo(m.fetch).createVideo({
      prompt: 'p',
      negativePrompt: 'logos',
      aspectRatio: '9:16',
      durationSec: 8,
      referenceImage: img('frame'),
    });
    expect(job.providerJobId).toMatch(/operations\/n1$/);
    const retry = m.calls[1]!.body as any;
    expect(retry.parameters.negativePrompt).toBeUndefined();
    expect(retry.instances[0].prompt).toBe('p Avoid: logos.');
    expect(retry.instances[0].image).toBeDefined(); // start frame kept
  });

  it('does not hide unrelated 400 errors behind a retry', async () => {
    const m = mockFetch([() => json({ error: { code: 400, message: 'Unsupported aspect ratio' } }, 400)]);
    await expect(
      veo(m.fetch).createVideo({
        prompt: 'p',
        aspectRatio: '9:16',
        durationSec: 8,
        referenceImage: img('f'),
        characterReferences: [img('a')],
      }),
    ).rejects.toThrow(/Unsupported aspect ratio/);
    expect(m.calls).toHaveLength(1);
  });

  it('keeps normal durations and no person setting without references', () => {
    const { body, durationSec } = veo().buildRequestBody({
      prompt: 'p',
      aspectRatio: '9:16',
      durationSec: 4,
    });
    expect(durationSec).toBe(4);
    expect((body as any).parameters.personGeneration).toBeUndefined();
  });
});

describe('Omni reference-to-video', () => {
  it('puts references first with <IMAGE_REF_n> roles and the keyframe last', () => {
    const omni = new GoogleOmniProvider({
      label: 'Omni',
      apiKey: 'k',
      model: 'gemini-omni-1.1-flash',
      baseUrl: BASE,
      durations: [4, 6, 8],
    });
    const { body } = omni.buildRequestBody({
      prompt: 'Walks through a market',
      aspectRatio: '9:16',
      durationSec: 8,
      referenceImage: img('frame'),
      characterReferences: [img('face'), img('body')],
    });
    const b = body as any;
    expect(b.generation_config.video_config.task).toBe('reference_to_video');
    expect(b.input).toHaveLength(4);
    expect(Buffer.from(b.input[2].data, 'base64').toString()).toBe('frame');
    expect(b.input[3].text).toMatch(/The person in <IMAGE_REF_0>, <IMAGE_REF_1> is the main character/);
    expect(b.input[3].text).toMatch(/composition, setting and pose shown in <IMAGE_REF_2>/);
    expect(b.input[3].text).toContain('Walks through a market');
  });
});

describe('Nano Banana Pro images', () => {
  const p = (fetchImpl: ReturnType<typeof mockFetch>['fetch']) =>
    new GeminiImageProvider({ apiKey: 'g', model: 'gemini-3-pro-image', baseUrl: BASE, fetchImpl });

  it('sends references inline and reads the image back', async () => {
    const png = Buffer.alloc(64, 7);
    const m = mockFetch([
      () =>
        json({
          candidates: [
            {
              content: {
                parts: [
                  { text: 'here' },
                  { inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
                ],
              },
            },
          ],
        }),
    ]);
    const out = await p(m.fetch).generateImage({
      prompt: 'portrait',
      references: [img('r1')],
      aspectRatio: '4:5',
    });
    expect(out).toEqual({ data: png, mimeType: 'image/png' });
    expect(m.calls[0]!.url).toBe(`${BASE}/models/gemini-3-pro-image:generateContent`);
    const body = m.calls[0]!.body as any;
    expect(body.generationConfig).toEqual({
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: '4:5' },
    });
    expect(body.contents[0].parts[0].inlineData.data).toBe(Buffer.from('r1').toString('base64'));
    expect(body.contents[0].parts.at(-1).text).toBe('portrait');
  });

  it('explains safety blocks and empty answers', async () => {
    const blocked = mockFetch([() => json({ promptFeedback: { blockReason: 'SAFETY' } })]);
    await expect(
      p(blocked.fetch).generateImage({ prompt: 'x', references: [], aspectRatio: '1:1' }),
    ).rejects.toThrow(/safety filters/);
    const refused = mockFetch([
      () =>
        json({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [{ text: 'I cannot' }] } }] }),
    ]);
    await expect(
      p(refused.fetch).generateImage({ prompt: 'x', references: [], aspectRatio: '1:1' }),
    ).rejects.toThrow(/no image \(IMAGE_SAFETY\): I cannot/);
  });
});

describe('Kling motion control', () => {
  const kling = (apiKey: string, fetchImpl?: ReturnType<typeof mockFetch>['fetch']) =>
    new KlingMotionProvider({
      apiKey,
      baseUrl: 'https://api-singapore.klingai.com',
      model: 'kling-v3.0-motion-control',
      mode: 'pro',
      costPerSecond: 0.18,
      fetchImpl,
    });

  it('signs a valid HS256 JWT from an access/secret pair', () => {
    const token = signKlingJwt('ak', 'sk', 1_000_000);
    const [h, p, sig] = token.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({
      iss: 'ak',
      exp: 1_001_800,
      nbf: 999_995,
    });
    expect(sig).toBe(crypto.createHmac('sha256', 'sk').update(`${h}.${p}`).digest('base64url'));
  });

  it('creates, polls and downloads a motion-transfer clip', async () => {
    const mp4 = Buffer.alloc(5000, 1);
    const m = mockFetch([
      () => json({ code: 0, data: { task_id: 'T123', task_status: 'submitted' } }),
      () => json({ code: 0, data: { task_id: 'T123', task_status: 'processing' } }),
      () =>
        json({
          code: 0,
          data: {
            task_id: 'T123',
            task_status: 'succeed',
            task_result: { videos: [{ url: 'https://cdn.klingai.com/v/T123.mp4' }] },
          },
        }),
      () =>
        json({
          code: 0,
          data: {
            task_id: 'T123',
            task_status: 'succeed',
            task_result: { videos: [{ url: 'https://cdn.klingai.com/v/T123.mp4' }] },
          },
        }),
      () => new Response(mp4, { headers: { 'content-type': 'video/mp4' } }),
    ]);
    const p = kling('ak:sk', m.fetch);
    const job = await p.createVideo({
      prompt: 'rooftop at night',
      aspectRatio: '9:16',
      durationSec: 8,
      referenceImage: img('keyframe'),
      motionVideo: { data: Buffer.from('dance'), mimeType: 'video/mp4', durationSec: 12.4 },
    });
    expect(job).toMatchObject({
      providerJobId: 'T123',
      provider: 'kling',
      submitted: { durationSec: 12 },
      estimatedCostUsd: 2.16,
    });
    const req = m.calls[0]!;
    expect(req.url).toBe('https://api-singapore.klingai.com/v1/videos/motion-control');
    expect(req.headers.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(req.body).toMatchObject({
      model_name: 'kling-v3.0-motion-control',
      image_url: Buffer.from('keyframe').toString('base64'),
      video_url: Buffer.from('dance').toString('base64'),
      character_orientation: 'video',
      mode: 'pro',
      keep_original_sound: 'no',
    });
    expect((await p.getJobStatus('T123')).state).toBe('generating');
    expect(await p.getJobStatus('T123')).toMatchObject({
      state: 'completed',
      resultUrls: ['https://cdn.klingai.com/v/T123.mp4'],
    });
    expect((await p.downloadResult('T123')).data.length).toBe(5000);
    expect(m.calls[1]!.url).toBe('https://api-singapore.klingai.com/v1/videos/motion-control/T123');
  });

  it('uses a plain key as Bearer and reports API errors clearly', async () => {
    const m = mockFetch([() => json({ code: 1102, message: 'video_url is invalid' })]);
    await expect(
      kling('plain-key', m.fetch).createVideo({
        prompt: 'x',
        aspectRatio: '9:16',
        durationSec: 5,
        referenceImage: img('k'),
        motionVideo: { data: Buffer.from('v'), mimeType: 'video/mp4', durationSec: 5 },
      }),
    ).rejects.toThrow(/video_url is invalid.*public link/);
    expect(m.calls[0]!.headers.authorization).toBe('Bearer plain-key');
  });

  it('rejects foreign download hosts and bad task ids', async () => {
    const m = mockFetch([
      () =>
        json({
          code: 0,
          data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://evil.example/v.mp4' }] } },
        }),
    ]);
    await expect(kling('k', m.fetch).downloadResult('T1')).rejects.toThrow(/unexpected download host/);
    await expect(kling('k').getJobStatus('../x')).rejects.toThrow(/invalid task id/);
  });
});

describe('identity-locked prompts', () => {
  it('repeats the identity, look and narrator-only rule', () => {
    const p = withIdentity('She jogs along the beach.', [maya], { look: 'ugc', silent: true });
    expect(p).toMatch(/^The same person in every shot – adult woman, shoulder-length wavy black hair/);
    expect(p).toContain('She jogs along the beach.');
    expect(p).toContain(lookPrompt('ugc'));
    expect(p).toContain('Nobody speaks');
    expect(lookPrompt('nope')).toBe(lookPrompt('ugc'));
  });

  it('builds reference and keyframe prompts without text or other people', () => {
    expect(referencePrompt('ref-face', maya.description)).toMatch(
      /head-and-shoulders portrait.*One person only. No text/s,
    );
    const k = keyframePrompt(
      'at a rooftop party',
      { characters: [{ id: '1', ...maya }], references: [] },
      'cinematic',
      'Match the pose',
    );
    expect(k).toContain('Scene: at a rooftop party');
    expect(k).toContain(maya.description);
    expect(k).toContain('Match the pose');
    expect(k).toContain(lookPrompt('cinematic'));
  });
});
