import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PLATFORMS = [
  { id: 'instagram_reels', label: 'Instagram Reels' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'youtube_shorts', label: 'YouTube Shorts' },
  { id: 'facebook_instagram_promo', label: 'Facebook & Instagram promo' },
  { id: 'landscape_promo', label: 'Landscape promo' },
] as const;
export const PLATFORM_IDS = PLATFORMS.map((p) => p.id) as [string, ...string[]];

export const ASPECT_RATIOS = ['9:16', '1:1', '4:5', '16:9'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** Final export dimensions for each aspect ratio. */
export const RESOLUTIONS: Record<AspectRatio, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '16:9': { width: 1920, height: 1080 },
};

export function previewResolution(ar: AspectRatio): { width: number; height: number } {
  const r = RESOLUTIONS[ar];
  return { width: Math.round(r.width / 2 / 2) * 2, height: Math.round(r.height / 2 / 2) * 2 };
}

export const TRANSITIONS = [
  'cut',
  'fade',
  'fadeblack',
  'dissolve',
  'slideleft',
  'slideup',
  'wipeleft',
  'zoomin',
] as const;
export type Transition = (typeof TRANSITIONS)[number];

export const SCENE_STATUSES = ['draft', 'queued', 'generating', 'completed', 'failed', 'cancelled'] as const;
export type SceneStatus = (typeof SCENE_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const VIDEO_PROVIDERS = ['google', 'veo', 'runway', 'mock'] as const;
export const VIDEO_PROVIDER_LABELS: Record<(typeof VIDEO_PROVIDERS)[number], string> = {
  google: 'Google Gemini Omni Flash',
  veo: 'Google Veo 3.1',
  runway: 'Runway Gen-4.5',
  mock: 'Mock (test pattern)',
};

/** Fonts installed in the worker image (see Dockerfile). */
export const FONTS = [
  'Montserrat',
  'League Spartan',
  'Roboto',
  'Open Sans',
  'Lato',
  'Noto Sans',
  'DejaVu Sans',
  'Liberation Serif',
] as const;

export const REFERENCE_CATEGORIES = [
  'image',
  'logo',
  'poster',
  'artwork',
  'video',
  'audio',
  'music',
  'document',
  'pdf',
  'link',
] as const;
export type ReferenceCategory = (typeof REFERENCE_CATEGORIES)[number];

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #FFFFFF');

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const projectDetailsSchema = z.object({
  objective: z.string().max(2000).default(''),
  audience: z.string().max(2000).default(''),
  tone: z.string().max(2000).default(''),
  mainMessage: z.string().max(2000).default(''),
  callToAction: z.string().max(1000).default(''),
  eventDetails: z.string().max(4000).default(''),
  brandInfo: z.string().max(4000).default(''),
  additionalContext: z.string().max(8000).default(''),
  voiceoverPreference: z.string().max(1000).default(''),
  musicPreference: z.string().max(1000).default(''),
  /** 'quick' for videos made on the Create screen. */
  source: z.string().max(20).optional(),
  /** The original request typed on the Create screen. */
  request: z.string().max(4000).optional(),
});
export type ProjectDetails = z.infer<typeof projectDetailsSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required').max(200),
  platform: z.enum(PLATFORM_IDS).default('instagram_reels'),
  aspectRatio: z.enum(ASPECT_RATIOS).default('9:16'),
  durationSec: z.coerce.number().int().min(5).max(180).default(30),
  details: projectDetailsSchema.default(projectDetailsSchema.parse({})),
  brandId: z.string().uuid().nullable().optional(),
  defaultProvider: z.enum(VIDEO_PROVIDERS).nullable().optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

// ---------------------------------------------------------------------------
// Voice / audio / captions / branding
// ---------------------------------------------------------------------------

export const voiceSettingsSchema = z.object({
  mode: z.enum(['none', 'full', 'per-scene', 'uploaded']).default('per-scene'),
  voiceId: z.string().max(100).default(''),
  voiceName: z.string().max(200).default(''),
  modelId: z.string().max(100).default(''),
  stability: z.number().min(0).max(1).default(0.5),
  similarityBoost: z.number().min(0).max(1).default(0.75),
  style: z.number().min(0).max(1).default(0.2),
  speakerBoost: z.boolean().default(true),
  speed: z.number().min(0.7).max(1.2).default(1),
});
export type VoiceSettings = z.infer<typeof voiceSettingsSchema>;

export const sfxCueSchema = z.object({
  assetId: z.string().uuid(),
  atSec: z.number().min(0).max(600),
  volume: z.number().min(0).max(2).default(1),
});

export const audioSettingsSchema = z.object({
  originalAudio: z.boolean().default(false),
  originalVolume: z.number().min(0).max(2).default(0.6),
  voiceVolume: z.number().min(0).max(2).default(1),
  musicAssetId: z.string().uuid().nullable().default(null),
  musicVolume: z.number().min(0).max(2).default(0.35),
  musicLoop: z.boolean().default(true),
  musicFadeInSec: z.number().min(0).max(10).default(1),
  musicFadeOutSec: z.number().min(0).max(10).default(2),
  ducking: z.boolean().default(true),
  sfx: z.array(sfxCueSchema).max(50).default([]),
});
export type AudioSettings = z.infer<typeof audioSettingsSchema>;

export const SAFE_ZONES = {
  none: { top: 0.04, bottom: 0.06, right: 0.04, left: 0.04 },
  tiktok: { top: 0.1, bottom: 0.22, right: 0.14, left: 0.05 },
  reels: { top: 0.1, bottom: 0.2, right: 0.12, left: 0.05 },
  shorts: { top: 0.1, bottom: 0.18, right: 0.12, left: 0.05 },
} as const;
export type SafeZone = keyof typeof SAFE_ZONES;

export const captionSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  burnIn: z.boolean().default(true),
  source: z.enum(['voiceover', 'script']).default('voiceover'),
  preset: z.enum(['bold-social', 'clean', 'boxed', 'custom']).default('bold-social'),
  font: z.enum(FONTS).default('Montserrat'),
  fontSize: z.number().int().min(24).max(160).default(78),
  textColor: hexColor.default('#FFFFFF'),
  highlightColor: hexColor.default('#FFE600'),
  style: z.enum(['outline', 'box', 'none']).default('outline'),
  outlineColor: hexColor.default('#000000'),
  outlineWidth: z.number().min(0).max(12).default(6),
  boxColor: hexColor.default('#000000'),
  boxOpacity: z.number().min(0).max(1).default(0.6),
  position: z.enum(['bottom', 'center', 'top']).default('bottom'),
  safeZone: z.enum(['none', 'tiktok', 'reels', 'shorts']).default('tiktok'),
  wordHighlight: z.boolean().default(true),
  uppercase: z.boolean().default(true),
  maxWordsPerLine: z.number().int().min(1).max(8).default(3),
  showOnScreenText: z.boolean().default(true),
});
export type CaptionSettings = z.infer<typeof captionSettingsSchema>;

