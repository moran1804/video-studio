import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ProviderError } from '../../errors';
import { providerJson, type FetchImpl } from '../http';
import {
  briefSchema,
  storyboardSchema,
  visualAnalysisSchema,
  FONTS,
  PALETTE_ROLES,
  normalizeDesignSystem,
  type Brief,
  type DesignSystem,
  type Storyboard,
  type VisualAnalysis,
} from '../../schemas';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface Transcript {
  text: string;
  words?: TranscriptWord[];
}

export interface BriefContext {
  project: {
    name: string;
    platform: string;
    aspectRatio: string;
    durationSec: number;
    details: Record<string, string>;
  };
  brand?: {
    name: string;
    colors: string[];
    fonts: string[];
    defaultCta: string;
    handles: Record<string, string>;
    /** Full brand design-system guide (see buildBrandGuide). */
    guide?: string;
  } | null;
  references: {
    index: number;
    category: string;
    title: string;
    notes: string;
    summary: string;
    /** 'animate' = the user wants this image itself brought to life. */
    usage?: 'inspiration' | 'animate';
  }[];
}

export interface StoryboardContext extends BriefContext {
  brief: Brief;
  maxSceneSec: number;
  minSceneSec: number;
}

export interface PromptContext {
  brief: Brief | null;
  aspectRatio: string;
  scene: {
    purpose: string;
    durationSec: number;
    visualDescription: string;
    prompt: string;
    camera: string;
    lighting: string;
    onScreenText: string;
    audioDirection: string;
  };
  referenceNotes: string[];
  brandGuide?: string;
  maxChars: number;
}

export interface FrameAnalysisInput {
  frames: Buffer[]; // JPEG
  metrics: Record<string, unknown>;
  userNotes: string;
  transcript?: string;
}

export interface QuickPlanInput {
  request: string;
  platform: string;
  aspectRatio: string;
  clips: { durationSec: number; animatesImage: boolean }[];
  voiceover: boolean;
  /** Short headline overlays burned onto clips; off unless the user asks for them. */
  onScreenText?: boolean;
  wordsPerSecond: number;
  brandGuide?: string;
  /** The virtual character who appears in every clip. */
  character?: { description: string; look: string; motion: boolean };
  attachments: { title: string; usage: 'animate' | 'inspiration'; notes: string }[];
  images: Buffer[];
}

export const quickPlanSchema = z.object({
  title: z.string(),
  clips: z.array(z.object({ prompt: z.string(), voiceoverText: z.string(), onScreenText: z.string() })),
});
export type QuickPlan = z.infer<typeof quickPlanSchema>;

export interface CharacterInput {
  name: string;
  notes: string;
  /** JPEG thumbnails of the uploaded sheets / references, in order. */
  images: Buffer[];
  /** Role chosen for each image ('auto' = classify). */
  imageRoles: string[];
}

export const CHARACTER_CLASSIFY_ROLES = ['sheet', 'face', 'body', 'expression', 'outfit', 'other'] as const;

export interface CharacterResult {
  description: string;
  roles: (typeof CHARACTER_CLASSIFY_ROLES)[number][];
  usage?: LlmUsage;
}

export interface DesignSystemInput {
  brandName: string;
  existing: string; // current brand fields rendered as text
  documents: string; // extracted guideline text
  paletteHints: string[]; // colours measured from the uploaded images
  assets: { role: string; label: string }[];
  images: Buffer[]; // JPEG thumbnails of logos / product / mood images
  /** Role already chosen for each image ('auto' = let the model classify it). */
  imageRoles?: string[];
  /** Free-text notes from the user ("anything else we should know"). */
  notes?: string;
}

/** Image roles the model may assign when classifying uploads. */
export const CLASSIFIABLE_ROLES = [
  'logo-primary',
  'logo-icon',
  'logo-light',
  'logo-dark',
  'product',
  'mood',
  'poster',
  'other',
] as const;

export const brandProfileDraftSchema = z.object({
  name: z.string(),
  defaultCta: z.string(),
  introText: z.string(),
  outroText: z.string(),
  handles: z.object({
    instagram: z.string(),
    tiktok: z.string(),
    youtube: z.string(),
    facebook: z.string(),
    website: z.string(),
  }),
});
export type BrandProfileDraft = z.infer<typeof brandProfileDraftSchema>;

export interface DesignSystemResult {
  designSystem: DesignSystem;
  profile: BrandProfileDraft;
  /** Role per image, in the order the images were sent. */
  assetRoles: (typeof CLASSIFIABLE_ROLES)[number][];
  usage?: LlmUsage;
}

