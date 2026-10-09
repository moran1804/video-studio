import { z } from 'zod';
import { getImageProvider, getLlm, getTts, getVideoProvider } from '@studio/core/providers/registry';
import { redactError } from '@studio/core/security/redact';
import { api, parseJson } from '@/server/api';

const schema = z.object({
  service: z.enum(['openai', 'google', 'veo', 'runway', 'kling', 'image', 'elevenlabs']),
});

/** Live connection test for one provider. */
export const POST = api(
  async (req) => {
    const { service } = await parseJson(req, schema);
    const started = Date.now();
    try {
      let result: { ok: boolean; message: string };
      if (service === 'openai') result = await (await getLlm()).testConnection();
      else if (service === 'elevenlabs') result = await (await getTts()).testConnection();
      else if (service === 'image') {
        const img = await getImageProvider();
        result = img.testConnection ? await img.testConnection() : { ok: true, message: 'Configured.' };
      } else {
        const p = await getVideoProvider(service);
        result = p.testConnection ? await p.testConnection() : { ok: true, message: 'Configured.' };
      }
      return { ...result, ms: Date.now() - started };
    } catch (err) {
      return { ok: false, message: redactError(err), ms: Date.now() - started };
    }
  },
  { rateLimit: { bucket: 'test', limit: 20, windowSec: 60 } },
);
