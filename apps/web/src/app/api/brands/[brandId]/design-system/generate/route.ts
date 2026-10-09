import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { brands, jobs } from '@studio/core/db/schema';
import { enqueueJob } from '@studio/core/queues';
import { getLlm } from '@studio/core/providers/registry';
import { UserFacingError } from '@studio/core/errors';
import { z } from 'zod';
import { api } from '@/server/api';

const bodySchema = z.object({
  mode: z.enum(['create', 'refresh']).default('refresh'),
  notes: z.string().trim().max(2000).default(''),
});
import { getBrandDetail, getBrandOr404 } from '@/server/data';

/** Ask the AI to build a design system from the brand's uploaded assets and notes. */
export const POST = api<{ brandId: string }>(
  async (req, { params }) => {
    const brand = await getBrandOr404(params.brandId);
    // Optional body: { mode: 'create' | 'refresh', notes }. 'create' also infers the profile.
    const text = await req.text();
    let raw: unknown = {};
    try {
      raw = text ? JSON.parse(text) : {};
    } catch {
      throw new UserFacingError('Invalid JSON body');
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) throw new UserFacingError('mode must be "create" or "refresh"');
    const input = parsed.data;
    const db = getDb();
    const [active] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, 'brand'),
          inArray(jobs.status, ['queued', 'running']),
          sql`${jobs.payload}->>'brandId' = ${brand.id}`,
        ),
      );
    if (active) throw new UserFacingError('The design system is already being generated.', 409, 'busy');
    await getLlm(); // fail fast when OpenAI is not configured
    await db
      .update(brands)
      .set({ designStatus: 'generating', updatedAt: new Date() })
      .where(eq(brands.id, brand.id));
    await enqueueJob({ type: 'brand', payload: { brandId: brand.id, mode: input.mode, notes: input.notes } });
    return { brand: await getBrandDetail(brand.id) };
  },
  { rateLimit: { bucket: 'llm', limit: 20, windowSec: 60 } },
);
