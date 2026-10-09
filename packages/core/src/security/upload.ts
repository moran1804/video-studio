import { fileTypeFromBuffer } from 'file-type';

/**
 * Upload validation. MIME types are determined from file contents (magic
 * bytes) – the browser-provided content type and extension are not trusted.
 */
export type UploadClass = 'image' | 'video' | 'audio' | 'document' | 'pdf';

const ALLOWED: Record<UploadClass, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-m4v'],
  audio: [
    'audio/mpeg',
    'audio/wav',
    'audio/x-wav',
    'audio/vnd.wave',
    'audio/aac',
    'audio/x-m4a',
    'audio/mp4',
    'audio/ogg',
    'audio/opus',
    'audio/flac',
    'audio/x-flac',
    'audio/webm',
  ],
  document: ['text/plain', 'text/markdown'],
  pdf: ['application/pdf'],
};

const TEXT_EXTENSIONS: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
};

export interface SniffResult {
  mime: string;
  ext: string;
  cls: UploadClass;
}

function looksLikeUtf8Text(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    // The sample may end in the middle of a multi-byte character.
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.max(0, buf.length - 4)));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Identify a file from its first bytes. `head` should contain at least the
 * first 4100 bytes of the file.
 */
export async function sniffFile(head: Buffer, originalName: string): Promise<SniffResult | null> {
  const ft = await fileTypeFromBuffer(head);
  if (ft) {
    let mime = ft.mime as string;
    // MP4 containers holding only audio are reported as video/mp4 by some tools; keep as-is.
    if (mime === 'audio/x-wav') mime = 'audio/wav';
    for (const cls of Object.keys(ALLOWED) as UploadClass[]) {
      if (ALLOWED[cls].includes(mime)) return { mime, ext: `.${ft.ext}`, cls };
    }
    return null;
  }
  const lower = originalName.toLowerCase();
  const ext = Object.keys(TEXT_EXTENSIONS).find((e) => lower.endsWith(e));
  if (ext && looksLikeUtf8Text(head)) {
    return { mime: TEXT_EXTENSIONS[ext]!, ext: ext === '.markdown' ? '.md' : ext, cls: 'document' };
  }
  return null;
}

/** Which upload classes a reference category / asset kind accepts. */
export const CATEGORY_CLASSES: Record<string, UploadClass[]> = {
  image: ['image'],
  logo: ['image'],
  poster: ['image', 'pdf'],
  artwork: ['image', 'pdf'],
  video: ['video'],
  audio: ['audio', 'video'],
  music: ['audio'],
  document: ['document', 'pdf'],
  pdf: ['pdf'],
  // asset kinds
  clip: ['video'],
  voiceover: ['audio'],
  sfx: ['audio'],
  auto: ['image', 'video', 'audio', 'document', 'pdf'],
};

/** Choose a reference category automatically from a sniffed class. */
export function categoryForClass(cls: UploadClass): string {
  switch (cls) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'pdf':
      return 'pdf';
    default:
      return 'document';
  }
}
