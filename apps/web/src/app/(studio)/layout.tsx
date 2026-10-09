import { getConfig } from '@studio/core/config';
import { Shell } from '@/components/Shell';
import { requirePageUser } from '@/server/auth';

export const dynamic = 'force-dynamic';

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  return (
    <Shell email={user.email} authDisabled={Boolean(user.authDisabled)} appName={getConfig().APP_NAME}>
      {children}
    </Shell>
  );
}
