import type { DesignSystem } from './schemas';

export interface BrandContextInput {
  name: string;
  defaultCta?: string;
  handles?: Record<string, string>;
  introText?: string;
  outroText?: string;
  colors?: { primary: string; secondary: string; accent: string };
  fonts?: { heading: string; body: string };
  designSystem?: DesignSystem | null;
  assets?: { role: string; label: string; notes?: string }[];
}

const line = (label: string, value: string | undefined | null) =>
  value && value.trim() ? `${label}: ${value.trim()}` : null;
const joined = (label: string, values: string[] | undefined) =>
  values && values.length ? `${label}: ${values.join('; ')}` : null;

/**
 * Render a brand + design system into a compact plain-text guide that is
 * inserted into every language-model prompt (brief, storyboard, prompt
 * rewriting). Kept deliberately structured so models follow it closely.
 */
export function buildBrandGuide(b: BrandContextInput): string {
  const ds = b.designSystem;
  const out: (string | null)[] = [`Brand: ${b.name}`];
  if (ds?.summary) out.push(line('Essence', ds.summary));
  if (ds?.palette.length) {
    out.push(
      `Palette: ${ds.palette.map((p) => `${p.name} ${p.hex} (${p.role}${p.usage ? ` – ${p.usage}` : ''})`).join('; ')}`,
    );
  } else if (b.colors) {
    out.push(
      `Palette: primary ${b.colors.primary}, secondary ${b.colors.secondary}, accent ${b.colors.accent}`,
    );
  }
  if (ds) {
    out.push(
      line(
        'Typography',
        `headings ${ds.typography.headingFont}, body ${ds.typography.bodyFont}, captions ${ds.typography.captionFont}${ds.typography.notes ? ` – ${ds.typography.notes}` : ''}`,
      ),
    );
    const v = ds.visualStyle;
    out.push(
      line('Photography', v.photography),
      line('Lighting', v.lighting),
      line('Composition', v.composition),
      line('Colour grading', v.colourGrading),
      line('Motion', v.motion),
      line('Textures', v.textures),
    );
    out.push(
      line('Tone of voice', ds.toneOfVoice.description),
      joined('Tone keywords', ds.toneOfVoice.keywords),
      joined('Example phrases', ds.toneOfVoice.examplePhrases),
    );
    out.push(
      joined('Do', ds.dos),
      joined("Don't", ds.donts),
      joined('Taglines', ds.taglines),
      joined('Never use these words', ds.wordsToAvoid),
    );
    out.push(line('Logo usage', ds.logoUsage));
  } else if (b.fonts) {
    out.push(`Typography: headings ${b.fonts.heading}, body ${b.fonts.body}`);
  }
  out.push(line('Default call to action', b.defaultCta));
  if (b.handles && Object.values(b.handles).some(Boolean)) {
    out.push(
      `Handles: ${Object.entries(b.handles)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    );
  }
  out.push(line('Intro card text', b.introText), line('Outro card text', b.outroText));
  if (b.assets?.length) {
    out.push(
      `Brand assets available: ${b.assets.map((a) => `${a.role}${a.label ? ` "${a.label}"` : ''}${a.notes ? ` (${a.notes})` : ''}`).join('; ')}`,
    );
  }
  out.push(
    'Rules: the real logo is overlaid during editing – never ask the video model to draw logos, brand names or text. Keep every scene on-palette and on-tone.',
  );
  return out.filter(Boolean).join('\n');
}

/**
 * Append the brand's visual keywords to a video-generation prompt without
 * exceeding the provider's prompt limit, and build the negative prompt.
 */
export function applyBrandToPrompt(
  prompt: string,
  ds: DesignSystem | null | undefined,
  maxChars: number,
): { prompt: string; negativePrompt: string } {
  const baseNegative = 'logos, brand names, watermarks, on-screen text, captions, distorted faces';
  if (!ds) return { prompt: prompt.slice(0, maxChars), negativePrompt: baseNegative };
  const styleBits = [
    ds.promptKeywords.join(', '),
    ds.visualStyle.colourGrading && `colour grade: ${ds.visualStyle.colourGrading}`,
    ds.visualStyle.lighting && `lighting: ${ds.visualStyle.lighting}`,
    ds.palette.length
      ? `palette ${ds.palette
          .slice(0, 4)
          .map((p) => p.name)
          .join(', ')}`
      : '',
  ].filter(Boolean);
  let suffix = styleBits.length ? ` Brand style – ${styleBits.join('; ')}.` : '';
  const lower = prompt.toLowerCase();
  if (suffix && ds.promptKeywords.length && ds.promptKeywords.every((k) => lower.includes(k.toLowerCase())))
    suffix = '';
  const room = Math.max(0, maxChars - prompt.length);
  const combined = room > 40 ? prompt + suffix.slice(0, room) : prompt.slice(0, maxChars);
  const negative = [ds.negativePrompt, baseNegative].filter(Boolean).join(', ').slice(0, 500);
  return { prompt: combined.trim(), negativePrompt: negative };
}
