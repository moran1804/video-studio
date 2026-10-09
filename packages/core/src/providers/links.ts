import { safeFetch, readBodyLimited, validatePublicUrl } from '../security/ssrf';

export type LinkPlatform = 'youtube' | 'instagram' | 'tiktok' | 'vimeo' | 'direct' | 'other';

export function detectPlatform(url: URL): LinkPlatform {
  const h = url.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  if (h === 'youtube.com' || h === 'youtu.be' || h.endsWith('.youtube.com')) return 'youtube';
  if (h === 'instagram.com' || h.endsWith('.instagram.com')) return 'instagram';
  if (h === 'tiktok.com' || h.endsWith('.tiktok.com')) return 'tiktok';
  if (h === 'vimeo.com' || h.endsWith('.vimeo.com')) return 'vimeo';
  if (/\.(mp4|mov|webm|m4v|mkv)$/i.test(url.pathname)) return 'direct';
  return 'other';
}

const OEMBED: Partial<Record<LinkPlatform, (u: string) => string>> = {
  youtube: (u) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}`,
  vimeo: (u) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(u)}`,
  tiktok: (u) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(u)}`,
};

export interface LinkMetadata {
  platform: LinkPlatform;
  title?: string;
  author?: string;
  provider?: string;
  thumbnailUrl?: string;
  /** True when the URL itself serves a video file we can download. */
  isDirectMedia: boolean;
  contentType?: string;
  contentLength?: number;
  note?: string;
}

function metaContent(html: string, prop: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  return (re.exec(html)?.[1] ?? re2.exec(html)?.[1])?.replace(/&amp;/g, '&').slice(0, 500);
}

/**
 * Gather public metadata for a reference link without bypassing any access
 * controls. Platform pages only yield oEmbed / OpenGraph information; direct
 * media files are flagged for download.
 */
export async function inspectLink(input: string): Promise<LinkMetadata> {
  const url = validatePublicUrl(input);
  const platform = detectPlatform(url);
  const oembed = OEMBED[platform];
  if (oembed) {
    try {
      const { response } = await safeFetch(oembed(url.toString()), { timeoutMs: 15_000 });
      if (response.ok) {
        const data = JSON.parse((await readBodyLimited(response, 1_000_000)).toString('utf8')) as Record<
          string,
          unknown
        >;
        return {
          platform,
          title: typeof data.title === 'string' ? data.title.slice(0, 300) : undefined,
          author: typeof data.author_name === 'string' ? data.author_name.slice(0, 200) : undefined,
          provider: typeof data.provider_name === 'string' ? data.provider_name : undefined,
          thumbnailUrl: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : undefined,
          isDirectMedia: false,
          note: 'Platform video: only public metadata and thumbnail were retrieved. Upload the video file (if you own it or have permission) for full analysis.',
        };
      }
      await response.body?.cancel().catch(() => undefined);
      return {
        platform,
        isDirectMedia: false,
        note: `The video is not publicly accessible (HTTP ${response.status}). Upload the file instead if you have permission to use it.`,
      };
    } catch {
      return {
        platform,
        isDirectMedia: false,
        note: 'Could not reach the platform. Upload the file instead.',
      };
    }
  }
  if (platform === 'instagram') {
    return {
      platform,
      isDirectMedia: false,
      note: 'Instagram does not provide public access to videos. Upload the video file (if you own it or have permission) for analysis.',
    };
  }
  // Direct link or other web page.
  const { response } = await safeFetch(url.toString(), { timeoutMs: 20_000 });
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const contentLength = Number(response.headers.get('content-length') || 0) || undefined;
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return {
      platform,
      isDirectMedia: false,
      note: `The link returned HTTP ${response.status}. It may require a login; upload the file instead.`,
    };
  }
  if (contentType.startsWith('video/')) {
    await response.body?.cancel().catch(() => undefined);
    return { platform: 'direct', isDirectMedia: true, contentType, contentLength };
  }
  if (contentType === 'text/html') {
    const html = (await readBodyLimited(response, 2_000_000).catch(() => Buffer.alloc(0))).toString('utf8');
    const video = metaContent(html, 'og:video:secure_url') ?? metaContent(html, 'og:video');
    return {
      platform,
      title: metaContent(html, 'og:title') ?? /<title[^>]*>([^<]{1,300})<\/title>/i.exec(html)?.[1]?.trim(),
      thumbnailUrl: metaContent(html, 'og:image'),
      isDirectMedia: false,
      note: video
        ? 'A video was referenced by this page. Only metadata was retrieved; upload the file for full analysis.'
        : 'Web page: only metadata was retrieved.',
    };
  }
  await response.body?.cancel().catch(() => undefined);
  return {
    platform,
    isDirectMedia: false,
    contentType,
    note: `Unsupported content type ${contentType || 'unknown'}.`,
  };
}
