import fs from 'node:fs/promises';
import path from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { FONTS } from '@studio/core/schemas';

// Fixed family → file map (never derived from user input beyond this allowlist).
const FILES: Record<(typeof FONTS)[number], { slug: string; ext: 'ttf' | 'otf' }> = {
  Montserrat: { slug: 'montserrat', ext: 'ttf' },
  'League Spartan': { slug: 'league-spartan', ext: 'otf' },
  Roboto: { slug: 'roboto', ext: 'ttf' },
  'Open Sans': { slug: 'open-sans', ext: 'ttf' },
  Lato: { slug: 'lato', ext: 'ttf' },
  'Noto Sans': { slug: 'noto-sans', ext: 'ttf' },
  'DejaVu Sans': { slug: 'dejavu-sans', ext: 'ttf' },
  'Liberation Serif': { slug: 'liberation-serif', ext: 'ttf' },
};

/** Serve the caption/brand font files so previews match the rendered video. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ family: string }> }) {
  const { family } = await params;
  const entry = FILES[decodeURIComponent(family) as (typeof FONTS)[number]];
  if (!entry) return new NextResponse('Not found', { status: 404 });
  const weight = req.nextUrl.searchParams.get('weight') === 'bold' ? 'bold' : 'regular';
  const dir = process.env.FONTS_DIR ?? '/app/fonts';
  try {
    const data = await fs.readFile(path.join(dir, `${entry.slug}-${weight}.${entry.ext}`));
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'content-type': entry.ext === 'otf' ? 'font/otf' : 'font/ttf',
        'cache-control': 'public, max-age=604800, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }
}
