import { isUuid } from '@studio/core/security/paths';
import { CharactersPage } from '@/components/CharactersPage';

export default async function Page({ searchParams }: { searchParams: Promise<{ character?: string }> }) {
  const { character } = await searchParams;
  return <CharactersPage key={character ?? 'list'} initialId={isUuid(character) ? character : null} />;
}
