import path from 'node:path';
import fs from 'node:fs/promises';

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function assertUuid(value: unknown, what = 'id'): string {
  if (!isUuid(value)) throw new PathSecurityError(`Invalid ${what}`);
  return value.toLowerCase();
}

/**
 * Turn an untrusted filename into something safe to show / use in a
 * Content-Disposition header. Stored files never use this name directly.
 */
export function sanitizeFilename(name: string | undefined | null, fallback = 'file'): string {
  if (!name) return fallback;
  let base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  base = base.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  base = base
    .replace(/[^A-Za-z0-9._ -]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_');
  base = base.replace(/^[.\s_-]+/, '').replace(/[.\s]+$/, '');
  if (base.length > 120) {
    const ext = path.extname(base).slice(0, 12);
    base = base.slice(0, 120 - ext.length) + ext;
  }
  return base || fallback;
}

/** Lower-case extension with a strict allowlist of characters. */
export function safeExtension(name: string | undefined | null): string {
  const ext = path.extname(name ?? '').toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

function checkSegment(seg: string): void {
  if (typeof seg !== 'string' || seg.length === 0) throw new PathSecurityError('Empty path segment');
  if (seg.includes('\0')) throw new PathSecurityError('NUL byte in path');
  if (path.isAbsolute(seg)) throw new PathSecurityError('Absolute path segment not allowed');
  const parts = seg.split(/[\\/]+/);
  if (parts.some((p) => p === '..')) throw new PathSecurityError('Path traversal detected');
}

/**
 * Join untrusted relative segments onto a trusted root and guarantee that the
 * result stays inside the root.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  segments.forEach(checkSegment);
  const full = path.resolve(resolvedRoot, ...segments);
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
    throw new PathSecurityError('Path escapes storage root');
  }
  return full;
}

/** Resolve symlinks and confirm the real location is still inside root. */
export async function assertRealPathInside(root: string, target: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const real = await fs.realpath(target);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new PathSecurityError('Resolved path escapes storage root');
  }
  return real;
}

/** Validate a path we generated ourselves before interpolating it into an FFmpeg filter. */
export function assertFilterSafePath(p: string): string {
  if (!/^[A-Za-z0-9/_.-]+$/.test(p))
    throw new PathSecurityError('Path contains characters unsafe for FFmpeg filters');
  return p;
}
