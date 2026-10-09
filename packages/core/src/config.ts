import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return def;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: 'custom', message: `must be a number (got "${v}")` });
        return z.NEVER;
      }
      return n;
    });

export const VIDEO_PROVIDER_IDS = ['google', 'veo', 'runway', 'mock'] as const;
export type VideoProviderId = (typeof VIDEO_PROVIDER_IDS)[number];

const envSchema = z.object({
  APP_NAME: z.string().default('AI Social Video Studio'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  APP_PORT: num(3000),
  ALLOWED_ORIGINS: optionalString,
  TRUST_PROXY: bool(false),
  AUTH_ENABLED: bool(true),
  ADMIN_EMAIL: optionalString,
  ADMIN_PASSWORD: optionalString,
  ADMIN_RESET_PASSWORD: bool(false),
  SESSION_SECRET: optionalString,
  SESSION_TTL_DAYS: num(14),

  DATABASE_URL: optionalString,
  REDIS_URL: optionalString,

  DATA_ROOT: z.string().default('/data'),
  MAX_UPLOAD_MB: num(1000),

  MOCK_PROVIDERS: bool(false),

  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-5'),
  OPENAI_VISION_MODEL: optionalString,
  OPENAI_TRANSCRIPTION_MODEL: z.string().default('gpt-4o-transcribe'),

  GOOGLE_GEMINI_API_KEY: optionalString,
  GOOGLE_API_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),
  GOOGLE_VIDEO_MODEL: optionalString,
  GOOGLE_VEO_MODEL: z.string().default('veo-3.1-generate-preview'),
  GOOGLE_VIDEO_DURATIONS: z.string().default('4,6,8'),
  GOOGLE_VIDEO_RESOLUTION: z.string().default(''),
  /** Image model for character references and keyframes (Nano Banana Pro). */
  GOOGLE_IMAGE_MODEL: z.string().default('gemini-3-pro-image'),

  RUNWAY_API_KEY: optionalString,
  RUNWAY_API_BASE_URL: z.string().url().default('https://api.dev.runwayml.com'),
  RUNWAY_API_VERSION: z.string().default('2024-11-06'),
  RUNWAY_VIDEO_MODEL: z.string().default('gen4.5'),
  RUNWAY_VIDEO_DURATIONS: z.string().default('5,10'),

  /** Kling: an API key, or a legacy "ACCESS_KEY:SECRET_KEY" pair (signed as a JWT). */
  KLING_API_KEY: optionalString,
  KLING_API_BASE_URL: z.string().url().default('https://api-singapore.klingai.com'),
  KLING_MOTION_MODEL: z.string().default('kling-v3.0-motion-control'),
  KLING_MOTION_MODE: z.enum(['std', 'pro']).default('pro'),

  ELEVENLABS_API_KEY: optionalString,
  ELEVENLABS_API_BASE_URL: z.string().url().default('https://api.elevenlabs.io'),
  ELEVENLABS_VOICE_ID: optionalString,
  ELEVENLABS_MODEL: z.string().default('eleven_multilingual_v2'),

  DEFAULT_VIDEO_PROVIDER: z.enum(VIDEO_PROVIDER_IDS).default('google'),

  COST_PER_SECOND_GOOGLE: num(0.15),
  COST_PER_SECOND_VEO: num(0.4),
  COST_PER_SECOND_RUNWAY: num(0.12),
  COST_PER_SECOND_KLING: num(0.18),
  COST_PER_IMAGE: num(0.13),

  WORKER_HEALTH_PORT: num(3001),
  GENERATION_CONCURRENCY: num(3),
  RENDER_CONCURRENCY: num(1),
  FFMPEG_THREADS: num(0),
  GENERATION_POLL_SECONDS: num(10),
  GENERATION_TIMEOUT_MINUTES: num(20),
  HTTP_TIMEOUT_SECONDS: num(60),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NODE_ENV: z.string().default('production'),
});

export type AppConfig = z.infer<typeof envSchema> & {
  secureCookies: boolean;
  allowedOrigins: string[];
  maxUploadBytes: number;
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

let cached: AppConfig | undefined;

export function parseConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`));
  }
  const c = result.data;
  const appOrigin = new URL(c.APP_URL).origin;
  const extra = (c.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s).origin;
      } catch {
        return undefined;
      }
    })
    .filter((s): s is string => Boolean(s));
  return {
    ...c,
    secureCookies: c.APP_URL.startsWith('https://'),
    allowedOrigins: [appOrigin, ...extra],
    maxUploadBytes: Math.max(1, c.MAX_UPLOAD_MB) * 1024 * 1024,
  };
}

export function getConfig(): AppConfig {
  if (!cached) cached = parseConfig();
  return cached;
}

/** Test helper: reset cached configuration. */
export function resetConfigCache(): void {
  cached = undefined;
}

/**
 * Startup validation for the long-running services. Returns human readable
 * problems instead of throwing so each service can print them clearly.
 */
export function validateRuntimeConfig(
  role: 'web' | 'worker' | 'migrate',
  config: AppConfig = getConfig(),
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.DATABASE_URL)
    errors.push('DATABASE_URL is required (e.g. postgres://studio:pass@postgres:5432/studio).');
  if (role !== 'migrate' && !config.REDIS_URL)
    errors.push('REDIS_URL is required (e.g. redis://redis:6379).');
  if (!config.SESSION_SECRET || config.SESSION_SECRET.length < 32) {
    errors.push(
      'SESSION_SECRET must be set to at least 32 random characters. Generate one with: openssl rand -hex 32',
    );
  }
  if (!config.DATA_ROOT.startsWith('/')) errors.push('DATA_ROOT must be an absolute path.');

  if (config.AUTH_ENABLED && role === 'migrate') {
    if (!config.ADMIN_EMAIL)
      warnings.push('ADMIN_EMAIL is not set; an administrator can only be created when it is.');
    if (config.ADMIN_PASSWORD && config.ADMIN_PASSWORD.length < 10) {
      errors.push('ADMIN_PASSWORD must be at least 10 characters.');
    }
  }
  if (!config.AUTH_ENABLED) {
    warnings.push(
      'AUTH_ENABLED=false: anyone who can reach the web port has full access. Use only on a trusted LAN.',
    );
  }
  if (config.MOCK_PROVIDERS)
    warnings.push('MOCK_PROVIDERS=true: all AI providers are simulated; no paid APIs are called.');
  if (!config.MOCK_PROVIDERS) {
    if (!config.OPENAI_API_KEY)
      warnings.push('OPENAI_API_KEY not set in environment (can be added in Settings).');
    if (config.DEFAULT_VIDEO_PROVIDER === 'google' && !config.GOOGLE_VIDEO_MODEL) {
      warnings.push(
        'GOOGLE_VIDEO_MODEL is empty; set it to the Gemini Omni Flash model id to use the default provider.',
      );
    }
  }
  if (config.APP_URL.startsWith('http://') && config.NODE_ENV === 'production' && config.AUTH_ENABLED) {
    warnings.push('APP_URL is http://; session cookies will not be marked Secure. Use your HTTPS proxy URL.');
  }
  return { errors, warnings };
}

export function parseDurations(list: string): number[] {
  return list
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}
