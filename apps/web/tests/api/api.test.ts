/**
 * API integration + mocked end-to-end flow against a running stack
 * (docker compose up with MOCK_PROVIDERS=true).
 *
 *   STUDIO_URL=http://localhost:3000 STUDIO_EMAIL=admin@example.com STUDIO_PASSWORD=... npm run test:api
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { synthesizeMockWav } from '../../../../packages/core/src/providers/tts/elevenlabs';
import { makePng } from '../../../../packages/core/tests/fixtures/png';

const BASE = process.env.STUDIO_URL;
const EMAIL = process.env.STUDIO_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.STUDIO_PASSWORD ?? '';

const PNG = makePng(64, 64, [255, 0, 128, 255]);

class Client {
  cookies = new Map<string, string>();
  constructor(private readonly origin = BASE!) {}

  private cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private store(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [k, v] = pair!.split('=');
      if (k) {
        if (v === '' || /max-age=0/i.test(c)) this.cookies.delete(k);
        else this.cookies.set(k, v ?? '');
      }
    }
  }

  async raw(path: string, init: RequestInit & { csrf?: boolean; origin?: string } = {}) {
    const headers = new Headers(init.headers);
    headers.set('cookie', this.cookieHeader());
    const method = init.method ?? 'GET';
    if (method !== 'GET') {
      headers.set('origin', init.origin ?? this.origin);
      if (init.csrf !== false && this.cookies.get('vs_csrf'))
        headers.set('x-csrf-token', this.cookies.get('vs_csrf')!);
    }
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' });
    this.store(res);
    return res;
  }

  async json<T = any>(
    path: string,
    method = 'GET',
    body?: unknown,
    extra: { csrf?: boolean; origin?: string } = {},
  ): Promise<{ status: number; data: T }> {
    const res = await this.raw(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      ...extra,
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, data };
  }

  async upload<T = any>(
    path: string,
    name: string,
    bytes: Buffer,
    type: string,
    fields: Record<string, string> = {},
  ) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
    const res = await this.raw(path, { method: 'POST', body: form });
    return { status: res.status, data: (await res.json()) as T };
  }
}

async function until<T>(
  fn: () => Promise<T | false | undefined | null>,
  timeoutMs = 180_000,
  label = 'condition',
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 750));
  }
}

describe.skipIf(!BASE)('Studio API (live stack, mock providers)', () => {
  const c = new Client();
  let projectId = '';
  const bundle = async () => (await c.json(`/api/projects/${projectId}`)).data;

  beforeAll(async () => {
    const r = await c.json('/api/auth/csrf');
    expect(r.status).toBe(200);
  });

  it('reports health without authentication', async () => {
    const r = await fetch(`${BASE}/api/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, db: 'ok', redis: 'ok' });
  });

  it('requires authentication and protects login with CSRF checks', async () => {
    const anon = new Client();
    expect((await anon.json('/api/projects')).status).toBe(401);
    const page = await anon.raw('/login');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'self' 'nonce-/);
    expect(anon.cookies.get('vs_csrf')).toBeTruthy();
    expect(
      (await anon.json('/api/auth/login', 'POST', { email: EMAIL, password: PASSWORD }, { csrf: false }))
        .status,
    ).toBe(403);
    expect(
      (
        await anon.json(
          '/api/auth/login',
          'POST',
          { email: EMAIL, password: PASSWORD },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    expect(
      (await anon.json('/api/auth/login', 'POST', { email: EMAIL, password: 'wrong-password' })).status,
    ).toBe(401);
  });

  it('signs in and out', async () => {
    const tmp = new Client();
    await tmp.json('/api/auth/csrf');
    const login = await tmp.json('/api/auth/login', 'POST', { email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    expect(tmp.cookies.get('vs_session')).toBeTruthy();
    expect((await tmp.json('/api/auth/me')).data.user.email).toBe(EMAIL.toLowerCase());
    expect((await tmp.json('/api/auth/logout', 'POST')).status).toBe(200);
    expect((await tmp.json('/api/projects')).status).toBe(401);

    const r = await c.json('/api/auth/login', 'POST', { email: EMAIL, password: PASSWORD });
    expect(r.status).toBe(200);
  });

  it('creates and edits a project', async () => {
    expect((await c.json('/api/projects', 'POST', { name: '' })).status).toBe(400);
    const r = await c.json('/api/projects', 'POST', {
      name: 'API test – rooftop party',
      platform: 'tiktok',
      aspectRatio: '9:16',
      durationSec: 12,
      details: {
        mainMessage: 'The rooftop party is back',
        callToAction: 'Get tickets',
        tone: 'Neon, energetic',
      },
    });
    expect(r.status).toBe(200);
    projectId = r.data.id;
    const p = await c.json(`/api/projects/${projectId}`, 'PATCH', {
      details: { ...(await bundle()).project.details, audience: 'Students' },
    });
    expect(p.status).toBe(200);
    expect(p.data.project.details.audience).toBe('Students');
    expect(p.data.project.captionSettings.safeZone).toBe('tiktok');
  });

  it('manages the reference board safely', async () => {
    const ok = await c.upload(`/api/projects/${projectId}/references`, 'poster.png', PNG, 'image/png', {
      notes: 'Use this colour palette',
    });
    expect(ok.status).toBe(200);
    expect(ok.data.references[0]).toMatchObject({ category: 'image', notes: 'Use this colour palette' });

    const disguised = await c.upload(
      `/api/projects/${projectId}/references`,
      'evil.png',
      Buffer.from('<html><script>alert(1)</script></html>'),
      'image/png',
    );
    expect(disguised.status).toBe(415);

    expect(
      (
        await c.json(`/api/projects/${projectId}/references`, 'POST', {
          url: 'http://127.0.0.1:6379/',
          permissionConfirmed: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.json(`/api/projects/${projectId}/references`, 'POST', {
          url: 'http://169.254.169.254/latest',
          permissionConfirmed: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (await c.json(`/api/projects/${projectId}/references`, 'POST', { url: 'https://vimeo.com/76979871' }))
        .status,
    ).toBe(400); // permission required

    const refId = ok.data.references[0].id;
    await until(
      async () =>
        ['completed', 'failed', 'limited'].includes(
          (await bundle()).references.find((r: any) => r.id === refId)?.analysisStatus,
        ),
      60_000,
      'reference analysis',
    );
    const ref = (await bundle()).references.find((r: any) => r.id === refId);
    expect(ref.analysisStatus).toBe('completed');
    expect(ref.analysis.palette.length).toBeGreaterThan(0);
  });

  it('generates, edits and approves the creative brief', async () => {
    expect((await c.json(`/api/projects/${projectId}/storyboard/generate`, 'POST', {})).status).toBe(400); // brief not approved
    expect((await c.json(`/api/projects/${projectId}/brief/generate`, 'POST')).status).toBe(200);
    await until(async () => (await bundle()).project.briefStatus === 'draft', 60_000, 'brief');
    const b = await bundle();
    const edited = { ...b.project.brief, openingHook: 'Edited hook: neon countdown' };
    expect(
      (await c.json(`/api/projects/${projectId}/brief`, 'PATCH', { brief: edited })).data.project.brief
        .openingHook,
    ).toBe('Edited hook: neon countdown');
    const approved = await c.json(`/api/projects/${projectId}/brief/approve`, 'POST');
    expect(approved.data.project.briefStatus).toBe('approved');
  });

  it('generates and edits the storyboard', async () => {
    expect((await c.json(`/api/projects/${projectId}/storyboard/generate`, 'POST', {})).status).toBe(200);
    await until(async () => (await bundle()).scenes.length > 0, 60_000, 'storyboard');
    expect((await c.json(`/api/projects/${projectId}/storyboard/generate`, 'POST', {})).data.code).toBe(
      'confirm_replace',
    );

    let b = await bundle();
    const first = b.scenes[0];
    const patched = await c.json(`/api/scenes/${first.id}`, 'PATCH', {
      purpose: 'Edited hook',
      durationSec: 3,
      transition: 'fade',
      onScreenText: 'TONIGHT',
    });
    expect(patched.data.scenes[0]).toMatchObject({
      purpose: 'Edited hook',
      durationSec: 3,
      transition: 'fade',
    });
    expect((await c.json(`/api/scenes/${first.id}`, 'PATCH', { durationSec: 999 })).status).toBe(400);

    const dup = await c.json(`/api/scenes/${first.id}/duplicate`, 'POST');
    expect(dup.data.scenes.length).toBe(b.scenes.length + 1);
    expect(dup.data.scenes[1].purpose).toBe('Edited hook (copy)');

    const added = await c.json(`/api/projects/${projectId}/scenes`, 'POST', {});
    const newScene = added.data.scenes.at(-1);
    expect(newScene.purpose).toBe('New scene');
    await c.json(`/api/scenes/${newScene.id}`, 'PATCH', {
      prompt: 'Confetti falls over a crowd at night',
      voiceoverText: 'See you there',
    });

    b = await bundle();
    const reversed = [...b.scenes].reverse().map((s: any) => s.id);
    const re = await c.json(`/api/projects/${projectId}/scenes/reorder`, 'POST', { ids: reversed });
    expect(re.data.scenes.map((s: any) => s.id)).toEqual(reversed);
    expect(
      (await c.json(`/api/projects/${projectId}/scenes/reorder`, 'POST', { ids: reversed.slice(1) })).status,
    ).toBe(409);
    const back = await c.json(`/api/projects/${projectId}/scenes/reorder`, 'POST', {
      ids: [...reversed].reverse(),
    });
    expect(back.status).toBe(200);

    const del = await c.json(`/api/scenes/${dup.data.scenes[1].id}`, 'DELETE');
    expect(del.data.scenes.map((s: any) => s.position)).toEqual(
      del.data.scenes.map((_: any, i: number) => i),
    );

    expect((await c.json(`/api/scenes/${first.id}/prompt`, 'POST')).status).toBe(200);
    await until(
      async () =>
        !(await bundle()).jobs.some(
          (j: any) => j.type === 'prompt' && ['queued', 'running'].includes(j.status),
        ),
      30_000,
      'prompt',
    );
    expect((await bundle()).scenes[0].prompt).toMatch(/Aspect 9:16/);
  });

  it('generates every scene with the mock provider', async () => {
    const r = await c.json(`/api/projects/${projectId}/generate-all`, 'POST', { onlyMissing: true });
    expect(r.status).toBe(200);
    expect(r.data.queued).toBeGreaterThan(0);
    await until(
      async () => (await bundle()).scenes.every((s: any) => s.status === 'completed'),
      240_000,
      'scene generation',
    );
    const b = await bundle();
    expect(b.scenes.every((s: any) => s.clip?.url && s.thumbnailUrl)).toBe(true);

    // Range requests for scrubbing
    const range = await c.raw(b.scenes[0].clip.url, { headers: { range: 'bytes=0-99' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toMatch(/^bytes 0-99\//);
    expect((await range.arrayBuffer()).byteLength).toBe(100);
  });

  it('retries a failed scene', async () => {
    const added = await c.json(`/api/projects/${projectId}/scenes`, 'POST', {});
    const s = added.data.scenes.at(-1);
    await c.json(`/api/scenes/${s.id}`, 'PATCH', { prompt: 'This will fail [mock-fail]', provider: 'mock' });
    await c.json(`/api/scenes/${s.id}/generate`, 'POST', {});
    await until(
      async () => (await bundle()).scenes.find((x: any) => x.id === s.id)?.status === 'failed',
      60_000,
      'failure',
    );
    const failed = (await bundle()).scenes.find((x: any) => x.id === s.id);
    expect(failed.error).toMatch(/Mock provider failure/);
    const summary = (await c.json('/api/projects')).data.projects.find((p: any) => p.id === projectId);
    expect(summary.failedJobs.length).toBeGreaterThan(0);
    const retry = await c.json(`/api/jobs/${failed.job.id}/retry`, 'POST');
    expect(retry.status).toBe(200);
    await c.json(`/api/scenes/${s.id}`, 'DELETE');
  });

  it('replaces footage with an uploaded clip', async () => {
    const b = await bundle();
    const clip = await c.raw(b.scenes[0].clip.url);
    const bytes = Buffer.from(await clip.arrayBuffer());
    const up = await c.upload(`/api/scenes/${b.scenes[1].id}/clip`, 'my-clip.mp4', bytes, 'video/mp4');
    expect(up.status).toBe(200);
    expect(up.data.scenes[1]).toMatchObject({ clipSource: 'uploaded', status: 'completed' });
  });

  it('lists voices, previews a sample and generates voiceovers', async () => {
    const voices = await c.json('/api/voices');
    expect(voices.data.voices.length).toBeGreaterThan(0);
    const voiceId = voices.data.voices[0].id;
    const sample = await c.raw('/api/voices/sample', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voiceId, settings: { stability: 0.4 } }),
    });
    expect(sample.status).toBe(200);
    expect(sample.headers.get('content-type')).toMatch(/audio/);

    const b = await bundle();
    await c.json(`/api/projects/${projectId}`, 'PATCH', {
      voiceSettings: { ...b.project.voiceSettings, voiceId, mode: 'per-scene' },
    });
    expect((await c.json(`/api/projects/${projectId}/voiceover`, 'POST', { mode: 'per-scene' })).status).toBe(
      200,
    );
    await until(
      async () => (await bundle()).jobs.some((j: any) => j.type === 'voiceover' && j.status === 'completed'),
      60_000,
      'voiceover',
    );
    expect((await bundle()).scenes.filter((s: any) => s.voiceover).length).toBeGreaterThan(0);
  });

  it('uploads licensed music and configures the mix', async () => {
    const { wav } = synthesizeMockWav('la la la la la la la la la la la la');
    const up = await c.upload(`/api/projects/${projectId}/assets?kind=music`, 'track.wav', wav, 'audio/wav');
    expect(up.status).toBe(200);
    expect(up.data.project.audioSettings.musicAssetId).toBe(up.data.audioAssets[0].id);
    const mix = await c.json(`/api/projects/${projectId}`, 'PATCH', {
      audioSettings: {
        ...up.data.project.audioSettings,
        musicVolume: 0.3,
        ducking: true,
        originalAudio: true,
      },
    });
    expect(mix.data.project.audioSettings).toMatchObject({ musicVolume: 0.3, ducking: true });
  });

  it('builds captions and an SRT', async () => {
    const cap = await c.json(`/api/projects/${projectId}/captions`);
    expect(cap.data.cues.length).toBeGreaterThan(0);
    const srt = await c.raw(`/api/projects/${projectId}/captions?format=srt`);
    expect(await srt.text()).toMatch(/^1\n\d{2}:\d{2}:\d{2},\d{3} --> /);
  });

  it('builds a brand design system from assets and applies it', async () => {
    const br = await c.json('/api/brands', 'POST', {
      name: 'Rooftop Sessions',
      primaryColor: '#FF0080',
      handles: { instagram: '@rooftop' },
      outroText: 'Tickets in bio',
    });
    expect(br.status).toBe(200);
    const brandId = br.data.brand.id;

    // Assets: logo becomes the overlay logo; product image and a guidelines doc are stored with roles.
    const logo = await c.upload(`/api/brands/${brandId}/assets`, 'logo.png', PNG, 'image/png', {
      role: 'logo-primary',
      label: 'Main logo',
    });
    expect(logo.status).toBe(200);
    expect(logo.data.brand.logo.url).toMatch(/^\/api\/files\//);
    expect(logo.data.brand.assets[0]).toMatchObject({ role: 'logo-primary', isOverlayLogo: true });
    const product = await c.upload(
      `/api/brands/${brandId}/assets`,
      'product.png',
      makePng(48, 48, [20, 160, 90, 255]),
      'image/png',
      { role: 'product' },
    );
    const productId = product.data.brand.assets.find((a: any) => a.role === 'product').id;
    const doc = await c.upload(
      `/api/brands/${brandId}/assets`,
      'guidelines.md',
      Buffer.from('# Rooftop\nAlways neon pink. Never say cheap.'),
      'text/markdown',
      { role: 'guideline' },
    );
    expect(doc.data.brand.assets.some((a: any) => a.role === 'guideline')).toBe(true);
    const bad = await c.upload(
      `/api/brands/${brandId}/assets`,
      'x.svg',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'image/svg+xml',
      { role: 'logo-icon' },
    );
    expect(bad.status).toBe(415);

    const notes = await c.json(`/api/brands/${brandId}/assets/${productId}`, 'PATCH', {
      notes: 'Hero product',
    });
    expect(notes.data.brand.assets.find((a: any) => a.id === productId).notes).toBe('Hero product');

    // Generate the design system (mock AI) and wait for the draft.
    expect((await c.json(`/api/brands/${brandId}/design-system/generate`, 'POST')).status).toBe(200);
    const draft = await until(
      async () => {
        const b = (await c.json(`/api/brands/${brandId}`)).data.brand;
        if (b.job?.status === 'failed') throw new Error(b.job.error);
        return b.designStatus === 'draft' ? b : null;
      },
      90_000,
      'design system',
    );
    expect(draft.designSystem.palette.length).toBeGreaterThan(0);

    // Edit + approve; core tokens follow the palette.
    const ds = {
      ...draft.designSystem,
      palette: [
        { name: 'Neon', hex: '#FF0080', role: 'primary', usage: 'hero' },
        { name: 'Sun', hex: '#FFD400', role: 'accent', usage: 'highlights' },
      ],
      typography: { ...draft.designSystem.typography, captionFont: 'League Spartan' },
    };
    expect(
      (
        await c.json(`/api/brands/${brandId}`, 'PATCH', {
          designSystem: { ...ds, palette: [{ name: 'x', hex: 'red', role: 'primary', usage: '' }] },
        })
      ).status,
    ).toBe(400);
    const approved = await c.json(`/api/brands/${brandId}`, 'PATCH', {
      designSystem: ds,
      designStatus: 'approved',
    });
    expect(approved.data.brand).toMatchObject({
      designStatus: 'approved',
      primaryColor: '#FF0080',
      accentColor: '#FFD400',
    });
    expect(approved.data.brand.guide).toContain('Neon #FF0080 (primary – hero)');
    expect(approved.data.brand.guide).toContain('Hero product');

    // Selecting the brand applies caption defaults from the design system.
    const p = await c.json(`/api/projects/${projectId}`, 'PATCH', { brandId });
    expect(p.data.brand.name).toBe('Rooftop Sessions');
    expect(p.data.project.captionSettings).toMatchObject({
      font: 'League Spartan',
      highlightColor: '#FFD400',
    });
    const b = await bundle();
    await c.json(`/api/projects/${projectId}`, 'PATCH', {
      brandingSettings: {
        ...b.project.brandingSettings,
        intro: true,
        outro: true,
        watermarkText: '@rooftop',
      },
    });
  });

  it('renders a preview and a final export and serves downloads', async () => {
    const pre = await c.json(`/api/projects/${projectId}/renders`, 'POST', { mode: 'preview' });
    expect(pre.status).toBe(200);
    await until(
      async () => (await bundle()).renders.find((r: any) => r.mode === 'preview')?.status === 'completed',
      300_000,
      'preview render',
    );
    expect((await c.json(`/api/projects/${projectId}/renders`, 'POST', { mode: 'final' })).status).toBe(200);
    const done = await until(
      async () => {
        const r = (await bundle()).renders.find((x: any) => x.mode === 'final');
        if (r?.status === 'failed') throw new Error(`render failed: ${r.error}`);
        return r?.status === 'completed' ? r : null;
      },
      400_000,
      'final render',
    );
    expect(done).toMatchObject({ width: 1080, height: 1920 });
    const mp4 = await c.raw(done.video.downloadUrl);
    expect(mp4.headers.get('content-disposition')).toMatch(/attachment; filename=".*\.mp4"/);
    const buf = Buffer.from(await mp4.arrayBuffer());
    expect(buf.subarray(4, 8).toString()).toBe('ftyp');
    expect(buf.indexOf('moov')).toBeLessThan(buf.indexOf('mdat')); // fast start
    const srt = await c.raw(done.srt.downloadUrl);
    expect(srt.status).toBe(200);
    const summary = (await c.json('/api/projects')).data.projects.find((p: any) => p.id === projectId);
    expect(summary.latestExport).toBeTruthy();
    expect(summary.thumbnailUrl).toBeTruthy();
  });

  it('animates an uploaded poster (no brand or brief needed)', async () => {
    const poster = makePng(300, 420, [240, 120, 20, 255]);
    const up = await c.upload(
      `/api/projects/${projectId}/references`,
      'gig-poster.png',
      poster,
      'image/png',
      {
        usage: 'animate',
      },
    );
    expect(up.status).toBe(200);
    const ref = up.data.references.find((r: any) => r.title === 'gig-poster.png');
    expect(ref).toMatchObject({ usage: 'animate' });

    // Non-images cannot be animated
    const doc = await c.upload(
      `/api/projects/${projectId}/references`,
      'notes.md',
      Buffer.from('# hi'),
      'text/markdown',
      { usage: 'animate' },
    );
    expect(doc.data.references.find((r: any) => r.title === 'notes.md').usage).toBe('inspiration');
    const docRef = doc.data.references.find((r: any) => r.title === 'notes.md');
    expect((await c.json(`/api/references/${docRef.id}`, 'PATCH', { usage: 'animate' })).status).toBe(400);
    expect((await c.json(`/api/references/${docRef.id}/animate-scene`, 'POST', {})).status).toBe(400);

    const created = await c.json(`/api/references/${ref.id}/animate-scene`, 'POST', {});
    expect(created.status).toBe(200);
    const scene = created.data.scenes.find((s: any) => s.id === created.data.sceneId);
    expect(scene).toMatchObject({ animateAssetId: ref.asset.id, status: 'draft' });
    expect(scene.prompt).toMatch(/Bring this artwork to life/);

    // A scene can only animate images from its own project
    expect(
      (
        await c.json(`/api/scenes/${scene.id}`, 'PATCH', {
          animateAssetId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(400);

    await c.json(`/api/scenes/${scene.id}/generate`, 'POST', {});
    const done = await until(
      async () => {
        const s = (await bundle()).scenes.find((x: any) => x.id === scene.id);
        if (s?.status === 'failed') throw new Error(s.error);
        return s?.status === 'completed' ? s : null;
      },
      120_000,
      'animated scene',
    );
    expect(done.clip.url).toMatch(/^\/api\/files\//);
    await c.json(`/api/scenes/${scene.id}`, 'DELETE');
  });

  it('makes a finished video from one request (Create screen)', async () => {
    const created = await c.json('/api/projects', 'POST', {
      name: 'Quick',
      durationSec: 15,
      details: { source: 'quick', request: 'A neon rooftop party teaser' },
    });
    const id = created.data.id;
    await c.upload(
      `/api/projects/${id}/references`,
      'flyer.png',
      makePng(200, 300, [200, 40, 120, 255]),
      'image/png',
      { usage: 'animate' },
    );
    expect((await c.json(`/api/projects/${id}/quick`, 'POST', { prompt: 'x' })).status).toBe(400);
    const start = await c.json(`/api/projects/${id}/quick`, 'POST', {
      prompt: 'A neon rooftop party teaser',
      voiceover: true,
      voiceId: 'mockvoice01',
      captions: true,
    });
    expect(start.status).toBe(200);
    expect(start.data.item.id).toBe(id);
    expect(['queued', 'running']).toContain(start.data.item.job.status);
    expect((await c.json(`/api/projects/${id}/quick`, 'POST', { prompt: 'again please' })).status).toBe(409);

    const item = await until(
      async () => {
        const [i] = (await c.json(`/api/quick?ids=${id}`)).data.items;
        if (i.job.status === 'failed') throw new Error(i.job.error);
        return i.video && i.job.status === 'completed' ? i : null;
      },
      240_000,
      'quick video',
    );
    expect(item.job).toMatchObject({ status: 'completed', stage: 'done' });
    expect(item.video.url).toMatch(/^\/api\/files\//);

    // 15 s split into clips the model can make; the first animates the flyer
    const b = (await c.json(`/api/projects/${id}`)).data;
    expect(b.scenes.length).toBeGreaterThan(1);
    expect(b.scenes[0].animateAssetId).toBeTruthy();
    expect(b.scenes.every((s: any) => s.status === 'completed' && s.voiceoverText)).toBe(true);
    const listed = (await c.json('/api/quick')).data.items.map((i: any) => i.id);
    expect(listed).toContain(id);
    await c.json(`/api/projects/${id}`, 'DELETE');
  });

  it('builds a brand profile from uploaded logos and posters', async () => {
    const br = await c.json('/api/brands', 'POST', { name: 'New brand' });
    const id = br.data.brand.id;
    for (const [name, rgba] of [
      ['logo.png', [250, 0, 120, 255]],
      ['gig-flyer.png', [20, 20, 30, 255]],
    ] as const) {
      const up = await c.upload(`/api/brands/${id}/assets`, name, makePng(60, 60, [...rgba]), 'image/png', {
        role: 'auto',
      });
      expect(up.status).toBe(200);
    }
    const before = (await c.json(`/api/brands/${id}`)).data.brand;
    expect(before.assets.map((a: any) => a.role)).toEqual(['auto', 'auto']);
    expect(before.logo).toBeNull(); // not chosen until the AI has looked

    expect(
      (await c.json(`/api/brands/${id}/design-system/generate`, 'POST', { mode: 'sideways' })).status,
    ).toBe(400);
    expect(
      (
        await c.json(`/api/brands/${id}/design-system/generate`, 'POST', {
          mode: 'create',
          notes: 'Leeds student nights',
        })
      ).status,
    ).toBe(200);
    const built = await until(
      async () => {
        const b = (await c.json(`/api/brands/${id}`)).data.brand;
        if (b.job?.status === 'failed') throw new Error(b.job.error);
        return b.designStatus === 'draft' ? b : null;
      },
      90_000,
      'brand from uploads',
    );
    expect(built.name).toBe('Mock Brand Co');
    expect(built.assets.map((a: any) => a.role).sort()).toEqual(['logo-primary', 'poster']);
    expect(built.logo.url).toMatch(/^\/api\/files\//);
    expect(built.handles.instagram).toBe('@mockbrand');
    expect(built.guide).toContain('Brand: Mock Brand Co');

    // Font files for the brand board preview
    const font = await fetch(`${BASE}/api/fonts/Montserrat?weight=bold`);
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/ttf');
    expect((await fetch(`${BASE}/api/fonts/League%20Spartan`)).headers.get('content-type')).toBe('font/otf');
    expect((await fetch(`${BASE}/api/fonts/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await fetch(`${BASE}/api/fonts/Comic%20Sans`)).status).toBe(404);
    await c.json(`/api/brands/${id}`, 'DELETE');
  });

  it('creates a virtual character and makes identity-locked and motion-copy videos', async () => {
    // Consent is required
    expect((await c.json('/api/characters', 'POST', { name: 'Maya' })).status).toBe(400);
    const created = await c.json('/api/characters', 'POST', {
      name: 'Maya',
      notes: 'fitness creator',
      consent: true,
    });
    expect(created.status).toBe(200);
    const id = created.data.character.id;
    expect((await c.json(`/api/characters/${id}/prepare`, 'POST', {})).status).toBe(400); // no uploads yet
    for (const [name, rgba] of [
      ['turnaround.png', [200, 120, 90, 255]],
      ['face.png', [60, 90, 140, 255]],
    ] as const) {
      expect(
        (
          await c.upload(`/api/characters/${id}/assets`, name, makePng(120, 80, [...rgba]), 'image/png', {
            role: 'auto',
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await c.upload(
          `/api/characters/${id}/assets`,
          'x.svg',
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
          'image/svg+xml',
        )
      ).status,
    ).toBe(415);

    // A character that isn't prepared can't be used yet
    const early = await c.json('/api/projects', 'POST', {
      name: 'Early',
      durationSec: 8,
      details: { source: 'quick', request: 'x' },
    });
    expect(
      (
        await c.json(`/api/projects/${early.data.id}/quick`, 'POST', {
          prompt: 'Maya at the gym',
          characterId: id,
        })
      ).status,
    ).toBe(400);
    await c.json(`/api/projects/${early.data.id}`, 'DELETE');

    expect((await c.json(`/api/characters/${id}/prepare`, 'POST', {})).status).toBe(200);
    expect((await c.json(`/api/characters/${id}/prepare`, 'POST', {})).status).toBe(409);
    const prepared = await until(
      async () => {
        const ch = (await c.json(`/api/characters/${id}`)).data.character;
        if (ch.job?.status === 'failed') throw new Error(ch.job.error);
        return ch.status === 'review' ? ch : null;
      },
      90_000,
      'character references',
    );
    expect(prepared.description).toMatch(/mock description/);
    expect(prepared.references.map((r: any) => r.role).sort()).toEqual(['ref-body', 'ref-face']);
    expect(prepared.uploads.every((u: any) => u.role !== 'auto')).toBe(true);
    const approved = (await c.json(`/api/characters/${id}/approve`, 'POST')).data.character;
    expect(approved.status).toBe('ready');
    expect(approved.references.every((r: any) => r.approved)).toBe(true);
    expect(approved.avatar.url).toMatch(/^\/api\/files\//);
    expect((await c.json('/api/characters')).data.characters.some((ch: any) => ch.id === id)).toBe(true);

    // Identity-locked video from one request
    const p1 = (
      await c.json('/api/projects', 'POST', {
        name: 'Maya gym',
        durationSec: 8,
        details: { source: 'quick', request: 'Maya training at the gym' },
      })
    ).data.id;
    expect(
      (
        await c.json(`/api/projects/${p1}/quick`, 'POST', {
          prompt: 'Maya training at the gym',
          characterId: id,
          look: 'ugc',
        })
      ).status,
    ).toBe(200);
    const done = await until(
      async () => {
        const [i] = (await c.json(`/api/quick?ids=${p1}`)).data.items;
        if (i.job.status === 'failed') throw new Error(i.job.error);
        return i.video && i.job.status === 'completed' ? i : null;
      },
      240_000,
      'character video',
    );
    expect(done.character).toMatchObject({ id, name: 'Maya' });
    expect(done.keyframes.length).toBeGreaterThan(0);
    const b1 = (await c.json(`/api/projects/${p1}`)).data;
    expect(b1.scenes.every((sc: any) => sc.status === 'completed')).toBe(true);

    // Copy movement from a video (motion transfer)
    const clip = Buffer.from(await (await c.raw(b1.scenes[0].clip.url)).arrayBuffer());
    const p2 = (
      await c.json('/api/projects', 'POST', {
        name: 'Maya dance',
        durationSec: 8,
        details: { source: 'quick', request: 'Maya dancing' },
      })
    ).data.id;
    const up = await c.upload(`/api/projects/${p2}/references`, 'dance.mp4', clip, 'video/mp4', {
      usage: 'motion',
    });
    expect(up.data.references.find((r: any) => r.title === 'dance.mp4')).toMatchObject({
      usage: 'motion',
      analysisStatus: 'none',
    });
    expect(
      (
        await c.json(`/api/projects/${p2}/quick`, 'POST', {
          prompt: 'Maya dancing on a neon rooftop',
          characterId: id,
        })
      ).status,
    ).toBe(200);
    await until(
      async () => {
        const [i] = (await c.json(`/api/quick?ids=${p2}`)).data.items;
        if (i.job.status === 'failed') throw new Error(i.job.error);
        return i.video && i.job.status === 'completed' ? i : null;
      },
      240_000,
      'motion video',
    );
    const b2 = (await c.json(`/api/projects/${p2}`)).data;
    expect(b2.scenes).toHaveLength(1);
    const genJob = b2.jobs.find((j: any) => j.type === 'generation');
    expect(genJob.provider).toBe('kling');

    for (const pid of [p1, p2]) await c.json(`/api/projects/${pid}`, 'DELETE');
    expect((await c.json(`/api/characters/${id}`, 'DELETE')).status).toBe(200);
    expect((await c.json(`/api/characters/${id}`)).status).toBe(404);
  });

  it('exposes settings without leaking keys', async () => {
    const s = await c.json('/api/settings');
    expect(s.status).toBe(200);
    expect(s.data.app.mockProviders).toBe(true);
    expect(s.data.worker?.ffmpeg).toMatch(/ffmpeg version/);
    const t = await c.json('/api/settings/test', 'POST', { service: 'openai' });
    expect(t.data.ok).toBe(true);
    const put = await c.json('/api/settings/keys', 'PUT', {
      service: 'runway',
      key: 'key_supersecretvalue1234567890',
    });
    expect(JSON.stringify(put.data)).not.toContain('supersecretvalue');
    expect(put.data.keys.runway).toMatchObject({ configured: true, source: 'settings', masked: 'key…7890' });
    await c.json('/api/settings/keys', 'PUT', { service: 'runway', key: null });
  });

  it('rejects path traversal and unknown files', async () => {
    expect((await c.raw('/api/files/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    expect((await c.raw('/api/files/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('deletes the project', async () => {
    expect((await c.json(`/api/projects/${projectId}`, 'DELETE')).status).toBe(200);
    expect((await c.json(`/api/projects/${projectId}`)).status).toBe(404);
  });
});
