import { z } from 'zod';
import { API_SERVICES, describeApiKeys, setApiKey } from '@studio/core/settings';
import { registerSecret } from '@studio/core/security/redact';
import { api, parseJson } from '@/server/api';

const schema = z.object({
  service: z.enum(API_SERVICES),
  key: z.string().trim().min(8).max(500).nullable(),
});

/** Store (encrypted) or remove an API key. Keys are never returned to the browser. */
export const PUT = api(
  async (req) => {
    const { service, key } = await parseJson(req, schema);
    if (key) registerSecret(key);
    await setApiKey(service, key);
    return { keys: await describeApiKeys() };
  },
  { rateLimit: { bucket: 'keys', limit: 20, windowSec: 60 } },
);