export interface LlmClient {
  readonly id: 'openai' | 'mock';
  readonly model: string;
  generateBrief(ctx: BriefContext): Promise<{ brief: Brief; usage?: LlmUsage }>;
  generateStoryboard(ctx: StoryboardContext): Promise<{ storyboard: Storyboard; usage?: LlmUsage }>;
  improvePrompt(ctx: PromptContext): Promise<{ prompt: string; usage?: LlmUsage }>;
  analyzeFrames(input: FrameAnalysisInput): Promise<{ analysis: VisualAnalysis; usage?: LlmUsage }>;
  generateDesignSystem(input: DesignSystemInput): Promise<DesignSystemResult>;
  planQuickVideo(input: QuickPlanInput): Promise<{ plan: QuickPlan; usage?: LlmUsage }>;
  describeCharacter(input: CharacterInput): Promise<CharacterResult>;
  transcribe(file: string): Promise<Transcript>;
  testConnection(): Promise<{ ok: boolean; message: string }>;
}

// ---------------------------------------------------------------------------
// JSON schema helpers for Structured Outputs (strict mode)
// ---------------------------------------------------------------------------

const UNSUPPORTED_KEYS = [
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'format',
  'default',
];

/** Convert a zod schema into an OpenAI strict-mode compatible JSON schema. */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (UNSUPPORTED_KEYS.includes(k)) continue;
      obj[k] = walk(v);
    }
    if (obj.type === 'object' && obj.properties && typeof obj.properties === 'object') {
      obj.additionalProperties = false;
      obj.required = Object.keys(obj.properties as object);
    }
    return obj;
  };
  return walk(raw) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const ORIGINALITY =
  'References are for inspiration only. Never reproduce copyrighted footage, characters, logos you were not given, lyrics or commercial music. Create an original concept.';

const BRIEF_SYSTEM = `You are a senior creative director for short-form social video (Reels, TikTok, Shorts).
Turn the project information and reference board into a practical creative brief for an AI-generated video.
Write concise, specific, production-ready direction. ${ORIGINALITY}`;

const STORYBOARD_SYSTEM = `You are a storyboard artist and editor for vertical short-form social video.
Create a scene-by-scene storyboard that follows the approved creative brief exactly.
Rules:
- Scene durations must add up to the target duration (±10%).
- Each scene is one continuous AI-generated shot.
- "prompt" is a self-contained text-to-video prompt: subject, action, setting, camera movement, lens, lighting, colour, mood, style. No on-screen text or logos in the prompt (text is added in editing).
- "voiceoverText" is what the narrator says during that scene (keep it speakable in the duration: ~2.5 words per second). Use an empty string when no voiceover.
- "onScreenText" is a short headline overlay (max 6 words) or empty.
- "transition" is how this scene transitions into the NEXT scene.
- "referenceIndexes" lists indexes of reference items relevant to the scene (may be empty).
- References marked ANIMATE are artwork the user wants brought to life (e.g. a poster). Scenes that animate it set "animateReferenceIndex" to its index and describe only motion (camera moves, parallax, light, particles) – never changes to its text or layout. Use at least one such scene per ANIMATE reference. All other scenes use -1.
- The first scene must deliver the opening hook in the first 2 seconds; the last scene delivers the call to action.
${ORIGINALITY}`;

const PROMPT_SYSTEM = `You write excellent prompts for text-to-video models (Google Veo / Gemini, Runway).
Rewrite the scene into one vivid, specific, self-contained prompt describing subject, action, setting, camera movement, framing, lens, lighting, colour grade, mood and style.
Do not include on-screen text, captions, logos or brand names that must be rendered as text. ${ORIGINALITY}`;

/** Loose shape for the model's answer; normalizeDesignSystem() validates and repairs it. */
const designSystemDraftSchema = z.object({
  summary: z.string(),
  palette: z.array(
    z.object({ name: z.string(), hex: z.string(), role: z.enum(PALETTE_ROLES), usage: z.string() }),
  ),
  typography: z.object({
    headingFont: z.enum(FONTS),
    bodyFont: z.enum(FONTS),
    captionFont: z.enum(FONTS),
    notes: z.string(),
  }),
  visualStyle: z.object({
    photography: z.string(),
    lighting: z.string(),
    composition: z.string(),
    colourGrading: z.string(),
    motion: z.string(),
    textures: z.string(),
  }),
  toneOfVoice: z.object({
    description: z.string(),
    keywords: z.array(z.string()),
    examplePhrases: z.array(z.string()),
  }),
  dos: z.array(z.string()),
  donts: z.array(z.string()),
  taglines: z.array(z.string()),
  wordsToAvoid: z.array(z.string()),
  logoUsage: z.string(),
  promptKeywords: z.array(z.string()),
  negativePrompt: z.string(),
  profile: brandProfileDraftSchema,
  assetRoles: z.array(z.object({ image: z.number().int(), role: z.enum(CLASSIFIABLE_ROLES) })),
});

