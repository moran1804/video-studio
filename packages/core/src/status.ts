export type ProjectStatusKey =
  | 'draft'
  | 'brief_draft'
  | 'brief_approved'
  | 'storyboard'
  | 'generating'
  | 'ready'
  | 'rendering'
  | 'exported'
  | 'attention';

export interface ProjectStatusInput {
  briefStatus: string;
  sceneStatuses: string[];
  activeJobTypes: string[];
  failedJobCount: number;
  hasFinalExport: boolean;
}

export const STATUS_LABELS: Record<ProjectStatusKey, string> = {
  draft: 'Draft',
  brief_draft: 'Brief ready for review',
  brief_approved: 'Brief approved',
  storyboard: 'Storyboard',
  generating: 'Generating',
  ready: 'Ready to render',
  rendering: 'Rendering',
  exported: 'Exported',
  attention: 'Needs attention',
};

export function deriveProjectStatus(i: ProjectStatusInput): { key: ProjectStatusKey; label: string } {
  const pick = (key: ProjectStatusKey) => ({ key, label: STATUS_LABELS[key] });
  if (i.activeJobTypes.includes('render')) return pick('rendering');
  if (i.activeJobTypes.some((t) => t !== 'render')) return pick('generating');
  if (i.failedJobCount > 0) return pick('attention');
  if (i.hasFinalExport) return pick('exported');
  if (i.sceneStatuses.length && i.sceneStatuses.every((s) => s === 'completed')) return pick('ready');
  if (i.sceneStatuses.length) return pick('storyboard');
  if (i.briefStatus === 'approved') return pick('brief_approved');
  if (i.briefStatus === 'draft') return pick('brief_draft');
  return pick('draft');
}
