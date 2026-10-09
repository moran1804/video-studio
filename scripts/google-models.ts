/* eslint-disable no-console */
// Prints Google models relevant to video with their supported methods (never prints the key).
import { getApiKey } from '../packages/core/src/settings';
import { getConfig } from '../packages/core/src/config';

const key = await getApiKey('google');
if (!key) throw new Error('No Google key configured');
const res = await fetch(`${getConfig().GOOGLE_API_BASE_URL}/models?pageSize=200`, {
  headers: { 'x-goog-api-key': key },
});
const data = (await res.json()) as {
  models?: {
    name: string;
    displayName?: string;
    supportedGenerationMethods?: string[];
    description?: string;
  }[];
};
for (const m of data.models ?? []) {
  if (!/veo|video|omni/i.test(m.name) && !m.supportedGenerationMethods?.includes('predictLongRunning'))
    continue;
  console.log(
    `${m.name}\n  methods: ${(m.supportedGenerationMethods ?? []).join(', ')}\n  ${m.displayName ?? ''} – ${(m.description ?? '').slice(0, 160)}`,
  );
}
process.exit(0);