export const CAPTION_PRESETS: Record<'bold-social' | 'clean' | 'boxed', Partial<CaptionSettings>> = {
  'bold-social': {
    font: 'Montserrat',
    fontSize: 78,
    textColor: '#FFFFFF',
    highlightColor: '#FFE600',
    style: 'outline',
    outlineColor: '#000000',
    outlineWidth: 6,
    uppercase: true,
    wordHighlight: true,
    maxWordsPerLine: 3,
  },
  clean: {
    font: 'Roboto',
    fontSize: 60,
    textColor: '#FFFFFF',
    highlightColor: '#7DD3FC',
    style: 'outline',
    outlineColor: '#000000',
    outlineWidth: 3,
    uppercase: false,
    wordHighlight: false,
    maxWordsPerLine: 6,
  },
  boxed: {
    font: 'Open Sans',
    fontSize: 64,
    textColor: '#FFFFFF',
    highlightColor: '#F472B6',
    style: 'box',
    boxColor: '#000000',
    boxOpacity: 0.65,
    uppercase: false,
    wordHighlight: true,
    maxWordsPerLine: 4,
  },
};

export const brandingSettingsSchema = z.object({
  showLogo: z.boolean().default(true),
  logoPosition: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default('top-right'),
  logoScale: z.number().min(0.05).max(0.5).default(0.18),
  logoOpacity: z.number().min(0.1).max(1).default(0.9),
  watermarkText: z.string().max(100).default(''),
  watermarkOpacity: z.number().min(0.05).max(1).default(0.35),
  intro: z.boolean().default(false),
  outro: z.boolean().default(true),
  cardDurationSec: z.number().min(1).max(6).default(2),
});
export type BrandingSettings = z.infer<typeof brandingSettingsSchema>;

export const defaultVoiceSettings = (): VoiceSettings => voiceSettingsSchema.parse({});
export const defaultAudioSettings = (): AudioSettings => audioSettingsSchema.parse({});
export const defaultCaptionSettings = (): CaptionSettings => captionSettingsSchema.parse({});
export const defaultBrandingSettings = (): BrandingSettings => brandingSettingsSchema.parse({});

