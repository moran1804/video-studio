import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfig } from './config';
import { assertUuid, safeJoin } from './security/paths';

export const PROJECT_SUBDIRS = [
  'uploads',
  'references',
  'generated',
  'audio',
  'previews',
  'exports',
] as const;
export type ProjectSubdir = (typeof PROJECT_SUBDIRS)[number];

export function dataRoot(): string {
  return path.resolve(getConfig().DATA_ROOT);
}

export async function ensureBaseLayout(): Promise<void> {
  const root = dataRoot();
  for (const dir of ['projects', 'brands', 'temp']) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
}

export async function ensureProjectDirs(projectId: string): Promise<string> {
  const id = assertUuid(projectId, 'project id');
  const base = safeJoin(dataRoot(), 'projects', id);
  for (const sub of PROJECT_SUBDIRS) await fs.mkdir(path.join(base, sub), { recursive: true });
  return base;
}

/** Relative (to DATA_ROOT) path for a new file inside a project subdirectory. */
export function newProjectFileRel(projectId: string, sub: ProjectSubdir, ext: string): string {
  const id = assertUuid(projectId, 'project id');
  const cleanExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
  return path.posix.join('projects', id, sub, `${crypto.randomUUID()}${cleanExt}`);
}

/** Relative path for a new file belonging to a virtual character. */
export function newCharacterFileRel(characterId: string, ext: string): string {
  const id = assertUuid(characterId, 'character id');
  const cleanExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
  return path.posix.join('characters', id, `${crypto.randomUUID()}${cleanExt}`);
}

export function newBrandFileRel(brandId: string, ext: string): string {
  const id = assertUuid(brandId, 'brand id');
  const cleanExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
  return path.posix.join('brands', id, `${crypto.randomUUID()}${cleanExt}`);
}

/** Absolute path from a stored relative path, with traversal protection. */
export function absPath(relPath: string): string {
  return safeJoin(dataRoot(), relPath);
}

export async function ensureParentDir(abs: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
}

/** Create a unique temp directory under DATA_ROOT/temp. Caller must clean it up. */
export async function makeTempDir(prefix: string): Promise<string> {
  const safePrefix = prefix.replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'job';
  const dir = safeJoin(dataRoot(), 'temp', `${safePrefix}-${crypto.randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function removeTempDir(dir: string): Promise<void> {
  // Only ever remove directories inside DATA_ROOT/temp.
  const tempRoot = path.join(dataRoot(), 'temp') + path.sep;
  if (!path.resolve(dir).startsWith(tempRoot)) return;
  await fs.rm(dir, { recursive: true, force: true });
}

/** Remove stale temp directories (older than maxAgeHours) — used at worker startup. */
export async function cleanStaleTemp(maxAgeHours = 12): Promise<number> {
  const tempRoot = path.join(dataRoot(), 'temp');
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(tempRoot);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeHours * 3600_000;
  for (const e of entries) {
    const p = path.join(tempRoot, e);
    try {
      const st = await fs.stat(p);
      if (st.mtimeMs < cutoff) {
        await fs.rm(p, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}

export async function writeFileRel(relPath: string, data: Buffer | string): Promise<string> {
  const abs = absPath(relPath);
  await ensureParentDir(abs);
  await fs.writeFile(abs, data);
  return abs;
}

export function createWriteStreamRel(relPath: string) {
  const abs = absPath(relPath);
  return { abs, stream: createWriteStream(abs, { flags: 'wx' }) };
}

export async function fileSize(abs: string): Promise<number> {
  const st = await fs.stat(abs);
  return st.size;
}

export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await directorySize(p);
    else if (e.isFile()) {
      try {
        total += (await fs.stat(p)).size;
      } catch {
        /* ignore */
      }
    }
  }
  return total;
}

export async function storageUsage(): Promise<{
  projects: number;
  brands: number;
  temp: number;
  free?: number;
  total?: number;
}> {
  const root = dataRoot();
  const [projects, brands, temp] = await Promise.all([
    directorySize(path.join(root, 'projects')),
    directorySize(path.join(root, 'brands')),
    directorySize(path.join(root, 'temp')),
  ]);
  let free: number | undefined;
  let total: number | undefined;
  try {
    const s = await fs.statfs(root);
    free = s.bavail * s.bsize;
    total = s.blocks * s.bsize;
  } catch {
    /* statfs not available */
  }
  return { projects, brands, temp, free, total };
}

export async function deleteRel(relPath: string): Promise<void> {
  try {
    await fs.rm(absPath(relPath), { force: true });
  } catch {
    /* ignore */
  }
}

export async function deleteProjectDir(projectId: string): Promise<void> {
  const id = assertUuid(projectId, 'project id');
  await fs.rm(safeJoin(dataRoot(), 'projects', id), { recursive: true, force: true });
}
