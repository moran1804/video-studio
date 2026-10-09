import { describe, expect, it } from 'vitest';
import { applyBrandToPrompt, buildBrandGuide } from '../../src/brand';
import {
  BRAND_IMAGERY_ROLES,
  designSystemSchema,
  emptyDesignSystem,
  normalizeDesignSystem,
  paletteColor,
} from '../../src/schemas';
import { OpenAIClient } from '../../src/providers/llm/openai';
import { planBrandUpdates } from '../../src/jobs/brand';
import { json, mockFetch } from './helpers';

const ds = () =>
  normalizeDesignSystem({
    ...emptyDesignSystem(),
    summary: 'Premium outdoor coffee brand',
    palette: [
      { name: 'Forest', hex: '#1f4d3a', role: 'primary', usage: 'backgrounds' },
      { name: 'Ember', hex: '#E86A33', role: 'accent', usage: 'highlights' },
    ],
    typography: {
      headingFont: 'League Spartan',
      bodyFont: 'Lato',
      captionFont: 'Montserrat',
      notes: 'Uppercase headings',
    },
    visualStyle: {
      photography: 'Golden hour outdoor',
      lighting: 'Warm backlight',
      composition: 'Rule of thirds',
      colourGrading: 'Warm teal-orange',
      motion: 'Slow gimbal',
      textures: 'Wood, steam',
    },
    toneOfVoice: {
      description: 'Calm and confident',
      keywords: ['earthy'],
      examplePhrases: ['Brewed outside.'],
    },
    dos: ['Show steam'],
    donts: ['No plastic cups'],
    taglines: ['Brewed outside.'],
    wordsToAvoid: ['cheap'],
    logoUsage: 'Top-right, white on dark',
    promptKeywords: ['golden hour', 'shallow depth of field'],
    negativePrompt: 'plastic cups, neon',
  });

describe('design system normalisation', () => {
  it('repairs and validates AI output', () => {
    const out = normalizeDesignSystem({
      palette: [
        { name: 'White', hex: 'fff', role: 'background', usage: '' },
        { name: 'Dup', hex: '#FFFFFF', role: 'text', usage: '' },
        { name: 'Bad', hex: 'blue', role: 'primary', usage: '' },
        { name: '', hex: '#a1b2c3', role: 'mystery', usage: '' },
      ],
      typography: { headingFont: 'Comic Sans', bodyFont: 'Lato', captionFont: null },
      dos: [' Keep it simple ', 'Keep it simple', '', 42],
      promptKeywords: Array.from({ length: 40 }, (_, i) => `k${i}`),
    });
    expect(out.palette).toEqual([
      { name: 'White', hex: '#FFFFFF', role: 'background', usage: '' },
      { name: '#A1B2C3', hex: '#A1B2C3', role: 'other', usage: '' },
    ]);
    expect(out.typography).toMatchObject({
      headingFont: 'Montserrat',
      bodyFont: 'Lato',
      captionFont: 'Montserrat',
    });
    expect(out.dos).toEqual(['Keep it simple']);
    expect(out.promptKeywords).toHaveLength(20);
    expect(() => designSystemSchema.parse(out)).not.toThrow();
  });

  it('reads palette roles with fallbacks', () => {
    expect(paletteColor(ds(), 'accent', '#000000')).toBe('#E86A33');
    expect(paletteColor(ds(), 'text', '#000000')).toBe('#000000');
    expect(paletteColor(null, 'primary', '#123456')).toBe('#123456');
  });
});