// ---------------------------------------------------------------------------
// Creative brief (LLM structured output + user editing)
// ---------------------------------------------------------------------------

export const briefSchema = z.object({
  concept: z.string(),
  openingHook: z.string(),
  narrativeStructure: z.string(),
  visualDirection: z.string(),
  colourAndLighting: z.string(),
  editingPace: z.string(),
  suggestedVoiceover: z.string(),
  captionStyle: z.string(),
  musicDirection: z.string(),
  closingCta: z.string(),
});
export type Brief = z.infer<typeof briefSchema>;

export const BRIEF_FIELDS: { key: keyof Brief; label: string }[] = [
  { key: 'concept', label: 'Video concept' },
  { key: 'openingHook', label: 'Opening hook' },
  { key: 'narrativeStructure', label: 'Narrative structure' },
  { key: 'visualDirection', label: 'Visual direction' },
  { key: 'colourAndLighting', label: 'Colour & lighting direction' },
  { key: 'editingPace', label: 'Editing pace' },
  { key: 'suggestedVoiceover', label: 'Suggested voiceover' },
  { key: 'captionStyle', label: 'Suggested caption style' },
  { key: 'musicDirection', label: 'Music direction' },
  { key: 'closingCta', label: 'Closing call to action' },
];

// ---------------------------------------------------------------------------
// Storyboard
// ---------------------------------------------------------------------------

/** Shape returned by the LLM for each scene. */
export const storyboardSceneSchema = z.object({
  purpose: z.string(),
  durationSec: z.number(),
  visualDescription: z.string(),
  prompt: z.string(),
  camera: z.string(),
  lighting: z.string(),
  onScreenText: z.string(),
  voiceoverText: z.string(),
  transition: z.enum(TRANSITIONS),
  audioDirection: z.string(),
  referenceIndexes: z.array(z.number().int()),
  /** Index of an "animate" reference to use as this scene's start frame, or -1. */
  animateReferenceIndex: z.number().int().default(-1),
});
export type StoryboardScene = z.infer<typeof storyboardSceneSchema>;

export const storyboardSchema = z.object({
  scenes: z.array(storyboardSceneSchema),
});
export type Storyboard = z.infer<typeof storyboardSchema>;

/** Editable scene fields (API PATCH). */
export const sceneUpdateSchema = z
  .object({
    purpose: z.string().max(1000),
    durationSec: z.number().min(1).max(30),
    visualDescription: z.string().max(4000),
    prompt: z.string().max(4000),
    referenceAssetIds: z.array(z.string().uuid()).max(10),
    animateAssetId: z.string().uuid().nullable(),
    camera: z.string().max(1000),
    lighting: z.string().max(1000),
    onScreenText: z.string().max(500),
    voiceoverText: z.string().max(2000),
    transition: z.enum(TRANSITIONS),
    audioDirection: z.string().max(1000),
    provider: z.enum(VIDEO_PROVIDERS),
  })
  .partial();
export type SceneUpdate = z.infer<typeof sceneUpdateSchema>;

/**
 * Validate and normalise an LLM storyboard: clamps durations, fixes the total
 * to roughly the requested duration and removes invalid reference indexes.
 */
export function normalizeStoryboard(
  raw: unknown,
  opts: {
    targetDurationSec: number;
    referenceCount: number;
    minSceneSec?: number;
    maxSceneSec?: number;
    /** Indexes of references the user marked "animate this image". */
    animateIndexes?: number[];
  },
): Storyboard {
  const parsed = storyboardSchema.parse(raw);
  const min = opts.minSceneSec ?? 2;
  const max = opts.maxSceneSec ?? 8;
  if (parsed.scenes.length === 0) throw new Error('Storyboard contained no scenes');
  const scenes = parsed.scenes.slice(0, 30).map((s) => ({
    ...s,
    durationSec: Math.min(max, Math.max(min, Math.round(s.durationSec * 2) / 2 || min)),
    referenceIndexes: s.referenceIndexes.filter((i) => i >= 0 && i < opts.referenceCount),
    animateReferenceIndex: (opts.animateIndexes ?? []).includes(s.animateReferenceIndex)
      ? s.animateReferenceIndex
      : -1,
    prompt: s.prompt.trim() || s.visualDescription.trim(),
  }));
  // Scale durations towards the target if the model drifted by more than 20%.
  const total = scenes.reduce((a, s) => a + s.durationSec, 0);
  if (opts.targetDurationSec > 0 && Math.abs(total - opts.targetDurationSec) / opts.targetDurationSec > 0.2) {
    const factor = opts.targetDurationSec / total;
    for (const s of scenes) {
      s.durationSec = Math.min(max, Math.max(min, Math.round(s.durationSec * factor * 2) / 2));
    }
  }
  return { scenes };
}

