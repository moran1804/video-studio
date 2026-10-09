import 'server-only';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import Busboy from 'busboy';
import type { NextRequest } from 'next/server';
import { UserFacingError } from '@studio/core/errors';
import { getConfig } from '@studio/core/config';
import { sniffFile, type SniffResult, type UploadClass } from '@studio/core/security/upload';
import { sanitizeFilename } from '@studio/core/security/paths';
import { absPath, ensureParentDir } from '@studio/core/storage';

export interface ReceivedFile {
  relPath: string;
  abs: string;
  originalName: string;
  size: number;
  sniff: SniffResult;
}

export interface UploadResult {
  fields: Record<string, string>;
  file: ReceivedFile;
}

const HEAD_BYTES = 4100;

/**
 * Stream a single multipart file to storage. The file type is detected from
 * its first bytes before anything is persisted, size limits are enforced
 * while streaming, and the stored filename is random.
 */
export async function receiveUpload(
  req: NextRequest,
  opts: { allowed: UploadClass[]; relDir: string; maxBytes?: number },
): Promise<UploadResult> {
  const maxBytes = opts.maxBytes ?? getConfig().maxUploadBytes;
  const limitMb = Math.round(maxBytes / 1024 / 1024);
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data'))
    throw new UserFacingError('Expected a multipart file upload');
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared && declared > maxBytes + 1024 * 1024) {
    throw new UserFacingError(`File is larger than the ${limitMb} MB limit.`, 413, 'too_large');
  }
  if (!req.body) throw new UserFacingError('Empty upload');

  const handleFile = async (
    stream: NodeJS.ReadableStream & { truncated?: boolean },
    filename: string | undefined,
  ): Promise<ReceivedFile> => {
    const head: Buffer[] = [];
    let headLen = 0;
    let size = 0;
    let out: fs.WriteStream | undefined;
    let result: ReceivedFile | undefined;
    let error: Error | undefined;

    const open = async () => {
      const buf = Buffer.concat(head);
      const sniff = await sniffFile(buf.subarray(0, HEAD_BYTES), filename ?? '');
      if (!sniff || !opts.allowed.includes(sniff.cls)) {
        throw new UserFacingError(
          `Unsupported file type${sniff ? ` (${sniff.mime})` : ''}. Allowed: ${opts.allowed.join(', ')}.`,
          415,
          'unsupported_type',
        );
      }
      const relPath = path.posix.join(opts.relDir, `${crypto.randomUUID()}${sniff.ext}`);
      const abs = absPath(relPath);
      await ensureParentDir(abs);
      out = fs.createWriteStream(abs, { flags: 'wx' });
      result = { relPath, abs, originalName: sanitizeFilename(filename, 'upload'), size: 0, sniff };
      if (!out.write(buf)) await once(out, 'drain');
    };

    // Keep consuming the stream even after an error so busboy can finish cleanly.
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (error) continue;
      size += chunk.length;
      try {
        if (!out) {
          head.push(chunk);
          headLen += chunk.length;
          if (headLen >= HEAD_BYTES) await open();
        } else if (!out.write(chunk)) {
          await once(out, 'drain');
        }
      } catch (e) {
        error = e as Error;
      }
    }
    try {
      if (!error && stream.truncated)
        error = new UserFacingError(`File is larger than the ${limitMb} MB limit.`, 413, 'too_large');
      if (!error && size === 0) error = new UserFacingError('The uploaded file is empty');
      if (!error && !out) await open();
    } catch (e) {
      error = e as Error;
    }
    if (out) {
      out.end();
      await once(out, 'close').catch(() => undefined);
    }
    if (error) {
      if (result) await fsp.rm(result.abs, { force: true });
      throw error;
    }
    result!.size = size;
    return result!;
  };

  return new Promise<UploadResult>((resolve, reject) => {
    const fields: Record<string, string> = {};
    let filePromise: Promise<ReceivedFile> | undefined;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const bb = Busboy({
      headers: { 'content-type': contentType },
      limits: { files: 1, fileSize: maxBytes, fields: 30, fieldSize: 64 * 1024 },
    });
    bb.on('field', (name, value) => {
      if (/^[a-zA-Z0-9_]{1,40}$/.test(name)) fields[name] = value;
    });
    bb.on('file', (_name, stream, info) => {
      if (filePromise) {
        stream.resume();
        return;
      }
      filePromise = handleFile(stream, info.filename);
      filePromise.catch(() => undefined); // handled on close
    });
    bb.on('error', (err) => fail(err as Error));
    bb.on('close', () => {
      if (!filePromise) return fail(new UserFacingError('No file was uploaded'));
      filePromise.then(
        (file) => {
          if (settled) {
            void fsp.rm(file.abs, { force: true });
            return;
          }
          settled = true;
          resolve({ fields, file });
        },
        (err) => fail(err as Error),
      );
    });

    const nodeStream = Readable.fromWeb(req.body as unknown as NodeReadableStream);
    nodeStream.on('error', (err) => fail(err));
    nodeStream.pipe(bb);
  });
}