const DESIGN_SYSTEM_SYSTEM = `You are a brand designer creating a practical design system for short-form social video.
From the brand's logos, product and mood images, measured colours, guideline documents and existing notes, produce:
- palette: 3-8 named colours with exact hex codes taken from the logos/images/guidelines (prefer measured colours), a role and when to use each;
- typography: the closest matches from the allowed font list, plus notes on weight/case;
- visualStyle: concrete, filmable direction for photography, lighting, composition, colour grading, camera motion and textures;
- toneOfVoice, dos, donts, taglines (only if evident), wordsToAvoid;
- logoUsage: placement, clear space, which variant on light/dark backgrounds;
- promptKeywords: 5-12 short visual style keywords to append to text-to-video prompts (no brand names, no text/logos);
- negativePrompt: things the video model must avoid for this brand;
- profile: the brand name, a default call to action, short intro and outro card text, and social handles / website. Use only what is visible in the images, documents or notes (e.g. a name in the logo, "@handle" or a URL on a poster); use empty strings for anything not evident. Never invent handles or URLs;
- assetRoles: for every image, its 1-based number and what it is: logo-primary (main logo), logo-icon (symbol/mark only), logo-light (logo for dark backgrounds, i.e. light-coloured), logo-dark (logo for light backgrounds), product, mood (lifestyle/atmosphere photo), poster (poster, flyer or social graphic with text), or other.
Be specific to this brand; never invent facts about products or claims. If information is missing, give sensible, clearly generic defaults.`;

const CHARACTER_SYSTEM = `You write identity descriptions that let image and video models redraw the SAME person every time.
From the character sheets and reference images, write "description": one dense paragraph (60–120 words) covering apparent age range (adults only), gender presentation, face shape, skin tone and texture, eyes (colour, shape), brows, nose, lips, hair (colour, length, texture, style), facial hair, body build and height impression, signature outfit (garments, colours, materials, footwear, accessories) and any distinguishing marks (freckles, tattoos, piercings, scars).
Be concrete and visual; no names, no personality, no story. If images disagree, prefer the clearest front view.
Also classify each image in "roles" as one entry per image (1-based "image" number): sheet (turnaround/multi-view sheet), face (face close-up), body (full body), expression (expression sheet), outfit (clothing reference) or other.`;

const QUICK_SYSTEM = `You turn one request into a short social video made of a few consecutive AI-generated clips.
For each clip write:
- prompt: a vivid, self-contained text-to-video prompt (subject, action, setting, camera move, lighting, mood). Never ask for text, logos, captions or brand names inside the shot. Keep clips visually consistent (same subject, palette and style) so they cut together as one video.
  If a clip animates an attached image, describe only the motion to add (camera push-in, parallax, light, particles, fabric) and say that all text and layout must stay exactly as in the image.
- voiceoverText: the narration spoken over that clip (empty string when no voiceover). Fit about the given words-per-second for the clip length; together the clips read as one natural script ending with the call to action if the request has one.
- onScreenText: an optional very short headline (max 5 words) or empty string.
Return exactly the requested number of clips. title: a short name for the video (max 6 words).
Follow any brand design system provided. Treat attachments marked inspiration as style references only.
When a main character is given, they appear in every clip: refer to them only as "the person" (never a name), describe what they do, where, the camera framing and lighting. Vary shot sizes across clips (close-up, medium, wide) for a natural social-video edit, keep wardrobe and setting continuity, and make it feel like real footage, not an ad. The person never speaks on camera – the narration is a separate voiceover. When the character copies movement from a video, write one clip describing the setting and mood only (the movement comes from the video).`;

const VISION_SYSTEM = `You are a video editor analysing a reference video's style from sampled frames and technical metrics.
Describe the style so a NEW, original video can be inspired by it. Be concrete and brief (1-2 sentences per field).
If something cannot be determined from frames, say "Not visible in sampled frames". ${ORIGINALITY}`;

