import { z } from 'zod';
import { getTts } from '@studio/core/providers/registry';
import { voiceSettingsSchema } from '@studio/core/schemas';
import { api, parseJson } from '@/server/api';

const schema = z.object({
  voiceId: z.string().min(1).max(100),
  settings: voiceSettingsSchema.partial().default({}),
  text: z.string().trim().max(200).optional(),
});

/** Short audible sample of a voice with the chosen settings (not stored). */
export const POST = api(
  async (req) => {
    const input = await parseJson(req, schema);
    const tts = await getTts();
    const settings = voiceSettingsSchema.parse(input.settings);
    const out = await tts.synthesize({
      voiceId: input.voiceId,
      settings,
      text: input.text || 'Hi! This is a quick preview of how your social video voiceover will sound.',
    });
    return new Response(new Uint8Array(out.audio), {
      headers: {
        'content-type': out.mime,
        'cache-control': 'no-store',
        'content-length': String(out.audio.length),
      },
    });
  },
  { rateLimit: { bucket: 'voice-sample', limit: 12, windowSec: 60 } },
);
