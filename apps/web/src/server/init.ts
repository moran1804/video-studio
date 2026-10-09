import 'server-only';
import { getConfig, validateRuntimeConfig } from '@studio/core/config';
import { getLogger } from '@studio/core/logger';
import { registerSecret } from '@studio/core/security/redact';
import { ensureBaseLayout } from '@studio/core/storage';

const g = globalThis as unknown as { __studioWebInit?: Promise<void> };

/** One-time startup validation for the web process (idempotent). */
export function ensureInit(): Promise<void> {
  if (!g.__studioWebInit) {
    g.__studioWebInit = (async () => {
      process.env.SERVICE_NAME = 'web';
      const log = getLogger('web');
      const config = getConfig();
      const { errors, warnings } = validateRuntimeConfig('web', config);
      warnings.forEach((w) => log.warn(`config: ${w}`));
      if (errors.length) {
        errors.forEach((e) => log.error(`config: ${e}`));
        throw new Error(`Configuration errors: ${errors.join(' ')}`);
      }
      [
        config.OPENAI_API_KEY,
        config.GOOGLE_GEMINI_API_KEY,
        config.RUNWAY_API_KEY,
        config.ELEVENLABS_API_KEY,
        config.SESSION_SECRET,
      ].forEach(registerSecret);
      await ensureBaseLayout();
    })().catch((err) => {
      g.__studioWebInit = undefined;
      throw err;
    });
  }
  return g.__studioWebInit;
}