describe('brand guide for the language model', () => {
  it('includes the full design system and the no-logo rule', () => {
    const guide = buildBrandGuide({
      name: 'Trail Coffee',
      defaultCta: 'Order now',
      handles: { instagram: '@trail', tiktok: '' },
      designSystem: ds(),
      assets: [{ role: 'product', label: 'Bag', notes: 'hero product' }],
    });
    expect(guide).toContain('Brand: Trail Coffee');
    expect(guide).toContain('Forest #1F4D3A (primary – backgrounds)');
    expect(guide).toContain('headings League Spartan');
    expect(guide).toContain('Colour grading: Warm teal-orange');
    expect(guide).toContain("Don't: No plastic cups");
    expect(guide).toContain('Never use these words: cheap');
    expect(guide).toContain('Handles: instagram @trail');
    expect(guide).not.toContain('tiktok');
    expect(guide).toContain('product "Bag" (hero product)');
    expect(guide).toMatch(/never ask the video model to draw logos/);
  });

  it('falls back to the basic profile without a design system', () => {
    const guide = buildBrandGuide({
      name: 'Basic',
      colors: { primary: '#111111', secondary: '#222222', accent: '#333333' },
      fonts: { heading: 'Roboto', body: 'Lato' },
    });
    expect(guide).toContain('Palette: primary #111111, secondary #222222, accent #333333');
    expect(guide).toContain('Typography: headings Roboto, body Lato');
  });
});

describe('brand style in video prompts', () => {
  it('appends brand keywords and builds a negative prompt', () => {
    const r = applyBrandToPrompt('A hiker pours coffee at a campsite.', ds(), 1000);
    expect(r.prompt).toMatch(
      /^A hiker pours coffee at a campsite\. Brand style – golden hour, shallow depth of field; colour grade: Warm teal-orange/,
    );
    expect(r.negativePrompt).toContain('plastic cups, neon');
    expect(r.negativePrompt).toContain('logos');
  });

  it('respects the provider prompt limit', () => {
    const long = 'x'.repeat(990);
    expect(applyBrandToPrompt(long, ds(), 1000).prompt.length).toBeLessThanOrEqual(1000);
    expect(applyBrandToPrompt('y'.repeat(1200), ds(), 1000).prompt).toHaveLength(1000);
  });

  it('does not repeat keywords already in the prompt and works without a brand', () => {
    const r = applyBrandToPrompt('Golden hour, shallow depth of field, mountain lake', ds(), 1000);
    expect(r.prompt).toBe('Golden hour, shallow depth of field, mountain lake');
    expect(applyBrandToPrompt('plain', null, 1000)).toEqual({
      prompt: 'plain',
      negativePrompt: expect.stringContaining('watermarks'),
    });
  });
});

describe('OpenAI design system generation', () => {
  it('sends images + measured colours and normalises the answer', async () => {
    const answer = {
      ...ds(),
      palette: [{ name: 'Forest', hex: '#1f4d3a', role: 'primary', usage: 'bg' }],
      profile: {
        name: ' Trail Coffee ',
        defaultCta: 'Order now',
        introText: '',
        outroText: 'Brewed outside',
        handles: {
          instagram: 'trailcoffee',
          tiktok: 'not a handle!',
          youtube: '',
          facebook: '',
          website: 'trail.coffee',
        },
      },
      assetRoles: [
        { image: 2, role: 'poster' },
        { image: 1, role: 'logo-primary' },
        { image: 9, role: 'mood' },
      ],
    };
    const m = mockFetch([
      () =>
        json({
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }],
        }),
    ]);
    const client = new OpenAIClient({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      transcriptionModel: 'x',
      fetchImpl: m.fetch,
    });
    const res = await client.generateDesignSystem({
      brandName: 'Trail',
      existing: 'Brand: Trail',
      documents: 'Use forest green.',
      paletteHints: ['#1F4D3A'],
      assets: [{ role: 'logo-primary', label: 'Logo' }],
      images: [Buffer.from('jpeg'), Buffer.from('jpeg2')],
      imageRoles: ['auto', 'poster'],
      notes: 'Outdoor coffee for hikers',
    });
    expect(res.profile).toEqual({
      name: 'Trail Coffee',
      defaultCta: 'Order now',
      introText: '',
      outroText: 'Brewed outside',
      handles: { instagram: '@trailcoffee', tiktok: '', youtube: '', facebook: '', website: 'trail.coffee' },
    });
    expect(res.assetRoles).toEqual(['logo-primary', 'poster']);
    expect(res.designSystem.palette[0]).toEqual({
      name: 'Forest',
      hex: '#1F4D3A',
      role: 'primary',
      usage: 'bg',
    });
    const body = m.calls[0]!.body as { input: { content: unknown }[]; text: { format: { name: string } } };
    expect(body.text.format.name).toBe('brand_design_system');
    const user = JSON.stringify(body.input[1]!.content);
    expect(user).toContain('#1F4D3A');
    expect(user).toContain('Use forest green.');
    expect(user).toContain('input_image');
    expect(user).toContain('Image 1, Image 2 (user marked: poster)');
    expect(user).toContain('Notes from the user: Outdoor coffee for hikers');
    const schema = JSON.stringify((body.text.format as unknown as { schema: unknown }).schema);
    expect(schema).toContain('assetRoles');
    expect(schema).toContain('profile');
  });
});

