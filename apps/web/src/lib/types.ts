// Data transfer objects shared by API routes and client components.
// Internal storage paths are never exposed – only /api/files/{id} URLs.
import type {
  AudioSettings,
  BrandingSettings,
  Brief,
  CaptionSettings,
  ProjectDetails,
  DesignSystem,
  ReferenceAnalysis,
  VoiceSettings,
} from '@studio/core/schemas';

export interface AssetDTO {
  id: string;
  kind: string;
  mime: string;
  name: string | null;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  url: string;
  downloadUrl: string;
  createdAt: string;
  meta?: { text?: string; wordCount?: number };
}

export interface JobDTO {
  id: string;
  type: string;
  status: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  provider: string | null;
  error: string | null;
  projectId: string | null;
  projectName?: string | null;
  sceneId: string | null;
  referenceId: string | null;
  renderId: string | null;
  costEstimateUsd: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SceneDTO {
  id: string;
  position: number;
  purpose: string;
  durationSec: number;
  visualDescription: string;
  prompt: string;
  referenceAssetIds: string[];
  /** Image animated directly as the start frame (poster, flyer, artwork). */
  animateAssetId: string | null;
  animateUrl: string | null;
  camera: string;
  lighting: string;
  onScreenText: string;
  voiceoverText: string;
  transition: string;
  audioDirection: string;
  provider: string;
  status: string;
  error: string | null;
  clipSource: string | null;
  clip: AssetDTO | null;
  thumbnailUrl: string | null;
  voiceover: AssetDTO | null;
  job: JobDTO | null;
}

export interface ReferenceDTO {
  id: string;
  kind: string;
  category: string;
  title: string;
  notes: string;
  /** inspiration | animate */
  usage: string;
  sourceUrl: string | null;
  platform: string | null;
  asset: AssetDTO | null;
  thumbnailUrl: string | null;
  analysisStatus: string;
  analysis: ReferenceAnalysis | null;
  frameUrls: string[];
  error: string | null;
  createdAt: string;
}

export interface RenderDTO {
  id: string;
  mode: string;
  status: string;
  progress: number;
  width: number;
  height: number;
  durationSec: number | null;
  video: AssetDTO | null;
  srt: AssetDTO | null;
  thumbnailUrl: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface BrandDTO {
  id: string;
  name: string;
  logo: AssetDTO | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  headingFont: string;
  bodyFont: string;
  introText: string;
  outroText: string;
  defaultCta: string;
  handles: Record<string, string>;
  designSystem: DesignSystem | null;
  designStatus: string;
}

export interface BrandAssetDTO extends AssetDTO {
  role: string;
  label: string;
  notes: string;
  isOverlayLogo: boolean;
}

export interface BrandDetailDTO extends BrandDTO {
  assets: BrandAssetDTO[];
  job: JobDTO | null;
  /** Exact brand context text passed to the language model. */
  guide: string;
}

export interface ProjectDTO {
  id: string;
  name: string;
  platform: string;
  aspectRatio: string;
  durationSec: number;
  details: ProjectDetails;
  brandId: string | null;
  defaultProvider: string | null;
  brief: Brief | null;
  briefStatus: string;
  voiceSettings: VoiceSettings;
  audioSettings: AudioSettings;
  captionSettings: CaptionSettings;
  brandingSettings: BrandingSettings;
  status: { key: string; label: string };
  thumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectBundle {
  project: ProjectDTO;
  scenes: SceneDTO[];
  references: ReferenceDTO[];
  renders: RenderDTO[];
  jobs: JobDTO[];
  audioAssets: AssetDTO[];
  voiceover: AssetDTO | null;
  brand: BrandDTO | null;
  activeJobs: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  platform: string;
  aspectRatio: string;
  durationSec: number;
  createdAt: string;
  status: { key: string; label: string };
  thumbnailUrl: string | null;
  latestExport: { url: string; downloadUrl: string; createdAt: string } | null;
  progress: { active: number; completedScenes: number; totalScenes: number; renderProgress: number | null };
  failedJobs: JobDTO[];
}

export interface CharacterAssetDTO extends AssetDTO {
  role: string;
  approved: boolean;
}

export interface CharacterDTO {
  id: string;
  name: string;
  description: string;
  notes: string;
  status: string; // none | preparing | review | ready
  consent: boolean;
  /** Approved (else latest) face reference, for avatars. */
  avatar: AssetDTO | null;
  createdAt: string;
}

export interface CharacterDetailDTO extends CharacterDTO {
  uploads: CharacterAssetDTO[];
  references: CharacterAssetDTO[];
  testShots: CharacterAssetDTO[];
  job: JobDTO | null;
}
