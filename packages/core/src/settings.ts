import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { appSettings } from './db/schema';
import { getConfig } from './config';
import { decryptSecret, encryptSecret, maskSecret } from './security/crypto';
import { registerSecret } from './security/redact';

export const API_SERVICES = ['openai', 'google', 'runway', 'kling', 'elevenlabs'] as const;
export type ApiService = (typeof API_SERVICES)[number];

const ENV_KEYS: Record<
  ApiService,
  'OPENAI_API_KEY' | 'GOOGLE_GEMINI_API_KEY' | 'RUNWAY_API_KEY' | 'KLING_API_KEY' | 'ELEVENLABS_API_KEY'
> = {
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GEMINI_API_KEY',
  runway: 'RUNWAY_API_KEY',
  kling: 'KLING_API_KEY',
  elevenlabs: 'ELEVENLABS_API_KEY',
};

export interface StudioDefaults {
  videoProvider: 'google' | 'veo' | 'runway' | 'mock';
  llmModel: string;
  voiceId: string;
  voiceName: string;
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rows = await getDb().select().from(appSettings).where(eq(appSettings.key, key));
  return rows.length ? (rows[0]!.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await getDb()
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

export async function deleteSetting(key: string): Promise<void> {
  await getDb().delete(appSettings).where(eq(appSettings.key, key));
}

const keyCache = new Map<ApiService, { value: string | undefined; at: number }>();

export function clearApiKeyCache(): void {
  keyCache.clear();
}

/** Resolve an API key: environment first, then the encrypted settings store. */
export async function getApiKey(service: ApiService): Promise<string | undefined> {
  const c = getConfig();
  const envVal = c[ENV_KEYS[service]];
  if (envVal) {
    registerSecret(envVal);
    return envVal;
  }
  const cached = keyCache.get(service);
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  let value: string | undefined;
  const stored = await getSetting<string | null>(`apikey:${service}`, null);
  if (stored && c.SESSION_SECRET) {
    try {
      value = decryptSecret(stored, c.SESSION_SECRET);
      registerSecret(value);
    } catch {
      value = undefined; // SESSION_SECRET changed; key must be re-entered
    }
  }
  keyCache.set(service, { value, at: Date.now() });
  return value;
}

export async function setApiKey(service: ApiService, value: string | null): Promise<void> {
  const c = getConfig();
  if (!c.SESSION_SECRET) throw new Error('SESSION_SECRET is required to store API keys');
  if (value) await setSetting(`apikey:${service}`, encryptSecret(value.trim(), c.SESSION_SECRET));
  else await deleteSetting(`apikey:${service}`);
  keyCache.delete(service);
}

export async function describeApiKeys(): Promise<
  Record<ApiService, { configured: boolean; source: 'env' | 'settings' | null; masked: string | null }>
> {
  const c = getConfig();
  const out = {} as Record<
    ApiService,
    { configured: boolean; source: 'env' | 'settings' | null; masked: string | null }
  >;
  for (const s of API_SERVICES) {
    const envVal = c[ENV_KEYS[s]];
    if (envVal) {
      out[s] = { configured: true, source: 'env', masked: maskSecret(envVal) };
      continue;
    }
    const v = await getApiKey(s);
    out[s] = { configured: Boolean(v), source: v ? 'settings' : null, masked: maskSecret(v) };
  }
  return out;
}

export async function getDefaults(): Promise<StudioDefaults> {
  const c = getConfig();
  const stored = await getSetting<Partial<StudioDefaults>>('defaults', {});
  return {
    videoProvider: stored.videoProvider ?? (c.MOCK_PROVIDERS ? 'mock' : c.DEFAULT_VIDEO_PROVIDER),
    llmModel: stored.llmModel || c.OPENAI_MODEL,
    voiceId: stored.voiceId || c.ELEVENLABS_VOICE_ID || '',
    voiceName: stored.voiceName || '',
  };
}

export async function setDefaults(patch: Partial<StudioDefaults>): Promise<StudioDefaults> {
  const current = await getSetting<Partial<StudioDefaults>>('defaults', {});
  await setSetting('defaults', { ...current, ...patch });
  return getDefaults();
}