describe('applying an AI brand analysis', () => {
  const profile = {
    name: 'Rooftop Sessions',
    defaultCta: 'Tickets in bio',
    introText: '',
    outroText: 'See you up there',
    handles: { instagram: '@rooftop', tiktok: '', youtube: '', facebook: '', website: '' },
  };
  const img = (id: string, role: string) => ({ id, mime: 'image/png', meta: { role } });

  it('sorts "auto" uploads, picks the overlay logo and fills a placeholder profile', () => {
    const r = planBrandUpdates(
      { name: 'New brand', logoAssetId: null, defaultCta: '', introText: '', outroText: '', handles: {} },
      [
        img('a', 'auto'),
        img('b', 'auto'),
        img('c', 'auto'),
        { id: 'd', mime: 'application/pdf', meta: { role: 'auto' } },
        img('e', 'product'),
      ],
      { profile, roles: ['poster', 'logo-light'], imageIds: ['a', 'b'] },
    );
    expect(Object.fromEntries(r.roleUpdates)).toEqual({
      a: 'poster',
      b: 'logo-light',
      c: 'mood',
      d: 'guideline',
    });
    expect(r.logoAssetId).toBe('b');
    expect(r.patch).toEqual({
      name: 'Rooftop Sessions',
      defaultCta: 'Tickets in bio',
      outroText: 'See you up there',
      handles: { instagram: '@rooftop' },
    });
  });

  it('never overwrites what the user set', () => {
    const r = planBrandUpdates(
      {
        name: 'My Brand',
        logoAssetId: 'x',
        defaultCta: 'Mine',
        introText: '',
        outroText: 'Mine too',
        handles: { instagram: '@mine' },
      },
      [img('a', 'logo-primary'), img('x', 'logo-icon')],
      { profile, roles: ['poster'], imageIds: ['a'] },
    );
    expect(r.roleUpdates.size).toBe(0);
    expect(r.logoAssetId).toBe('x');
    expect(r.patch).toEqual({});
  });

  it('prefers a primary logo, then any logo variant', () => {
    const base = { name: 'B', logoAssetId: null, defaultCta: '', introText: '', outroText: '', handles: {} };
    const empty = { profile: { ...profile, name: '' }, roles: [], imageIds: [] };
    expect(
      planBrandUpdates(base, [img('m', 'mood'), img('i', 'logo-icon'), img('p', 'logo-primary')], empty)
        .logoAssetId,
    ).toBe('p');
    expect(planBrandUpdates(base, [img('m', 'mood'), img('i', 'logo-icon')], empty).logoAssetId).toBe('i');
    expect(planBrandUpdates(base, [img('m', 'poster')], empty).logoAssetId).toBeNull();
  });

  it('keeps posters out of fallback reference imagery', () => {
    expect(BRAND_IMAGERY_ROLES).not.toContain('poster');
  });
});