// ---------------------------------------------------------------------------
// Reference analysis
// ---------------------------------------------------------------------------

export const visualAnalysisSchema = z.object({
  summary: z.string(),
  cameraMovements: z.string(),
  framing: z.string(),
  lighting: z.string(),
  colourPalette: z.string(),
  transitions: z.string(),
  captionPlacement: z.string(),
  typographyStyle: z.string(),
  visualEffects: z.string(),
  musicEnergy: z.string(),
  openingHook: z.string(),
  endingAndCta: z.string(),
  inspirationNotes: z.string(),
});
export type VisualAnalysis = z.infer<typeof visualAnalysisSchema>;

export interface ReferenceAnalysis {
  technical?: {
    durationSec?: number;
    width?: number;
    height?: number;
    aspectRatio?: string;
    fps?: number;
    videoCodec?: string;
    audioCodec?: string;
    hasAudio?: boolean;
  };
  editing?: {
    shotCount: number;
    averageShotLengthSec: number;
    pace: 'slow' | 'moderate' | 'fast' | 'very fast';
    cutTimes: number[];
  };
  palette?: string[];
  audio?: { integratedLufs?: number; loudnessRange?: number; energy?: 'low' | 'medium' | 'high' };
  transcript?: string;
  visual?: VisualAnalysis;
  frames?: string[]; // asset ids
  text?: string; // extracted document text (truncated)
  link?: { title?: string; author?: string; provider?: string; thumbnailUrl?: string; note?: string };
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

export const brandInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  primaryColor: hexColor.default('#7C3AED'),
  secondaryColor: hexColor.default('#111827'),
  accentColor: hexColor.default('#F59E0B'),
  headingFont: z.enum(FONTS).default('Montserrat'),
  bodyFont: z.enum(FONTS).default('Roboto'),
  introText: z.string().max(300).default(''),
  outroText: z.string().max(300).default(''),
  defaultCta: z.string().max(300).default(''),
  handles: z.record(z.string().max(40), z.string().max(100)).default({}),
});
export type BrandInput = z.infer<typeof brandInputSchema>;

// ---------------------------------------------------------------------------
// Brand design system (extends brand profiles; passed to every AI step)
// ---------------------------------------------------------------------------

export const BRAND_ASSET_ROLES = [
  { id: 'logo-primary', label: 'Primary logo' },
  { id: 'logo-icon', label: 'Icon / mark' },
  { id: 'logo-light', label: 'Logo for dark backgrounds' },
  { id: 'logo-dark', label: 'Logo for light backgrounds' },
  { id: 'product', label: 'Product shot' },
  { id: 'mood', label: 'Mood / lifestyle image' },
  { id: 'poster', label: 'Poster / flyer' },
  { id: 'guideline', label: 'Brand guidelines document' },
  { id: 'other', label: 'Other' },
] as const;
export type BrandAssetRole = (typeof BRAND_ASSET_ROLES)[number]['id'];
export const BRAND_ASSET_ROLE_IDS = BRAND_ASSET_ROLES.map((r) => r.id) as [
  BrandAssetRole,
  ...BrandAssetRole[],
];
export const LOGO_ROLES: BrandAssetRole[] = ['logo-primary', 'logo-icon', 'logo-light', 'logo-dark'];
/** Roles whose images may be used as a fallback reference image for video generation. */
export const BRAND_IMAGERY_ROLES: BrandAssetRole[] = ['product', 'mood'];

export const PALETTE_ROLES = ['primary', 'secondary', 'accent', 'background', 'text', 'other'] as const;

const stringList = (max: number, itemMax = 200) => z.array(z.string().trim().max(itemMax)).max(max);

