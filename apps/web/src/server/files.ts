import 'server-only';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import type { Asset } from '@studio/core/db/schema';
import { absPath, dataRoot } from '@studio/core/storage';
import { assertRealPathInside, sanitizeFilename } from '@studio/core/security/paths';
import { NotFoundError } from '@studio/core/errors';

/** Stream a stored asset with HTTP Range support (video scrubbing). */
export async function serveAsset(req: NextRequest, asset: Asset, download: boolean): Promise<Response> {
  const abs = absPath(asset.relPath);
  let real: string;
  try {
    real = await assertRealPathInside(dataRoot(), abs);
  } catch {
    throw new NotFoundError('File');
  }
  const stat = await fsp.stat(real).catch(() => null);
  if (!stat?.isFile()) throw new NotFoundError('File');
  const size = stat.size;
  // Never let browsers render user documents as HTML.
  const mime =
    asset.mime === 'text/markdown'
      ? 'text/plain; charset=utf-8'
      : asset.mime.startsWith('text/')
        ? `${asset.mime}; charset=utf-8`
        : asset.mime;
  const name = sanitizeFilename(asset.originalName, `asset-${asset.id.slice(0, 8)}`);
  const headers: Record<string, string> = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${name.replace(/"/g, '')}"`,
  };
  const range = req.headers.get('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] ? Number(m[1]) : NaN;
      let end = m[2] ? Number(m[2]) : NaN;
      if (Number.isNaN(start)) {
        start = Math.max(0, size - (Number.isNaN(end) ? 0 : end));
        end = size - 1;
      } else if (Number.isNaN(end) || end >= size) end = size - 1;
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      }
      const stream = Readable.toWeb(fs.createReadStream(real, { start, end })) as unknown as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: {
          ...headers,
          'content-range': `bytes ${start}-${end}/${size}`,
          'content-length': String(end - start + 1),
        },
      });
    }
  }
  const stream = Readable.toWeb(fs.createReadStream(real)) as unknown as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...headers, 'content-length': String(size) } });
}