function describeProject(ctx: BriefContext): string {
  const d = ctx.project.details;
  const lines = [
    `Project: ${ctx.project.name}`,
    `Platform: ${ctx.project.platform}; aspect ratio ${ctx.project.aspectRatio}; target duration ${ctx.project.durationSec}s`,
    `Objective: ${d.objective || '-'}`,
    `Target audience: ${d.audience || '-'}`,
    `Tone and visual style: ${d.tone || '-'}`,
    `Main message: ${d.mainMessage || '-'}`,
    `Call to action: ${d.callToAction || '-'}`,
    `Event details: ${d.eventDetails || '-'}`,
    `Brand information: ${d.brandInfo || '-'}`,
    `Additional context: ${d.additionalContext || '-'}`,
    `Voiceover preference: ${d.voiceoverPreference || '-'}`,
    `Music preference: ${d.musicPreference || '-'}`,
  ];
  if (ctx.brand?.guide) {
    lines.push('', 'Brand design system (follow it closely):', ctx.brand.guide);
  } else if (ctx.brand) {
    lines.push(
      `Brand profile: ${ctx.brand.name}; colours ${ctx.brand.colors.join(', ')}; fonts ${ctx.brand.fonts.join(', ')}; default CTA "${ctx.brand.defaultCta}"; handles ${Object.entries(
        ctx.brand.handles,
      )
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')}`,
    );
  }
  if (ctx.references.length) {
    lines.push('', 'Reference board:');
    for (const r of ctx.references) {
      lines.push(
        `[${r.index}]${r.usage === 'animate' ? ' ANIMATE' : ''} ${r.category} "${r.title}" – user likes: ${r.notes || '(no note)'}\n    analysis: ${r.summary || '(none)'}`,
      );
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// OpenAI implementation (Responses API + Structured Outputs)
// ---------------------------------------------------------------------------

interface ResponsesOutput {
  status?: string;
  incomplete_details?: { reason?: string };
  output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

export interface OpenAIOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  visionModel?: string;
  transcriptionModel: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

export class OpenAIClient implements LlmClient {
  readonly id = 'openai' as const;
  readonly model: string;

  constructor(private readonly opts: OpenAIOptions) {
    this.model = opts.model;
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.opts.apiKey}` };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  /** Call the Responses API with a strict JSON schema and validate the result with zod. */
  async structured<T>(args: {
    name: string;
    schema: z.ZodType<T>;
    system: string;
    user: string;
    images?: Buffer[];
    model?: string;
  }): Promise<{ data: T; usage: LlmUsage }> {
    const content: Record<string, unknown>[] = [{ type: 'input_text', text: args.user }];
    for (const img of args.images ?? []) {
      content.push({
        type: 'input_image',
        image_url: `data:image/jpeg;base64,${img.toString('base64')}`,
        detail: 'low',
      });
    }
    const body = {
      model: args.model ?? this.model,
      input: [
        { role: 'system', content: args.system },
        { role: 'user', content },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: args.name,
          schema: toStrictJsonSchema(args.schema),
          strict: true,
        },
      },
    };
    const res = await providerJson<ResponsesOutput>({
      provider: 'OpenAI',
      url: `${this.opts.baseUrl}/responses`,
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      timeoutMs: this.opts.timeoutMs ?? 180_000,
      fetchImpl: this.opts.fetchImpl,
    });
    const text = OpenAIClient.extractText(res);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderError('OpenAI returned malformed JSON', { provider: 'openai', retryable: true });
    }
    const result = args.schema.safeParse(parsed);
    if (!result.success) {
      throw new ProviderError(
        `OpenAI response failed validation: ${result.error.issues[0]?.message ?? 'invalid'}`,
        {
          provider: 'openai',
          retryable: true,
        },
      );
    }
    return {
      data: result.data,
      usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
    };
  }

  static extractText(res: ResponsesOutput): string {
    if (res.error?.message)
      throw new ProviderError(`OpenAI: ${res.error.message}`, { provider: 'openai', retryable: false });
    for (const item of res.output ?? []) {
      if (item.type !== 'message') continue;
      for (const c of item.content ?? []) {
        if (c.type === 'refusal') {
          throw new ProviderError(`OpenAI refused the request: ${c.refusal ?? ''}`, {
            provider: 'openai',
            retryable: false,
          });
        }
        if (c.type === 'output_text' && c.text) return c.text;
      }
    }
    if (res.status === 'incomplete') {
      throw new ProviderError(`OpenAI response incomplete (${res.incomplete_details?.reason ?? 'unknown'})`, {
        provider: 'openai',
        retryable: true,
      });
    }
    throw new ProviderError('OpenAI returned no text output', { provider: 'openai', retryable: true });
  }

  async generateBrief(ctx: BriefContext) {
    const { data, usage } = await this.structured({
      name: 'creative_brief',
      schema: briefSchema,
      system: BRIEF_SYSTEM,
      user: describeProject(ctx),
    });
    return { brief: data, usage };
  }

  async generateStoryboard(ctx: StoryboardContext) {
    const briefText = Object.entries(ctx.brief)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const { data, usage } = await this.structured({
      name: 'storyboard',
      schema: storyboardSchema,
      system: STORYBOARD_SYSTEM,
      user: `${describeProject(ctx)}\n\nApproved creative brief:\n${briefText}\n\nScene duration must be between ${ctx.minSceneSec} and ${ctx.maxSceneSec} seconds each. Total target: ${ctx.project.durationSec}s.`,
    });
    return { storyboard: data, usage };
  }

  async improvePrompt(ctx: PromptContext) {
    const s = ctx.scene;
    const { data, usage } = await this.structured({
      name: 'video_prompt',
      schema: z.object({ prompt: z.string() }),
      system: PROMPT_SYSTEM,
      user: [
        ctx.brief
          ? `Creative concept: ${ctx.brief.concept}\nVisual direction: ${ctx.brief.visualDirection}\nColour & lighting: ${ctx.brief.colourAndLighting}`
          : '',
        `Aspect ratio: ${ctx.aspectRatio}; shot length ${s.durationSec}s`,
        `Scene purpose: ${s.purpose}`,
        `Visual description: ${s.visualDescription}`,
        `Camera: ${s.camera}`,
        `Lighting: ${s.lighting}`,
        `Audio mood: ${s.audioDirection}`,
        `Current prompt: ${s.prompt}`,
        ctx.referenceNotes.length ? `Reference notes: ${ctx.referenceNotes.join(' | ')}` : '',
        ctx.brandGuide
          ? `Brand design system (follow its visual style; no logos or text in the shot):\n${ctx.brandGuide}`
          : '',
        `Maximum length: ${ctx.maxChars} characters.`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
    return { prompt: data.prompt.slice(0, ctx.maxChars), usage };
  }

  async planQuickVideo(input: QuickPlanInput) {
    const { data, usage } = await this.structured({
      name: 'quick_video_plan',
      schema: quickPlanSchema,
      system: QUICK_SYSTEM,
      user: [
        `Request: ${input.request}`,
        `Platform: ${input.platform}; aspect ratio ${input.aspectRatio}`,
        `Clips (${input.clips.length}): ${input.clips.map((c, i) => `#${i + 1} ${c.durationSec}s${c.animatesImage ? ' – animates the attached image' : ''}`).join('; ')}`,
        input.voiceover
          ? `Voiceover: yes, about ${input.wordsPerSecond} words per second.`
          : 'Voiceover: no (voiceoverText must be empty).',
        input.onScreenText
          ? 'On-screen text: optional short headlines are allowed.'
          : 'On-screen text: none (onScreenText must be empty for every clip).',
        input.attachments.length
          ? `Attachments: ${input.attachments.map((a) => `"${a.title}" (${a.usage}${a.notes ? `: ${a.notes}` : ''})`).join('; ')}`
          : '',
        input.brandGuide ? `Brand design system:\n${input.brandGuide}` : '',
        input.character
          ? `Main character (in every clip): ${input.character.description}\nLook: ${input.character.look}${input.character.motion ? '\nThe character copies the movement of an uploaded video.' : ''}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      images: input.images.slice(0, 4),
    });
    return { plan: normalizeQuickPlan(data, input), usage };
  }

  async describeCharacter(input: CharacterInput) {
    const count = Math.min(input.images.length, 8);
    const { data, usage } = await this.structured({
      name: 'character_identity',
      schema: z.object({
        description: z.string(),
        roles: z.array(z.object({ image: z.number().int(), role: z.enum(CHARACTER_CLASSIFY_ROLES) })),
      }),
      system: CHARACTER_SYSTEM,
      user: [
        `Character name (do not include it in the description): ${input.name}`,
        input.notes ? `Notes from the creator: ${input.notes.slice(0, 2000)}` : '',
        `${count} images follow: ${Array.from(
          { length: count },
          (_, i) =>
            `Image ${i + 1}${input.imageRoles[i] && input.imageRoles[i] !== 'auto' ? ` (marked: ${input.imageRoles[i]})` : ''}`,
        ).join(', ')}.`,
      ]
        .filter(Boolean)
        .join('\n'),
      images: input.images.slice(0, 8),
      model: this.opts.visionModel || this.model,
    });
    const roles = Array.from({ length: count }, () => 'other' as (typeof CHARACTER_CLASSIFY_ROLES)[number]);
    for (const r of data.roles) if (r.image >= 1 && r.image <= count) roles[r.image - 1] = r.role;
    return { description: data.description.trim().slice(0, 2000), roles, usage };
  }

  async generateDesignSystem(input: DesignSystemInput) {
    const { data, usage } = await this.structured({
      name: 'brand_design_system',
      schema: designSystemDraftSchema,
      system: DESIGN_SYSTEM_SYSTEM,
      user: [
        `Brand: ${input.brandName}`,
        input.existing ? `Existing brand notes:\n${input.existing}` : '',
        input.paletteHints.length
          ? `Colours measured from the uploaded images (most common first): ${input.paletteHints.join(', ')}`
          : '',
        input.assets.length
          ? `Uploaded assets: ${input.assets.map((a) => `${a.role}${a.label ? ` "${a.label}"` : ''}`).join('; ')}`
          : '',
        input.documents ? `Brand guideline documents (excerpt):\n${input.documents.slice(0, 12_000)}` : '',
        input.notes ? `Notes from the user: ${input.notes.slice(0, 2000)}` : '',
        input.images.length
          ? `${input.images.length} images follow, in order: ${input.images
              .slice(0, 8)
              .map(
                (_, i) =>
                  `Image ${i + 1}${input.imageRoles?.[i] && input.imageRoles[i] !== 'auto' ? ` (user marked: ${input.imageRoles[i]})` : ''}`,
              )
              .join(', ')}.`
          : 'No images were provided.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      images: input.images.slice(0, 8),
      model: this.opts.visionModel || this.model,
    });
    return {
      designSystem: normalizeDesignSystem(data),
      profile: normalizeBrandProfile(data.profile),
      assetRoles: orderAssetRoles(data.assetRoles, Math.min(input.images.length, 8)),
      usage,
    };
  }

  async analyzeFrames(input: FrameAnalysisInput) {
    const { data, usage } = await this.structured({
      name: 'reference_style',
      schema: visualAnalysisSchema,
      system: VISION_SYSTEM,
      user: [
        `Technical metrics: ${JSON.stringify(input.metrics)}`,
        input.userNotes ? `What the user likes about this reference: ${input.userNotes}` : '',
        input.transcript ? `Transcript excerpt: ${input.transcript.slice(0, 1500)}` : '',
        `${input.frames.length} frames follow in chronological order.`,
      ]
        .filter(Boolean)
        .join('\n'),
      images: input.frames,
      model: this.opts.visionModel || this.model,
    });
    return { analysis: data, usage };
  }

  async transcribe(file: string): Promise<Transcript> {
    const buf = await fs.readFile(file);
    if (buf.length > 25 * 1024 * 1024)
      throw new ProviderError('Audio too large for transcription (25 MB max)', {
        provider: 'openai',
        retryable: false,
      });
    const form = new FormData();
    form.append('file', new Blob([buf]), path.basename(file));
    form.append('model', this.opts.transcriptionModel);
    const wantsWords = this.opts.transcriptionModel.startsWith('whisper');
    if (wantsWords) {
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
    } else {
      form.append('response_format', 'json');
    }
    const res = await providerJson<{ text?: string; words?: TranscriptWord[] }>({
      provider: 'OpenAI transcription',
      url: `${this.opts.baseUrl}/audio/transcriptions`,
      method: 'POST',
      headers: this.headers(false),
      body: form,
      timeoutMs: 300_000,
      retries: 2,
      fetchImpl: this.opts.fetchImpl,
    });
    return { text: (res.text ?? '').trim(), words: res.words };
  }

  async testConnection() {
    const res = await providerJson<{ data?: { id: string }[] }>({
      provider: 'OpenAI',
      url: `${this.opts.baseUrl}/models`,
      headers: this.headers(),
      retries: 0,
      timeoutMs: 15_000,
      fetchImpl: this.opts.fetchImpl,
    });
    const ids = (res.data ?? []).map((m) => m.id);
    const found = ids.includes(this.model);
    return {
      ok: true,
      message: found
        ? `Connected. Model ${this.model} is available.`
        : `Connected, but model "${this.model}" was not listed for this key.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Mock implementation (deterministic, offline)
// ---------------------------------------------------------------------------

export class MockLlmClient implements LlmClient {
  readonly id = 'mock' as const;
  readonly model = 'mock-llm';

  async generateBrief(ctx: BriefContext) {
    const d = ctx.project.details;
    const msg = d.mainMessage || ctx.project.name;
    const refs = ctx.references.filter((r) => r.notes).map((r) => r.notes);
    const brief: Brief = {
      concept: `An energetic ${ctx.project.durationSec}-second ${ctx.project.platform.replace(/_/g, ' ')} video that brings "${msg}" to life for ${d.audience || 'a broad social audience'}.`,
      openingHook: `Open on a striking close-up with bold text: "${msg.split(' ').slice(0, 5).join(' ')}".`,
      narrativeStructure: 'Hook (0-2s) → Problem / tease → Reveal → Proof / highlights → Call to action.',
      visualDirection: `${d.tone || 'Modern, cinematic, high-contrast'} visuals with dynamic handheld movement.${refs.length ? ` Inspired by: ${refs.join('; ')}.` : ''}`,
      colourAndLighting: ctx.brand
        ? `Brand palette ${ctx.brand.colors.join(', ')} with warm key light.`
        : 'Vibrant saturated colours, warm key light, soft rim light.',
      editingPace:
        ctx.project.durationSec <= 20
          ? 'Fast cuts every 1.5–2.5 seconds.'
          : 'Medium-fast cuts every 2–4 seconds.',
      suggestedVoiceover: `${msg}. ${d.callToAction || 'Follow for more.'}`,
      captionStyle: 'Bold, uppercase, word-by-word highlighted captions in the lower third safe zone.',
      musicDirection: d.musicPreference || 'Upbeat electronic track, 120 BPM, builds into the reveal.',
      closingCta: d.callToAction || ctx.brand?.defaultCta || 'Follow for more.',
    };
    return { brief, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async generateStoryboard(ctx: StoryboardContext) {
    const count = Math.max(2, Math.min(8, Math.round(ctx.project.durationSec / 4)));
    const per = Math.max(
      ctx.minSceneSec,
      Math.min(ctx.maxSceneSec, Math.round((ctx.project.durationSec / count) * 2) / 2),
    );
    const purposes = [
      'Opening hook',
      'Build intrigue',
      'Reveal',
      'Highlight',
      'Social proof',
      'Energy peak',
      'Wrap-up',
      'Call to action',
    ];
    const words = ctx.brief.suggestedVoiceover.split(/\s+/).filter(Boolean);
    const chunk = Math.ceil(words.length / count);
    const transitions = ['fade', 'cut', 'slideleft', 'cut', 'zoomin', 'dissolve', 'cut', 'fade'] as const;
    const animate = ctx.references.filter((r) => r.usage === 'animate').map((r) => r.index);
    const scenes = Array.from({ length: count }, (_, i) => {
      const purpose = i === count - 1 ? 'Call to action' : (purposes[i] ?? `Scene ${i + 1}`);
      return {
        purpose,
        durationSec: per,
        visualDescription: `${purpose}: ${ctx.brief.visualDirection}`,
        prompt: `Cinematic vertical shot for "${ctx.project.name}" – ${purpose.toLowerCase()}. ${ctx.brief.colourAndLighting} Smooth camera push-in, shallow depth of field.`,
        camera: i % 2 === 0 ? 'Slow push-in, 35mm' : 'Handheld orbit, 24mm',
        lighting: ctx.brief.colourAndLighting,
        onScreenText:
          i === 0 ? (ctx.brief.openingHook.split('"')[1] ?? '') : i === count - 1 ? ctx.brief.closingCta : '',
        voiceoverText: words.slice(i * chunk, (i + 1) * chunk).join(' '),
        transition: transitions[i % transitions.length]!,
        audioDirection: ctx.brief.musicDirection,
        referenceIndexes: ctx.references.length ? [i % ctx.references.length] : [],
        // Every scene animates the user's artwork when some was provided (cycling through several).
        animateReferenceIndex: animate.length ? animate[i % animate.length]! : -1,
      };
    });
    return { storyboard: { scenes }, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async improvePrompt(ctx: PromptContext) {
    const s = ctx.scene;
    const prompt =
      `${s.visualDescription || s.prompt}. Camera: ${s.camera || 'smooth gimbal move'}. Lighting: ${s.lighting || 'soft cinematic light'}. ${ctx.brief?.colourAndLighting ?? ''} Aspect ${ctx.aspectRatio}, high detail, photorealistic.`
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, ctx.maxChars);
    return { prompt, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async analyzeFrames(input: FrameAnalysisInput) {
    const m = input.metrics as { pace?: string; averageShotLengthSec?: number; palette?: string[] };
    const analysis: VisualAnalysis = {
      summary:
        `Mock analysis of ${input.frames.length} frames. ${input.userNotes ? `User likes: ${input.userNotes}.` : ''}`.trim(),
      cameraMovements: 'Mixed handheld and smooth gimbal moves (mock).',
      framing: 'Centre-weighted medium close-ups (mock).',
      lighting: 'High-key with warm highlights (mock).',
      colourPalette: m.palette?.length ? m.palette.join(', ') : 'Vibrant, saturated (mock).',
      transitions: `Mostly hard cuts; pace ${m.pace ?? 'moderate'} (mock).`,
      captionPlacement: 'Lower third, centred (mock).',
      typographyStyle: 'Bold sans-serif, uppercase (mock).',
      visualEffects: 'Light speed ramps and zooms (mock).',
      musicEnergy: 'Upbeat (mock).',
      openingHook: 'Immediate close-up with text hook (mock).',
      endingAndCta: 'Logo end card with call to action (mock).',
      inspirationNotes: `Average shot ${m.averageShotLengthSec ?? '?'}s – use a similar rhythm with original visuals.`,
    };
    return { analysis, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async generateDesignSystem(input: DesignSystemInput) {
    const hints = input.paletteHints.length ? input.paletteHints : ['#7C3AED', '#111827', '#F59E0B'];
    const roles = ['primary', 'secondary', 'accent', 'background', 'text'] as const;
    const designSystem = normalizeDesignSystem({
      summary: `${input.brandName} – a confident, modern brand (mock design system generated from ${input.assets.length} assets).`,
      palette: hints.slice(0, 5).map((hex, i) => ({
        name: `${input.brandName} ${roles[i] ?? 'other'}`,
        hex,
        role: roles[i] ?? 'other',
        usage: 'Mock usage note',
      })),
      typography: {
        headingFont: 'Montserrat',
        bodyFont: 'Roboto',
        captionFont: 'Montserrat',
        notes: 'Bold uppercase headings (mock).',
      },
      visualStyle: {
        photography: 'Crisp, high-contrast lifestyle photography (mock).',
        lighting: 'Warm key light with coloured rim light (mock).',
        composition: 'Centred subjects, generous negative space for captions (mock).',
        colourGrading: `Graded towards ${hints[0]} (mock).`,
        motion: 'Smooth gimbal pushes and quick whip transitions (mock).',
        textures: 'Clean surfaces, subtle film grain (mock).',
      },
      toneOfVoice: {
        description: 'Upbeat and direct (mock).',
        keywords: ['bold', 'friendly'],
        examplePhrases: [`This is ${input.brandName}.`],
      },
      dos: ['Keep the logo in the top-right safe area'],
      donts: ['Do not distort the logo'],
      taglines: [],
      wordsToAvoid: ['cheap'],
      logoUsage: 'Primary logo on dark footage; keep clear space equal to the logo height (mock).',
      promptKeywords: ['cinematic', 'high contrast', 'vibrant'],
      negativePrompt: 'dull colours, clutter',
    });
    const count = Math.min(input.images.length, 8);
    return {
      designSystem,
      profile: normalizeBrandProfile({
        name: input.brandName && input.brandName !== 'New brand' ? input.brandName : 'Mock Brand Co',
        defaultCta: 'Book now – link in bio',
        introText: '',
        outroText: 'See you there',
        handles: { instagram: '@mockbrand', tiktok: '', youtube: '', facebook: '', website: '' },
      }),
      assetRoles: Array.from({ length: count }, (_, i) => (i === 0 ? 'logo-primary' : 'poster')),
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async describeCharacter(input: CharacterInput) {
    const count = Math.min(input.images.length, 8);
    return {
      description:
        'Adult in their late twenties, oval face, warm medium skin with natural texture, dark brown almond eyes, shoulder-length wavy black hair, slim athletic build, wearing a cropped olive bomber jacket over a white tee, black cargo trousers and white trainers, small gold hoop earrings (mock description).',
      roles: Array.from(
        { length: count },
        (_, i) => (i === 0 ? 'sheet' : 'face') as (typeof CHARACTER_CLASSIFY_ROLES)[number],
      ),
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async planQuickVideo(input: QuickPlanInput) {
    const words = input.request.split(/\s+/).filter(Boolean);
    const plan = {
      title: words.slice(0, 5).join(' ') || 'Quick video',
      clips: input.clips.map((c, i) => ({
        prompt: c.animatesImage
          ? 'Slow cinematic push-in with gentle parallax, keeping all text and layout exactly as in the image.'
          : `Cinematic shot ${i + 1} of ${input.clips.length}: ${input.request}`,
        voiceoverText: input.voiceover
          ? words.slice(0, Math.max(3, Math.round(c.durationSec * input.wordsPerSecond))).join(' ')
          : '',
        onScreenText: i === 0 ? words.slice(0, 3).join(' ') : '',
      })),
    };
    return { plan: normalizeQuickPlan(plan, input), usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async transcribe(): Promise<Transcript> {
    return { text: 'This is a mock transcript of the uploaded audio.' };
  }

  async testConnection() {
    return { ok: true, message: 'Mock language model (MOCK_PROVIDERS=true).' };
  }
}

/** Force the plan to the requested clip count and strip narration when voiceover is off. */
export function normalizeQuickPlan(
  raw: QuickPlan,
  input: Pick<QuickPlanInput, 'clips' | 'voiceover' | 'request' | 'onScreenText'>,
): QuickPlan {
  const clips = input.clips.map((_, i) => {
    const c = raw.clips[i] ??
      raw.clips.at(-1) ?? { prompt: input.request, voiceoverText: '', onScreenText: '' };
    return {
      prompt: (c.prompt.trim() || input.request).slice(0, 3500),
      voiceoverText: input.voiceover ? c.voiceoverText.trim().slice(0, 1000) : '',
      onScreenText: input.onScreenText ? c.onScreenText.trim().slice(0, 80) : '',
    };
  });
  return { title: (raw.title.trim() || input.request).slice(0, 80), clips };
}

/** Trim profile fields; drop handles that are clearly not handles or URLs. */
export function normalizeBrandProfile(p: BrandProfileDraft): BrandProfileDraft {
  const t = (v: string, max: number) => (v ?? '').trim().slice(0, max);
  const handle = (v: string) => {
    const x = t(v, 100);
    return /^@?[A-Za-z0-9._-]{2,60}$/.test(x) ? (x.startsWith('@') ? x : `@${x}`) : '';
  };
  const site = t(p.handles?.website ?? '', 200);
  return {
    name: t(p.name, 120),
    defaultCta: t(p.defaultCta, 200),
    introText: t(p.introText, 200),
    outroText: t(p.outroText, 200),
    handles: {
      instagram: handle(p.handles?.instagram ?? ''),
      tiktok: handle(p.handles?.tiktok ?? ''),
      youtube: t(p.handles?.youtube ?? '', 100),
      facebook: t(p.handles?.facebook ?? '', 100),
      website: /^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(site) ? site : '',
    },
  };
}

/** Turn the model's [{image, role}] list into one role per image (1-based), defaulting to 'other'. */
export function orderAssetRoles(
  list: { image: number; role: (typeof CLASSIFIABLE_ROLES)[number] }[],
  count: number,
): (typeof CLASSIFIABLE_ROLES)[number][] {
  const out = Array.from({ length: count }, () => 'other' as (typeof CLASSIFIABLE_ROLES)[number]);
  for (const r of list ?? []) if (r.image >= 1 && r.image <= count) out[r.image - 1] = r.role;
  return out;
}
