import { asc, inArray } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { assets, brands } from '@studio/core/db/schema';
import { getDefaults } from '@studio/core/settings';
import { NewProjectForm } from '@/components/NewProjectForm';
import { brandDTO } from '@/server/data';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage() {
  const db = getDb();
  const [rows, defaults] = await Promise.all([
    db.select().from(brands).orderBy(asc(brands.name)),
    getDefaults(),
  ]);
  const logoIds = rows.map((b) => b.logoAssetId).filter((x): x is string => Boolean(x));
  const logos = logoIds.length ? await db.select().from(assets).where(inArray(assets.id, logoIds)) : [];
  const byId = new Map(logos.map((l) => [l.id, l]));
  return (
    <NewProjectForm
      brands={rows.map((b) => brandDTO(b, b.logoAssetId ? byId.get(b.logoAssetId) : null))}
      defaultProvider={defaults.videoProvider}
    />
  );
}
