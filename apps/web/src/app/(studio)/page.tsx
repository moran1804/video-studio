import { asc, inArray } from 'drizzle-orm';
import { getDb } from '@studio/core/db';
import { assets, brands } from '@studio/core/db/schema';
import { getDefaults } from '@studio/core/settings';
import { CreatePage } from '@/components/CreatePage';
import { brandDTO } from '@/server/data';
import { listQuickItems } from '@/server/quick';
import { listCharacters } from '@/server/characters';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const db = getDb();
  const [rows, defaults, items, characterList] = await Promise.all([
    db.select().from(brands).orderBy(asc(brands.name)),
    getDefaults(),
    listQuickItems(),
    listCharacters(),
  ]);
  const logoIds = rows.map((b) => b.logoAssetId).filter((x): x is string => Boolean(x));
  const logos = logoIds.length ? await db.select().from(assets).where(inArray(assets.id, logoIds)) : [];
  return (
    <CreatePage
      brands={rows.map((b) =>
        brandDTO(
          b,
          logos.find((l) => l.id === b.logoAssetId),
        ),
      )}
      characters={characterList}
      initial={items}
      defaultProvider={defaults.videoProvider}
    />
  );
}