export const designSystemSchema = z.object({
  summary: z.string().max(2000),
  palette: z
    .array(
      z.object({
        name: z.string().max(60),
        hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour such as #FFFFFF'),
        role: z.enum(PALETTE_ROLES),
        usage: z.string().max(300),
      }),
    )
    .max(16),
  typography: z.object({
    headingFont: z.enum(FONTS),
    bodyFont: z.enum(FONTS),
    captionFont: z.enum(FONTS),
    notes: z.string().max(1000),
  }),
  visualStyle: z.object({
    photography: z.string().max(1000),
    lighting: z.string().max(1000),
    composition: z.string().max(1000),
    colourGrading: z.string().max(1000),
    motion: z.string().max(1000),
    textures: z.string().max(1000),
  }),
  toneOfVoice: z.object({
    description: z.string().max(1000),
    keywords: stringList(20, 60),
    examplePhrases: stringList(10, 200),
  }),
  dos: stringList(20),
  donts: stringList(20),
  taglines: stringList(10),
  wordsToAvoid: stringList(40, 60),
  logoUsage: z.string().max(1000),
  promptKeywords: stringList(20, 80),
  negativePrompt: z.string().max(500),
});
export type DesignSystem = z.infer<typeof designSystemSchema>;

export function emptyDesignSystem(): DesignSystem {
  return {
    summary: '',
    palette: [],
    typography: { headingFont: 'Montserrat', bodyFont: 'Roboto', captionFont: 'Montserrat', notes: '' },
    visualStyle: {
      photography: '',
      lighting: '',
      composition: '',
      colourGrading: '',
      motion: '',
      textures: '',
    },
    toneOfVoice: { description: '', keywords: [], examplePhrases: [] },
    dos: [],
    donts: [],
    taglines: [],
    wordsToAvoid: [],
    logoUsage: '',
    promptKeywords: [],
    negativePrompt: '',
  };
}

/**
 * Make an AI-produced design system safe to store: fixes hex casing / short
 * forms, drops invalid swatches, falls back to known fonts and trims lists.
 */
