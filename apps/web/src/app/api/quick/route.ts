import { api } from '@/server/api';
import { listQuickItems } from '@/server/quick';

/** History for the Create screen. `?ids=a,b` returns just those videos. */
export const GET = api(async (req) => {
  const ids = (req.nextUrl.searchParams.get('ids') ?? '')
    .split(',')
    .filter((x) => /^[0-9a-f-]{36}$/i.test(x))
    .slice(0, 50);
  return { items: await listQuickItems(ids.length ? { ids } : {}) };
});
