export function formatBytes(n: number | null | undefined): string {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '–';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${Math.round(sec * 10) / 10}s`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}

export const PLATFORM_LABELS: Record<string, string> = {
  instagram_reels: 'Instagram Reels',
  tiktok: 'TikTok',
  youtube_shorts: 'YouTube Shorts',
  facebook_instagram_promo: 'FB / IG promo',
  landscape_promo: 'Landscape promo',
};

export const JOB_LABELS: Record<string, string> = {
  analysis: 'Reference analysis',
  brief: 'Creative brief',
  storyboard: 'Storyboard',
  prompt: 'Prompt rewrite',
  generation: 'Scene generation',
  voiceover: 'Voiceover',
  transcribe: 'Transcription',
  render: 'Render',
};