export function normalizeDesignSystem(raw: unknown): DesignSystem {
  const base = emptyDesignSystem();
  const r = (raw ?? {}) as Record<string, unknown>;
  const fonts = FONTS as readonly string[];
  const font = (v: unknown, d: (typeof FONTS)[number]) =>
    typeof v === 'string' && fonts.includes(v) ? (v as (typeof FONTS)[number]) : d;
  const str = (v: unknown, max = 1000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const list = (v: unknown, max: number, itemMax = 200) =>
    Array.isArray(v)
      ? [
          ...new Set(
            v
              .filter((x): x is string => typeof x === 'string')
              .map((x) => x.trim().slice(0, itemMax))
              .filter(Boolean),
          ),
        ].slice(0, max)
      : [];
  const hex = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    let h = v.trim().replace(/^#?/, '#');
    if (/^#[0-9a-f]{3}$/i.test(h)) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
    return /^#[0-9a-f]{6}$/i.test(h) ? h.toUpperCase() : null;
  };
  const typo = (r.typography ?? {}) as Record<string, unknown>;
  const vs = (r.visualStyle ?? {}) as Record<string, unknown>;
  const tone = (r.toneOfVoice ?? {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const palette = (Array.isArray(r.palette) ? r.palette : [])
    .map((p) => {
      const s = (p ?? {}) as Record<string, unknown>;
      const h = hex(s.hex);
      if (!h || seen.has(h)) return null;
      seen.add(h);
      const role = (PALETTE_ROLES as readonly string[]).includes(s.role as string)
        ? (s.role as DesignSystem['palette'][number]['role'])
        : 'other';
      return { name: str(s.name, 60) || h, hex: h, role, usage: str(s.usage, 300) };
    })
    .filter((p): p is DesignSystem['palette'][number] => Boolean(p))
    .slice(0, 16);
  return designSystemSchema.parse({
    summary: str(r.summary, 2000),
    palette,
    typography: {
      headingFont: font(typo.headingFont, base.typography.headingFont),
      bodyFont: font(typo.bodyFont, base.typography.bodyFont),
      captionFont: font(typo.captionFont, base.typography.captionFont),
      notes: str(typo.notes),
    },
    visualStyle: {
      photography: str(vs.photography),
      lighting: str(vs.lighting),
      composition: str(vs.composition),
      colourGrading: str(vs.colourGrading),
      motion: str(vs.motion),
      textures: str(vs.textures),
    },
    toneOfVoice: {
      description: str(tone.description),
      keywords: list(tone.keywords, 20, 60),
      examplePhrases: list(tone.examplePhrases, 10),
    },
    dos: list(r.dos, 20),
    donts: list(r.donts, 20),
    taglines: list(r.taglines, 10),
    wordsToAvoid: list(r.wordsToAvoid, 40, 60),
    logoUsage: str(r.logoUsage),
    promptKeywords: list(r.promptKeywords, 20, 80),
    negativePrompt: str(r.negativePrompt, 500),
  });
}

/** Pick the colour for a palette role, falling back to a default. */
export function paletteColor(
  ds: DesignSystem | null | undefined,
  role: DesignSystem['palette'][number]['role'],
  fallback: string,
): string {
  return ds?.palette.find((p) => p.role === role)?.hex ?? fallback;
}

export const REFERENCE_USAGES = ['inspiration', 'animate', 'motion'] as const;
export type ReferenceUsage = (typeof REFERENCE_USAGES)[number];

/** Default prompt for a scene that animates an uploaded image (poster, flyer, artwork). */
export const ANIMATE_DEFAULT_PROMPT =
  'Bring this artwork to life: slow cinematic push-in with subtle parallax between foreground and background, gentle motion in lights, particles and fabric, keeping every word, logo and the layout exactly as in the original image.';

/** Instructions prepended to prompts when the start frame must be preserved. */
export function animatePrompt(prompt: string): string {
  const rule =
    'Animate the provided image. Keep all text, logos, typography and layout exactly as they are – do not redraw, translate or replace them.';
  return prompt.toLowerCase().includes('animate the provided image') ? prompt : `${rule} ${prompt}`.trim();
}

// ---------------------------------------------------------------------------
// Virtual characters
// ---------------------------------------------------------------------------

export const CHARACTER_UPLOAD_ROLES = [
  { id: 'sheet', label: 'Turnaround / character sheet' },
  { id: 'face', label: 'Face close-up' },
  { id: 'body', label: 'Full body' },
  { id: 'expression', label: 'Expression sheet' },
  { id: 'outfit', label: 'Outfit / wardrobe' },
  { id: 'other', label: 'Other reference' },
] as const;
export const CHARACTER_UPLOAD_ROLE_IDS = CHARACTER_UPLOAD_ROLES.map((r) => r.id) as [string, ...string[]];

/** Clean single-view references generated from the uploads (what the models receive). */
export const CHARACTER_REF_ROLES = [
  {
    id: 'ref-face',
    label: 'Face close-up',
    prompt: 'a head-and-shoulders portrait, facing the camera, neutral expression',
  },
  {
    id: 'ref-body',
    label: 'Full body',
    prompt: 'a full-body shot from head to toe, standing, facing the camera, arms relaxed',
  },
] as const;
export type CharacterRefRole = (typeof CHARACTER_REF_ROLES)[number]['id'];

export const LOOKS = [
  {
    id: 'ugc',
    label: 'Phone UGC (most viral)',
    prompt:
      'Shot on a smartphone, handheld, vertical social video, natural available light, true-to-life colours, realistic skin texture with pores, slight motion and natural imperfections, candid unposed feel',
  },
  {
    id: 'cinematic',
    label: 'Cinematic',
    prompt:
      'Cinematic film look, shallow depth of field, 35mm lens, soft motivated lighting, gentle film grain, realistic skin texture, smooth camera movement',
  },
  {
    id: 'studio',
    label: 'Studio',
    prompt:
      'Clean studio shoot, soft key light, seamless backdrop, crisp focus, realistic skin texture, polished commercial look',
  },
] as const;
export type LookId = (typeof LOOKS)[number]['id'];
export const LOOK_IDS = LOOKS.map((l) => l.id) as [LookId, ...LookId[]];
export const lookPrompt = (id: string) => (LOOKS.find((l) => l.id === id) ?? LOOKS[0]).prompt;

/**
 * Lock a character's identity in a video prompt: the same description is
 * repeated in every clip so face, hair and outfit stay consistent.
 */
export function withIdentity(
  prompt: string,
  characters: { name: string; description: string }[],
  opts: { look?: string; silent?: boolean; refTags?: boolean } = {},
): string {
  const who = characters
    .map(
      (c, i) =>
        `${opts.refTags ? `The person shown in <IMAGE_REF_${i}>` : `The same person in every shot`} – ${c.description || c.name}.`,
    )
    .join(' ');
  const parts = [
    who,
    prompt.trim(),
    opts.look ? lookPrompt(opts.look) + '.' : '',
    'Photorealistic, the person looks exactly like the reference images: same face, hair, body and outfit.',
    'The character reference photos only show what the person looks like – do not copy their plain grey studio backdrop; the setting is the scene described above.',
    'No on-screen text, captions or titles.',
    opts.silent ? 'Nobody speaks; natural ambient sound only.' : '',
  ];
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
