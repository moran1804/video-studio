import { getConfig } from '@studio/core/config';
import { getApiKey } from '@studio/core/settings';
import { GoogleVideoProvider } from '@studio/core/providers/video/google';
import { redactError } from '@studio/core/security/redact';
import { api } from '@/server/api';

/** List video-capable Google models available to the configured key. */
export const GET = api(async () => {
  const c = getConfig();
  if (c.MOCK_PROVIDERS) return { google: ['mock-testsrc'], error: null };
  const key = await getApiKey('google');
  if (!key) return { google: [], error: 'Google API key not configured.' };
  try {
    return { google: await GoogleVideoProvider.listVideoModels(key, c.GOOGLE_API_BASE_URL), error: null };
  } catch (err) {
    return { google: [], error: redactError(err) };
  }
});
