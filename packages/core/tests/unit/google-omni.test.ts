import { describe, expect, it } from 'vitest';
import { GoogleOmniProvider, usesInteractionsApi } from '../../src/providers/video/google-omni';
import { json, mockFetch } from './helpers';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const make = (fetchImpl: ReturnType<typeof mockFetch>['fetch']) =>
  new GoogleOmniProvider({
    label: 'Omni',
    apiKey: 'g-key',
    model: 'gemini-omni-1.1-flash',
    baseUrl: BASE,
    durations: [4, 6, 8],
    fetchImpl,
  });
const VIDEO_URI = `${BASE}/files/abc123:download?alt=media`;
const done = {
  id: 'v1_abc',
  status: 'completed',
  steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', uri: VIDEO_URI }] }],
};

describe('Gemini Omni Flash (Interactions API)', () => {
  it('routes Omni models to the Interactions API and Veo to predictLongRunning', () => {
    expect(usesInteractionsApi('gemini-omni-1.1-flash')).toBe(true);
    expect(usesInteractionsApi('veo-3.1-generate-preview')).toBe(false);
    expect(usesInteractionsApi('')).toBe(false);
  });

  it('submits a background interaction with duration and negatives in the prompt', async () => {
    const m = mockFetch([() => json({ id: 'v1_abc', status: 'in_progress' })]);
    const job = await make(m.fetch).createVideo({
      prompt: 'Neon rooftop party',
      negativePrompt: 'logos',
      aspectRatio: '4:5',
      durationSec: 7,
      referenceImage: { data: Buffer.from('jpg'), mimeType: 'image/jpeg' },
    });
    expect(job).toMatchObject({
      providerJobId: 'v1_abc',
      submitted: { aspectRatio: '9:16', durationSec: 8 },
    });
    const call = m.calls[0]!;
    expect(call.url).toBe(`${BASE}/interactions`);
    expect(call.headers['x-goog-api-key']).toBe('g-key');
    const body = call.body as any;
    expect(body).toMatchObject({
      model: 'gemini-omni-1.1-flash',
      background: true,
      response_format: { type: 'video', aspect_ratio: '9:16', delivery: 'uri' },
      generation_config: { video_config: { task: 'image_to_video' } },
    });
    expect(body.input[0]).toEqual({
      type: 'image',
      data: Buffer.from('jpg').toString('base64'),
      mime_type: 'image/jpeg',
    });
    expect(body.input[1].text).toMatch(/Neon rooftop party[\s\S]*Duration: 8 seconds\. Avoid: logos\./);
  });

  it('falls back to a blocking call when background execution is rejected', async () => {
    const m = mockFetch([
      () => json({ error: { code: 400, message: 'background is not supported for this model' } }, 400),
      () => json(done),
    ]);
    const job = await make(m.fetch).createVideo({ prompt: 'x', aspectRatio: '16:9', durationSec: 4 });
    expect(job.providerJobId).toBe('v1_abc');
    expect((m.calls[1]!.body as any).background).toBeUndefined();
    expect((m.calls[1]!.body as any).input).toMatch(/^x\n\nDuration: 4 seconds\.$/);
  });

  it('polls status, waits for the file and downloads it', async () => {
    const mp4 = Buffer.alloc(4096, 1);
    const m = mockFetch([
      () => json({ id: 'v1_abc', status: 'in_progress' }),
      () => json(done),
      () => json({ name: 'files/abc123', state: 'PROCESSING' }),
      () => json(done),
      () => json({ name: 'files/abc123', state: 'ACTIVE' }),
      () => json(done),
      () => new Response(mp4, { headers: { 'content-type': 'video/mp4' } }),
    ]);
    const p = make(m.fetch);
    expect((await p.getJobStatus('v1_abc')).state).toBe('generating');
    expect((await p.getJobStatus('v1_abc')).state).toBe('generating');
    expect(await p.getJobStatus('v1_abc')).toMatchObject({ state: 'completed', resultUrls: [VIDEO_URI] });
    const video = await p.downloadResult('v1_abc');
    expect(video.data.length).toBe(4096);
    expect(m.calls[0]!.url).toBe(`${BASE}/interactions/v1_abc`);
    expect(m.calls[2]!.url).toBe(`${BASE}/files/abc123`);
    expect(m.calls[6]!.url).toBe(VIDEO_URI);
  });

  it('reports failures and refusals clearly', () => {
    expect(
      GoogleOmniProvider.parseInteraction({ status: 'failed', error: { message: 'quota exceeded' } }),
    ).toEqual({ state: 'failed', error: 'quota exceeded' });
    expect(
      GoogleOmniProvider.parseInteraction({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'I cannot create that video.' }] }],
      }),
    ).toEqual({ state: 'failed', error: 'The model returned no video: I cannot create that video.' });
  });

  it('decodes inline base64 videos and rejects foreign download hosts', async () => {
    const inline = {
      id: 'v1_x',
      status: 'completed',
      steps: [
        {
          type: 'model_output',
          content: [{ type: 'video', data: Buffer.alloc(2000, 2).toString('base64') }],
        },
      ],
    };
    const a = mockFetch([() => json(inline)]);
    expect((await make(a.fetch).downloadResult('v1_x')).data.length).toBe(2000);
    const evil = {
      ...done,
      steps: [{ type: 'model_output', content: [{ type: 'video', uri: 'https://evil.example.com/v.mp4' }] }],
    };
    const b = mockFetch([() => json(evil)]);
    await expect(make(b.fetch).downloadResult('v1_abc')).rejects.toThrow(/unexpected download host/);
    await expect(make(b.fetch).getJobStatus('../../etc')).rejects.toThrow(/invalid interaction id/);
  });
});
