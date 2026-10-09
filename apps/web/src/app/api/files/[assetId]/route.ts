import { api } from '@/server/api';
import { getAssetOr404 } from '@/server/data';
import { serveAsset } from '@/server/files';

/** Authenticated file access (range requests supported for video scrubbing). */
export const GET = api<{ assetId: string }>(async (req, { params }) => {
  const asset = await getAssetOr404(params.assetId);
  return serveAsset(req, asset, req.nextUrl.searchParams.get('download') === '1');
});
