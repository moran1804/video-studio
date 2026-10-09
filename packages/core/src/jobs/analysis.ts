import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { references, type Reference } from '../db/schema';
import { UserFacingError } from '../errors';
import { getConfig } from '../config';
import { getLlmOptional } from '../providers/registry';
import { inspectLink } from '../providers/links';
import { safeFetch, readBodyLimited, UnsafeUrlError } from '../security/ssrf';
import { sniffFile } from '../security/upload';
import {
  absPath,
  makeTempDir,
  newProjectFileRel,
  removeTempDir,
  writeFileRel,
  ensureParentDir,
} from '../storage';
import { aspectRatioLabel, probe } from '../ffmpeg/probe';
import {
  analyzeLoudness,
  detectCuts,
  editingStats,
  extractFrames,
  extractPalette,
  extractSpeechAudio,
  frameTimestamps,
  makeThumbnail,
} from '../ffmpeg/analyze';
import { runProcess } from '../ffmpeg/exec';
import type { ReferenceAnalysis } from '../schemas';
import { createAsset, getAsset, type FailureHook, type JobHandler, type JobContext } from './context';

async function setRef(id: string, patch: Partial<Reference>) {
  await getDb().update(references).set(patch).where(eq(references.id, id));
}

/** Stream a remote file to disk with a hard size cap. */
async function downloadTo(url: string, abs: string, maxBytes: number): Promise<{ mime: string }> {
  const { response } = await safeFetch(url, { timeoutMs: 10 * 60_000 });
  if (!response.ok || !response.body) throw new UnsafeUrlError(`Download failed (HTTP ${response.status}).`);
  const len = Number(response.headers.get('content-length') || 0);
  if (len && len > maxBytes)
    throw new UnsafeUrlError(`Remote file is too large (${Math.round(len / 1e6)} MB).`);
  await ensureParentDir(abs);
  const out = createWriteStream(abs, { flags: 'wx' });
  let total = 0;
  try {
    for await (const chunk of response.body) {
      const b = Buffer.from(chunk as Uint8Array);
      total += b.length;
      if (total > maxBytes) throw new UnsafeUrlError('Remote file exceeds the upload size limit.');
      if (!out.write(b)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
  } catch (err) {
    out.destroy();
    await fs.rm(abs, { force: true });
    throw err;
  }
  await new Promise<void>((resolve, reject) =>
    out.end((err?: Error | null) => (err ? reject(err) : resolve())),
  );
  return { mime: (response.headers.get('content-type') ?? '').split(';')[0]!.trim() };
}

async function analyzeVideoFile(
  ctx: JobContext,
  ref: Reference,
  file: string,
  tempDir: string,
): Promise<ReferenceAnalysis> {
  const analysis: ReferenceAnalysis = { notes: [] };
  const info = await probe(file);
  analysis.technical = {
    durationSec: Math.round(info.durationSec * 100) / 100,
    width: info.video?.width,
    height: info.video?.height,
    aspectRatio: info.video ? aspectRatioLabel(info.video.width, info.video.height) : undefined,
    fps: info.video?.fps,
    videoCodec: info.video?.codec,
    audioCodec: info.audio?.codec,
    hasAudio: Boolean(info.audio),
  };
  if (!info.video) throw new UserFacingError('The file contains no video stream.');
  await ctx.setProgress(0.15);

  const cuts = await detectCuts(file, { maxSec: 180 });
  analysis.editing = editingStats(cuts, Math.min(info.durationSec, 180));
  if (info.durationSec > 180) analysis.notes!.push('Only the first 3 minutes were analysed.');
  await ctx.setProgress(0.35);

  const frames = await extractFrames(
    file,
    frameTimestamps(cuts, Math.min(info.durationSec, 180), 8),
    tempDir,
  );
  analysis.palette = await extractPalette(frames);
  const frameIds: string[] = [];
  for (const f of frames) {
    const rel = newProjectFileRel(ref.projectId, 'references', '.jpg');
    await writeFileRel(rel, await fs.readFile(f));
    frameIds.push(
      (
        await createAsset({
          projectId: ref.projectId,
          kind: 'frame',
          relPath: rel,
          mime: 'image/jpeg',
          meta: { referenceId: ref.id },
        })
      ).id,
    );
  }
  analysis.frames = frameIds;
  if (frameIds[0] && !ref.thumbnailAssetId)
    await setRef(ref.id, { thumbnailAssetId: frameIds[Math.min(1, frameIds.length - 1)]! });
  await ctx.setProgress(0.55);

  const llm = await getLlmOptional();
  if (info.audio) {
    try {
      analysis.audio = await analyzeLoudness(file);
    } catch {
      analysis.notes!.push('Audio loudness could not be measured.');
    }
    if (llm) {
      try {
        const speech = path.join(tempDir, 'speech.mp3');
        await extractSpeechAudio(file, speech);
        const t = await llm.transcribe(speech);
        if (t.text && t.text.split(/\s+/).length >= 3) analysis.transcript = t.text.slice(0, 8000);
      } catch (err) {
        analysis.notes!.push(`Transcription skipped: ${(err as Error).message}`);
      }
    }
  }
  await ctx.setProgress(0.75);

  if (llm && frames.length) {
    try {
      const { analysis: visual } = await llm.analyzeFrames({
        frames: await Promise.all(frames.map((f) => fs.readFile(f))),
        metrics: {
          ...analysis.technical,
          ...analysis.editing,
          cutTimes: undefined,
          palette: analysis.palette,
          audio: analysis.audio,
        },
        userNotes: ref.notes,
        transcript: analysis.transcript,
      });
      analysis.visual = visual;
    } catch (err) {
      analysis.notes!.push(`Visual style analysis unavailable: ${(err as Error).message}`);
    }
  } else if (!llm) {
    analysis.notes!.push('Configure OpenAI to add AI visual-style analysis.');
  }
  return analysis;
}

async function analyzeImageFile(ref: Reference, file: string, tempDir: string): Promise<ReferenceAnalysis> {
  const analysis: ReferenceAnalysis = { notes: [] };
  const info = await probe(file).catch(() => undefined);
  if (info?.video) {
    analysis.technical = {
      width: info.video.width,
      height: info.video.height,
      aspectRatio: aspectRatioLabel(info.video.width, info.video.height),
    };
  }
  const thumb = path.join(tempDir, 'thumb.jpg');
  await makeThumbnail(file, thumb, 0, 512);
  analysis.palette = await extractPalette([thumb]);
  const llm = await getLlmOptional();
  if (llm) {
    try {
      const { analysis: visual } = await llm.analyzeFrames({
        frames: [await fs.readFile(thumb)],
        metrics: { kind: ref.category, ...analysis.technical, palette: analysis.palette },
        userNotes: ref.notes,
      });
      analysis.visual = visual;
    } catch (err) {
      analysis.notes!.push(`Visual style analysis unavailable: ${(err as Error).message}`);
    }
  }
  return analysis;
}

async function analyzeAudioFile(
  ctx: JobContext,
  ref: Reference,
  file: string,
  tempDir: string,
): Promise<ReferenceAnalysis> {
  const analysis: ReferenceAnalysis = { notes: [] };
  const info = await probe(file);
  analysis.technical = {
    durationSec: Math.round(info.durationSec * 100) / 100,
    audioCodec: info.audio?.codec,
    hasAudio: Boolean(info.audio),
  };
  analysis.audio = await analyzeLoudness(file).catch(() => undefined);
  await ctx.setProgress(0.5);
  const llm = await getLlmOptional();
  if (llm && ref.category !== 'music') {
    try {
      const speech = path.join(tempDir, 'speech.mp3');
      await extractSpeechAudio(file, speech);
      const t = await llm.transcribe(speech);
      if (t.text) analysis.transcript = t.text.slice(0, 8000);
    } catch (err) {
      analysis.notes!.push(`Transcription skipped: ${(err as Error).message}`);
    }
  }
  return analysis;
}

export async function analyzeDocument(file: string, mime: string): Promise<ReferenceAnalysis> {
  if (mime === 'application/pdf') {
    const { stdout } = await runProcess('pdftotext', ['-l', '30', '-enc', 'UTF-8', '-q', file, '-'], {
      captureStdout: true,
      timeoutMs: 60_000,
      maxStdoutBytes: 5 * 1024 * 1024,
    });
    return { text: stdout.toString('utf8').replace(/\s+\n/g, '\n').trim().slice(0, 20_000) };
  }
  const text = await fs.readFile(file, 'utf8');
  return { text: text.slice(0, 20_000) };
}

export const analysisJob: JobHandler = async (ctx) => {
  const c = getConfig();
  if (!ctx.job.referenceId) throw new UserFacingError('Job has no reference');
  const [ref] = await getDb().select().from(references).where(eq(references.id, ctx.job.referenceId));
  if (!ref) throw new UserFacingError('Reference no longer exists');
  await setRef(ref.id, { analysisStatus: 'running', error: null });
  const tempDir = await makeTempDir('analysis');
  try {
    let asset = await getAsset(ref.assetId);
    let analysis: ReferenceAnalysis;
    let status: 'completed' | 'limited' = 'completed';

    // Links: public metadata only, unless the URL is a direct media file.
    if (!asset && ref.kind === 'link' && ref.sourceUrl) {
      const meta = await inspectLink(ref.sourceUrl);
      await setRef(ref.id, { platform: meta.platform, title: ref.title || meta.title || '' });
      if (meta.isDirectMedia) {
        const rel = newProjectFileRel(ref.projectId, 'references', '.bin');
        const abs = absPath(rel);
        await downloadTo(ref.sourceUrl, abs, c.maxUploadBytes);
        const head = Buffer.alloc(4100);
        const fh = await fs.open(abs, 'r');
        await fh.read(head, 0, 4100, 0);
        await fh.close();
        const sniff = await sniffFile(head, ref.sourceUrl);
        if (!sniff || sniff.cls !== 'video') {
          await fs.rm(abs, { force: true });
          throw new UserFacingError('The link did not return a supported video file.');
        }
        const finalRel = rel.replace(/\.bin$/, sniff.ext);
        await fs.rename(abs, absPath(finalRel));
        asset = await createAsset({
          projectId: ref.projectId,
          kind: 'reference',
          relPath: finalRel,
          mime: sniff.mime,
          originalName: path.basename(new URL(ref.sourceUrl).pathname) || 'linked-video',
        });
        await setRef(ref.id, { assetId: asset.id, category: 'video' });
      } else {
        analysis = {
          link: {
            title: meta.title,
            author: meta.author,
            provider: meta.provider,
            thumbnailUrl: meta.thumbnailUrl,
            note: meta.note,
          },
          notes: [],
        };
        status = 'limited';
        if (meta.thumbnailUrl) {
          try {
            const { response } = await safeFetch(meta.thumbnailUrl, { timeoutMs: 20_000 });
            const buf = await readBodyLimited(response, 8 * 1024 * 1024);
            const sniff = await sniffFile(buf.subarray(0, 4100), 'thumb');
            if (response.ok && sniff?.cls === 'image') {
              const rel = newProjectFileRel(ref.projectId, 'references', sniff.ext);
              const abs = await writeFileRel(rel, buf);
              const thumb = await createAsset({
                projectId: ref.projectId,
                kind: 'frame',
                relPath: rel,
                mime: sniff.mime,
                meta: { referenceId: ref.id },
              });
              await setRef(ref.id, { thumbnailAssetId: thumb.id });
              const img = await analyzeImageFile(ref, abs, tempDir);
              analysis = {
                ...analysis,
                palette: img.palette,
                visual: img.visual,
                notes: [...(analysis.notes ?? []), ...(img.notes ?? [])],
              };
            }
          } catch (err) {
            analysis.notes!.push(`Thumbnail unavailable: ${(err as Error).message}`);
          }
        }
        await setRef(ref.id, { analysis, analysisStatus: status });
        return { status };
      }
    }

    if (!asset) throw new UserFacingError('Nothing to analyse – upload a file for this reference.');
    const file = absPath(asset.relPath);
    if (asset.mime.startsWith('video/')) analysis = await analyzeVideoFile(ctx, ref, file, tempDir);
    else if (asset.mime.startsWith('image/')) {
      analysis = await analyzeImageFile(ref, file, tempDir);
      if (!ref.thumbnailAssetId) await setRef(ref.id, { thumbnailAssetId: asset.id });
    } else if (asset.mime.startsWith('audio/')) analysis = await analyzeAudioFile(ctx, ref, file, tempDir);
    else analysis = await analyzeDocument(file, asset.mime);

    const [latest] = await getDb().select().from(references).where(eq(references.id, ref.id));
    await setRef(ref.id, {
      analysis: { ...(latest?.analysis ?? {}), ...analysis },
      analysisStatus: status,
      error: null,
    });
    return { status };
  } finally {
    await removeTempDir(tempDir);
  }
};

export const analysisFailure: FailureHook = async (job, message) => {
  if (!job.referenceId) return;
  await setRef(job.referenceId, { analysisStatus: 'failed', error: message });
};
