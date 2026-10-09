import { getTts } from '@studio/core/providers/registry';
import { UserFacingError } from '@studio/core/errors';
import { redactError } from '@studio/core/security/redact';
import { api } from '@/server/api';

export const GET = api(async () => {
  try {
    const tts = await getTts();
    return { voices: await tts.listVoices(), provider: tts.id };
  } catch (err) {
    return {
      voices: [],
      provider: null,
      error: err instanceof UserFacingError ? err.message : redactError(err),
    };
  }
});
