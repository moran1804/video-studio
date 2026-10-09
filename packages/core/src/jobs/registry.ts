import type { JobType } from '../queues';
import type { FailureHook, JobHandler } from './context';
import { analysisFailure, analysisJob } from './analysis';
import { briefFailure, briefJob, promptJob, storyboardJob } from './llm';
import { generationFailure, generationJob } from './generation';
import { transcribeJob, voiceoverFailure, voiceoverJob } from './voiceover';
import { renderFailure, renderJob } from './render';
import { brandDesignFailure, brandDesignJob } from './brand';
import { quickVideoFailure, quickVideoJob } from './quick';
import { characterFailure, characterJob } from './character';

export const HANDLERS: Record<JobType, { handler: JobHandler; onFailure?: FailureHook }> = {
  analysis: { handler: analysisJob, onFailure: analysisFailure },
  brief: { handler: briefJob, onFailure: briefFailure },
  storyboard: { handler: storyboardJob },
  prompt: { handler: promptJob },
  brand: { handler: brandDesignJob, onFailure: brandDesignFailure },
  quick: { handler: quickVideoJob, onFailure: quickVideoFailure },
  character: { handler: characterJob, onFailure: characterFailure },
  generation: { handler: generationJob, onFailure: generationFailure },
  voiceover: { handler: voiceoverJob, onFailure: voiceoverFailure },
  transcribe: { handler: transcribeJob },
  render: { handler: renderJob, onFailure: renderFailure },
};
