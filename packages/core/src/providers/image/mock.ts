import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '../../ffmpeg/exec';
import { DEFAULT_FONT_FILE, wrapText } from '../video/mock';
import type { GeneratedImage, ImageAspectRatio, ImageGenerationRequest, ImageProvider } from './types';

const SIZES: Record<ImageAspectRatio, [number, number]> = {
  '1:1': [768, 768],
  '3:4': [672, 896],
  '4:3': [896, 672],
  '4:5': [688, 860],
  '5:4': [860, 688],
  '9:16': [576, 1024],
  '16:9': [1024, 576],
};

/** Offline stand-in: the first reference fitted onto a tinted frame, labelled with the prompt. */
export class MockImageProvider implements ImageProvider {
  readonly id = 'mock' as const;
  readonly model = 'mock-image';

  async generateImage(req: ImageGenerationRequest): Promise<GeneratedImage> {
    const [w, h] = SIZES[req.aspectRatio] ?? SIZES['9:16'];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mockimg-'));
    try {
      const label = path.join(dir, 'label.txt');
      await fs.writeFile(label, wrapText(req.prompt.slice(0, 120), w > h ? 34 : 22, 4));
      const out = path.join(dir, 'out.png');
      const text = `drawtext=fontfile=${DEFAULT_FONT_FILE}:textfile=${label}:fontcolor=white:fontsize=${Math.round(Math.min(w, h) / 26)}:x=(w-text_w)/2:y=h-text_h-40:box=1:boxcolor=black@0.55:boxborderw=14`;
      if (req.references[0]) {
        const ref = path.join(dir, `ref.${req.references[0].mimeType === 'image/png' ? 'png' : 'jpg'}`);
        await fs.writeFile(ref, req.references[0].data);
        await runFfmpeg(
          [
            '-f',
            'lavfi',
            '-i',
            `color=c=0x2a2a3a:s=${w}x${h}`,
            '-i',
            ref,
            '-filter_complex',
            `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[0:v][fg]overlay=(W-w)/2:(H-h)/2,${text}`,
            '-frames:v',
            '1',
            out,
          ],
          { timeoutMs: 60_000 },
        );
      } else {
        await runFfmpeg(['-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}`, '-vf', text, '-frames:v', '1', out], {
          timeoutMs: 60_000,
        });
      }
      return { data: await fs.readFile(out), mimeType: 'image/png' };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async testConnection() {
    return { ok: true, message: 'Mock image model (MOCK_PROVIDERS=true).' };
  }
}
