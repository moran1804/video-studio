import { spawn } from 'node:child_process';

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly stderrTail: string,
    public readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with 0..1 when `-progress pipe:1` is in args and durationSec is known. */
  onProgress?: (fraction: number) => void;
  durationSec?: number;
  cwd?: string;
  captureStdout?: boolean;
  maxStdoutBytes?: number;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function assertArgs(args: string[]): void {
  for (const a of args) {
    if (typeof a !== 'string') throw new Error('FFmpeg arguments must be strings');
    if (a.includes('\0')) throw new Error('NUL byte in FFmpeg argument');
  }
}

/**
 * Run a binary with an argument array (never a shell). Keeps only the tail of
 * stderr to bound memory, supports timeouts, cancellation and progress.
 */
export function runProcess(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  assertArgs(args);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let progressBuf = '';
    let settled = false;

    const finish = (err: Error | null, result?: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(result!);
    };

    const onAbort = () => {
      child.kill('SIGKILL');
      finish(new FfmpegError(`${bin} cancelled`, stderr.slice(-4000), null));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(
      () => {
        child.kill('SIGKILL');
        finish(
          new FfmpegError(
            `${bin} timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s`,
            stderr.slice(-4000),
            null,
          ),
        );
      },
      opts.timeoutMs ?? 30 * 60_000,
    );

    child.stdout.on('data', (chunk: Buffer) => {
      if (opts.onProgress && opts.durationSec) {
        progressBuf += chunk.toString('utf8');
        const lines = progressBuf.split('\n');
        progressBuf = lines.pop() ?? '';
        for (const line of lines) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
          if (m) {
            const secs = Number(m[1]) / 1_000_000;
            opts.onProgress(Math.max(0, Math.min(1, secs / opts.durationSec)));
          }
        }
      }
      if (opts.captureStdout) {
        stdoutBytes += chunk.length;
        if (stdoutBytes > (opts.maxStdoutBytes ?? 64 * 1024 * 1024)) {
          child.kill('SIGKILL');
          finish(new FfmpegError(`${bin} produced too much output`, stderr.slice(-4000), null));
          return;
        }
        stdoutChunks.push(chunk);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 256_000) stderr = stderr.slice(-128_000);
    });
    child.on('error', (err) => finish(new FfmpegError(`Failed to start ${bin}: ${err.message}`, '', null)));
    child.on('close', (code) => {
      if (code === 0) finish(null, { stdout: Buffer.concat(stdoutChunks), stderr });
      else {
        const tail = stderr.slice(-4000);
        const lastLine = tail.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
        finish(new FfmpegError(`${bin} exited with code ${code}: ${lastLine}`, tail, code));
      }
    });
  });
}

export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const threads = Number(process.env.FFMPEG_THREADS || 0);
  const base = ['-hide_banner', '-nostdin', '-y'];
  const threadArgs = threads > 0 ? ['-threads', String(threads)] : [];
  return runProcess(FFMPEG, [...base, ...args, ...threadArgs], opts);
}

export function runFfprobe(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return runProcess(FFPROBE, ['-hide_banner', ...args], { captureStdout: true, timeoutMs: 60_000, ...opts });
}

export async function ffmpegVersion(): Promise<string | null> {
  try {
    const { stdout } = await runProcess(FFMPEG, ['-version'], { captureStdout: true, timeoutMs: 10_000 });
    return stdout.toString('utf8').split('\n')[0]?.trim() ?? null;
  } catch {
    return null;
  }
}
