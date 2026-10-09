import { isUuid } from '@studio/core/security/paths';
import { BrandsPage } from '@/components/BrandsPage';

const TABS = ['overview', 'design', 'profile', 'context'] as const;

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string; tab?: string }>;
}) {
  const { brand, tab } = await searchParams;
  // The old "assets" tab is now part of the overview.
  const wanted = tab === 'assets' ? 'overview' : (tab ?? '');
  const initialTab = (TABS as readonly string[]).includes(wanted)
    ? (wanted as (typeof TABS)[number])
    : 'overview';
  return (
    <BrandsPage key={brand ?? 'list'} initialBrandId={isUuid(brand) ? brand : null} initialTab={initialTab} />
  );
}
