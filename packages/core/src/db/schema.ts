import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  AudioSettings,
  BrandingSettings,
  Brief,
  DesignSystem,
  CaptionSettings,
  ProjectDetails,
  ReferenceAnalysis,
  VoiceSettings,
} from '../schemas';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  isAdmin: boolean('is_admin').notNull().default(true),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256 of the cookie token
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const brands = pgTable('brands', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  logoAssetId: uuid('logo_asset_id'),
  primaryColor: text('primary_color').notNull().default('#7C3AED'),
  secondaryColor: text('secondary_color').notNull().default('#111827'),
  accentColor: text('accent_color').notNull().default('#F59E0B'),
  headingFont: text('heading_font').notNull().default('Montserrat'),
  bodyFont: text('body_font').notNull().default('Roboto'),
  introText: text('intro_text').notNull().default(''),
  outroText: text('outro_text').notNull().default(''),
  defaultCta: text('default_cta').notNull().default(''),
  handles: jsonb('handles').$type<Record<string, string>>().notNull().default({}),
  designSystem: jsonb('design_system').$type<DesignSystem | null>(),
  designStatus: text('design_status').notNull().default('none'), // none | generating | draft | approved
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Virtual characters: identity text + reference images used to keep a person consistent. */
export const characters = pgTable('characters', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Precise identity description repeated in every image/video prompt. */
  description: text('description').notNull().default(''),
  notes: text('notes').notNull().default(''),
  status: text('status').notNull().default('none'), // none | preparing | review | ready
  /** User confirmed: fictional adult character, or permission from the person shown. */
  consent: boolean('consent').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  platform: text('platform').notNull().default('instagram_reels'),
  aspectRatio: text('aspect_ratio').notNull().default('9:16'),
  durationSec: integer('duration_sec').notNull().default(30),
  details: jsonb('details').$type<ProjectDetails>().notNull(),
  brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'set null' }),
  defaultProvider: text('default_provider'),
  brief: jsonb('brief').$type<Brief | null>(),
  briefStatus: text('brief_status').notNull().default('none'), // none | generating | draft | approved
  voiceSettings: jsonb('voice_settings').$type<VoiceSettings>().notNull(),
  audioSettings: jsonb('audio_settings').$type<AudioSettings>().notNull(),
  captionSettings: jsonb('caption_settings').$type<CaptionSettings>().notNull(),
  brandingSettings: jsonb('branding_settings').$type<BrandingSettings>().notNull(),
  voiceoverAssetId: uuid('voiceover_asset_id'),
  thumbnailAssetId: uuid('thumbnail_asset_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    brandId: uuid('brand_id').references(() => brands.id, { onDelete: 'cascade' }),
    characterId: uuid('character_id').references(() => characters.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // upload | reference | generated | voiceover | music | sfx | clip | preview | export | thumbnail | frame | srt | logo
    relPath: text('rel_path').notNull(), // relative to DATA_ROOT
    originalName: text('original_name'),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    durationSec: doublePrecision('duration_sec'),
    width: integer('width'),
    height: integer('height'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('assets_project_idx').on(t.projectId)],
);

export const references = pgTable(
  'references',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // upload | link
    category: text('category').notNull(), // image | logo | poster | artwork | video | audio | music | document | pdf | link
    title: text('title').notNull().default(''),
    notes: text('notes').notNull().default(''),
    sourceUrl: text('source_url'),
    platform: text('platform'), // youtube | instagram | tiktok | vimeo | direct | other
    assetId: uuid('asset_id').references(() => assets.id, { onDelete: 'set null' }),
    thumbnailAssetId: uuid('thumbnail_asset_id'),
    analysisStatus: text('analysis_status').notNull().default('none'), // none | queued | running | completed | failed | limited
    usage: text('usage').notNull().default('inspiration'), // inspiration | animate (image used directly as the start frame)
    analysis: jsonb('analysis').$type<ReferenceAnalysis | null>(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('references_project_idx').on(t.projectId)],
);

export const scenes = pgTable(
  'scenes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    purpose: text('purpose').notNull().default(''),
    durationSec: doublePrecision('duration_sec').notNull().default(4),
    visualDescription: text('visual_description').notNull().default(''),
    prompt: text('prompt').notNull().default(''),
    referenceAssetIds: jsonb('reference_asset_ids').$type<string[]>().notNull().default([]),
    camera: text('camera').notNull().default(''),
    lighting: text('lighting').notNull().default(''),
    onScreenText: text('on_screen_text').notNull().default(''),
    voiceoverText: text('voiceover_text').notNull().default(''),
    transition: text('transition').notNull().default('cut'),
    audioDirection: text('audio_direction').notNull().default(''),
    provider: text('provider').notNull().default('google'),
    status: text('status').notNull().default('draft'), // draft | queued | generating | completed | failed | cancelled
    clipAssetId: uuid('clip_asset_id'),
    /** Image animated directly (used as the provider's start frame, text and layout preserved). */
    animateAssetId: uuid('animate_asset_id'),
    /** Characters appearing in this scene (identity locked via their references). */
    characterIds: jsonb('character_ids').$type<string[]>().notNull().default([]),
    /** Photoreal still of the character in this scene, used as the start frame. */
    keyframeAssetId: uuid('keyframe_asset_id'),
    /** Video whose movement the character copies (Kling motion control). */
    motionAssetId: uuid('motion_asset_id'),
    /** Visual look preset for character scenes: ugc | cinematic | studio. */
    look: text('look').notNull().default('ugc'),
    clipSource: text('clip_source'), // generated | uploaded
    thumbnailAssetId: uuid('thumbnail_asset_id'),
    voiceoverAssetId: uuid('voiceover_asset_id'),
    error: text('error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('scenes_project_idx').on(t.projectId, t.position)],
);

export const renders = pgTable(
  'renders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull(), // preview | final
    status: text('status').notNull().default('queued'), // queued | running | completed | failed | cancelled
    progress: doublePrecision('progress').notNull().default(0),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    durationSec: doublePrecision('duration_sec'),
    videoAssetId: uuid('video_asset_id'),
    srtAssetId: uuid('srt_asset_id'),
    thumbnailAssetId: uuid('thumbnail_asset_id'),
    error: text('error'),
    log: text('log'),
    createdAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('renders_project_idx').on(t.projectId)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(), // analysis | brief | storyboard | prompt | generation | voiceover | transcribe | render
    queue: text('queue').notNull(),
    bullJobId: text('bull_job_id'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    sceneId: uuid('scene_id'),
    referenceId: uuid('reference_id'),
    renderId: uuid('render_id'),
    status: text('status').notNull().default('queued'), // queued | running | completed | failed | cancelled
    progress: doublePrecision('progress').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    provider: text('provider'),
    providerJobId: text('provider_job_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    error: text('error'),
    costEstimateUsd: doublePrecision('cost_estimate_usd'),
    usage: jsonb('usage').$type<Record<string, number> | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('jobs_project_idx').on(t.projectId), index('jobs_status_idx').on(t.status)],
);

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: updatedAt(),
});

export type User = typeof users.$inferSelect;
export type Brand = typeof brands.$inferSelect;
export type Character = typeof characters.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Asset = typeof assets.$inferSelect;
export type Reference = typeof references.$inferSelect;
export type Scene = typeof scenes.$inferSelect;
export type Render = typeof renders.$inferSelect;
export type Job = typeof jobs.$inferSelect;
