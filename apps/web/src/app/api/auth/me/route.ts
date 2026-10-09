import { api } from '@/server/api';

export const GET = api(async (_req, { user }) => ({ user }));
