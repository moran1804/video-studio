import fs from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { assets, characters, type Asset, type Character } from '../db/schema';
import { UserFacingError } from '../errors';
import { getImageProvider, getLlm } from '../providers/registry';
import type { ImageAspectRatio } from '../providers/image/types';
import type { ReferenceImage } from '../providers/video/types';
import { isUuid } from '../security/paths';
import {
  absPath,
  deleteRel,
  makeTempDir,
  newCharacterFileRel,
  removeTempDir,
  writeFileRel,
} from '../storage';
import { makeThumbnail, prepareReferenceImage } from '../ffmpeg/analyze';
import { CHARACTER_REF_ROLES, lookPrompt, type CharacterRefRole } from '../schemas';
import { createAsset } from './context';
import type { FailureHook, JobHandler } from './context';

export const isRefAsset = (a: Pick<Asset, 'kind'>) => a.kind === 'character_ref';
export const assetRole = (a: Pick<Asset, 'meta'>) => String(a.meta?.role ?? 'other');

/** Uploads first in this order when choosing which images the models see. */
const UPLOAD_ORDER = ['face', 'sheet', 'body', 'expression', 'outfit', 'other', 'auto'];
const REF_ASPECT: Record<CharacterRefRole, ImageAspectRatio> = { 'ref-face': '4:5', 'ref-body': '9:16' };
const extFor = (mime: string) => (mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg');

async function loadCharacter(id: string) {
  const db = getDb();
  const [character] = await db.select().from(characters).where(eq(characters.id, id));
  if (!character) return null;
  const list = await db.select().from(assets).where(eq(assets.characterId, id));
  return { character, assets: list };
}

/** JPEG thumbnails of the uploads, best views first (max 6). */
async function uploadThumbs(list: Asset[], tempDir: string, size = 1024) {
  const uploads = list
    .filter((a) => !isRefAsset(a) && a.mime.startsWith('image/'))
    .sort((a, b) => UPLOAD_ORDER.indexOf(assetRole(a)) - UPLOAD_ORDER.indexOf(assetRole(b)))
    .slice(0, 6);
  const out: { asset: Asset; file: string }[] = [];
  for (const a of uploads) {
    const file = path.join(tempDir, `${a.id}.jpg`);
    try {
      await makeThumbnail(absPath(a.relPath), file, 0, size);
      out.push({ asset: a, file });
    } catch {
      /* unreadable image: skip */
    }
  }
  return out;
}

const read = async (file: string): Promise<ReferenceImage> => ({
  data: await fs.readFile(file),
  mimeType: 'image/jpeg',
});

/** Prompt for a clean single-view reference of the character. */
export function referencePrompt(role: CharacterRefRole, description: string): string {
  const view = CHARACTER_REF_ROLES.find((r) => r.id === role)!.prompt;
  return [
    `Create a photorealistic photograph of the exact person shown in the reference images: ${view}.`,
    `Identity: ${description}`,
    'Keep the face, hairstyle, skin tone, body proportions and outfit exactly as in the references.',
    'Plain light-grey seamless background, soft natural daylight, sharp focus, true-to-life skin texture, shot on a full-frame camera with a 50mm lens.',
    'One person only. No text, no logos, no watermark, no other people.',
  ].join(' ');
}

/** Generate (or replace) one clean reference image for a character. */
async function generateReference(
  character: Character,
  role: CharacterRefRole,
  refs: ReferenceImage[],
  existing: Asset[],
) {
  const image = await getImageProvider();
  const result = await image.generateImage({
    prompt: referencePrompt(role, character.description || character.name),
    references: refs,
    aspectRatio: REF_ASPECT[role],
  });
  const rel = newCharacterFileRel(character.id, extFor(result.mimeType));
  await writeFileRel(rel, result.data);
  const asset = await createAsset({
    characterId: character.id,
    kind: 'character_ref',
    relPath: rel,
    mime: result.mimeType,
    meta: { role, approved: false, model: image.model },
  });
  for (const old of existing.filter((a) => isRefAsset(a) && assetRole(a) === role)) {
    await getDb().delete(assets).where(eq(assets.id, old.id));
    await deleteRel(old.relPath);
  }
  return asset;
}

/**
 * `prepare`: describe the character, sort "auto" uploads and generate clean
 * face / full-body references. `ref`: regenerate one reference.
 */
export const characterJob: JobHandler = async (ctx) => {
  const payload = ctx.job.payload as {
    characterId?: string;
    mode?: string;
    role?: string;
    scene?: string;
    look?: string;
    aspectRatio?: ImageAspectRatio;
  };
  if (!isUuid(payload.characterId)) throw new UserFacingError('Job has no character');
  const loaded = await loadCharacter(payload.characterId);
  if (!loaded) throw new UserFacingError('Character no longer exists');
  let { character } = loaded;
  const db = getDb();
  const tempDir = await makeTempDir('character');
  try {
    if (payload.mode === 'test') {
      // A still of the character in a scene, to check the likeness before making videos.
      const context = await loadCharacterContext([character.id], tempDir, 3);
      if (!context?.references.length) throw new UserFacingError('Prepare the character references first.');
      const still = await generateKeyframe({
        scene: (payload.scene || 'walking down a city street on a sunny afternoon').slice(0, 500),
        context,
        look: payload.look ?? 'ugc',
        aspectRatio: payload.aspectRatio ?? '9:16',
      });
      const rel = newCharacterFileRel(character.id, extFor(still.mimeType));
      await writeFileRel(rel, still.data);
      const asset = await createAsset({
        characterId: character.id,
        kind: 'character_test',
        relPath: rel,
        mime: still.mimeType,
        meta: { scene: payload.scene ?? '', look: payload.look ?? 'ugc' },
      });
      return { testShot: asset.id };
    }
    const thumbs = await uploadThumbs(loaded.assets, tempDir);
    if (!thumbs.length) throw new UserFacingError('Upload at least one image of the character first.');
    const refs = await Promise.all(thumbs.map((t) => read(t.file)));

    if (payload.mode !== 'ref') {
      const llm = await getLlm();
      const res = await llm.describeCharacter({
        name: character.name,
        notes: character.notes,
        images: refs.map((r) => r.data),
        imageRoles: thumbs.map((t) => assetRole(t.asset)),
      });
      for (const [i, t] of thumbs.entries()) {
        if (assetRole(t.asset) === 'auto' && res.roles[i]) {
          await db
            .update(assets)
            .set({ meta: { ...t.asset.meta, role: res.roles[i] } })
            .where(eq(assets.id, t.asset.id));
        }
      }
      // Never overwrite a description the user has edited.
      if (!character.description.trim()) {
        [character] = await db
          .update(characters)
          .set({ description: res.description, updatedAt: new Date() })
          .where(eq(characters.id, character.id))
          .returning();
      }
      if (res.usage)
        await ctx.update({
          usage: { inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens },
        });
      await ctx.setProgress(0.3);
    }

    const roles =
      payload.mode === 'ref' ? CHARACTER_REF_ROLES.filter((r) => r.id === payload.role) : CHARACTER_REF_ROLES;
    if (!roles.length) throw new UserFacingError('Unknown reference type');
    const made: string[] = [];
    for (const [i, r] of roles.entries()) {
      const current = await db.select().from(assets).where(eq(assets.characterId, character.id));
      made.push((await generateReference(character, r.id, refs, current)).id);
      await ctx.setProgress(0.3 + ((i + 1) / roles.length) * 0.7);
    }
    await db
      .update(characters)
      .set({ status: 'review', updatedAt: new Date() })
      .where(eq(characters.id, character.id));
    return { references: made, images: thumbs.length };
  } finally {
    await removeTempDir(tempDir);
  }
};

export const characterFailure: FailureHook = async (job) => {
  const id = (job.payload as { characterId?: string }).characterId;
  if (!isUuid(id)) return;
  const loaded = await loadCharacter(id);
  if (!loaded || loaded.character.status !== 'preparing') return;
  const hasRefs = loaded.assets.some(isRefAsset);
  await getDb()
    .update(characters)
    .set({ status: hasRefs ? 'review' : 'none' })
    .where(eq(characters.id, id));
};

export interface CharacterContext {
  characters: { id: string; name: string; description: string }[];
  /** Clean references (approved first), ready to send to image/video models. */
  references: ReferenceImage[];
}

/** Load characters for a scene: identity text + up to `max` reference images. */
export async function loadCharacterContext(
  ids: string[],
  tempDir: string,
  max = 3,
): Promise<CharacterContext | null> {
  const valid = ids.filter(isUuid);
  if (!valid.length) return null;
  const db = getDb();
  const rows = await db.select().from(characters).where(inArray(characters.id, valid));
  if (!rows.length) return null;
  const refAssets = await db
    .select()
    .from(assets)
    .where(and(inArray(assets.characterId, valid), eq(assets.kind, 'character_ref')));
  const fallback = await db.select().from(assets).where(inArray(assets.characterId, valid));
  const ordered = [
    ...refAssets.filter((a) => a.meta?.approved).sort((a, b) => assetRole(a).localeCompare(assetRole(b))),
    ...refAssets.filter((a) => !a.meta?.approved),
    // No clean references yet: fall back to the uploads themselves.
    ...(refAssets.length ? [] : fallback.filter((a) => a.mime.startsWith('image/'))),
  ].slice(0, max);
  const references: ReferenceImage[] = [];
  for (const a of ordered) {
    const out = path.join(tempDir, `charref-${a.id}.jpg`);
    try {
      await prepareReferenceImage(absPath(a.relPath), out);
      references.push(await read(out));
    } catch {
      /* skip unreadable */
    }
  }
  return {
    characters: rows.map((c) => ({ id: c.id, name: c.name, description: c.description })),
    references,
  };
}

/** Prompt for a photoreal keyframe (start frame) of the character in a scene. */
export function keyframePrompt(scene: string, ctx: CharacterContext, look: string, extra = ''): string {
  const who = ctx.characters.map((c) => c.description || c.name).join(' and ');
  return [
    `A photorealistic still frame from a social video. Scene: ${scene}`,
    `The person is exactly the one in the reference images – ${who}. Same face, hair, body proportions and outfit.`,
    extra,
    `Look: ${lookPrompt(look)}.`,
    'Natural, believable pose and expression mid-action. No text, no captions, no logos, no watermark.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Render a keyframe with the image model and return the image bytes. */
export async function generateKeyframe(args: {
  scene: string;
  context: CharacterContext;
  look: string;
  aspectRatio: ImageAspectRatio;
  extraReferences?: ReferenceImage[];
  extraPrompt?: string;
}) {
  const image = await getImageProvider();
  return image.generateImage({
    prompt: keyframePrompt(args.scene, args.context, args.look, args.extraPrompt),
    references: [...args.context.references, ...(args.extraReferences ?? [])],
    aspectRatio: args.aspectRatio,
  });
}
