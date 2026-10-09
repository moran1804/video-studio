# API provider setup

Each provider is optional. Anything that isn't configured shows as _Not configured_ in **Settings**, and actions that need it fail with a clear message. `MOCK_PROVIDERS=true` simulates all of them.

Model names change often, so **every model ID is an environment variable**. After changing one, restart the app. Use **Settings → Test connection** to confirm a key works and the model is visible to it.

> OpenAI's Sora / Videos API is **not** used; it was discontinued on 24 September 2026. Video generation goes through Google or Runway.

---

## OpenAI: briefs, storyboards, prompt rewriting, vision analysis, transcription

1. Create a key at <https://platform.openai.com/api-keys>. A project key with access to the Responses API and Audio is enough.
2. Set it as `OPENAI_API_KEY`, or paste it into Settings.

| Variable                     | Default                     | Used for                                                                                                                                                 |
| ---------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_MODEL`               | `gpt-5`                     | Brief, storyboard, prompt rewriting. Must support **Structured Outputs** (`text.format` of type `json_schema` with `strict: true`) in the Responses API. |
| `OPENAI_VISION_MODEL`        | _(= OPENAI_MODEL)_          | Reference frame analysis (image input).                                                                                                                  |
| `OPENAI_TRANSCRIPTION_MODEL` | `gpt-4o-transcribe`         | Speech in reference videos and uploaded voiceovers. `whisper-1` also returns word timestamps, which give more precise captions for uploaded recordings.  |
| `OPENAI_BASE_URL`            | `https://api.openai.com/v1` | Change it only for an OpenAI-compatible gateway.                                                                                                         |

The language model can also be overridden in **Settings → Defaults** without a restart.

**Usage:** OpenAI's usage API needs an admin key, so the studio reports its own token counts per job type instead (**Settings → API usage**).

## Google Gemini API: Gemini Omni Flash (default) and Veo 3.1

1. Create a key in Google AI Studio (<https://aistudio.google.com/apikey>) on a project with billing enabled. Video generation is a paid feature.
2. Set it as `GOOGLE_GEMINI_API_KEY`, or paste it into Settings.
3. Set the model IDs:

| Variable                  | Default                    | Notes                                                                                                                                                                                                                   |
| ------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_VIDEO_MODEL`      | _(empty)_                  | The **Gemini Omni Flash** model ID exactly as listed for your key. Until it is set, the default "google" provider reports _not set_. **Settings → List Google models** shows the video-capable models your key can see. |
| `GOOGLE_VEO_MODEL`        | `veo-3.1-generate-preview` | Veo 3.1 (a `-fast-` variant may also be offered).                                                                                                                                                                       |
| `GOOGLE_VIDEO_DURATIONS`  | `4,6,8`                    | Clip lengths the model accepts. Scenes are generated at the nearest length and trimmed or extended in the edit.                                                                                                         |
| `GOOGLE_VIDEO_RESOLUTION` | _(empty)_                  | Optional `720p` / `1080p`. Leave it empty for the provider default.                                                                                                                                                     |

**How the adapters call Google:**

- **Gemini Omni Flash** (`gemini-omni-1.1-flash`; `packages/core/src/providers/video/google-omni.ts`) uses the **Interactions API**. Omni models don't support `predictLongRunning`.
  - `POST {base}/interactions` with `model`, `input` (text, or an image plus text for image-to-video), `response_format {type: "video", aspect_ratio, resolution?, delivery: "uri"}`, `generation_config.video_config.task` and `background: true`. If background execution is rejected, the adapter falls back to a blocking call.
  - The adapter polls `GET {base}/interactions/{id}`, checks that the video file is `ACTIVE`, then downloads it.
  - There are no duration or negative-prompt fields, so the adapter adds "Duration: N seconds. Avoid: …" to the prompt. Generated clips are 3–10 seconds at 24 fps.
- **Veo 3.1** (`google.ts`) uses the long-running operation flow.
  - `POST {base}/models/{model}:predictLongRunning` with `instances[{prompt, image?}]` and `parameters{aspectRatio, durationSeconds, negativePrompt?, resolution?}`.
  - The adapter polls `GET {base}/{operation}` and downloads the returned file URI.
- **Both:** only `*.googleapis.com` and `*.googleusercontent.com` download hosts are accepted.

**Aspect ratios:** Google video models accept 16:9 and 9:16. For 1:1 and 4:5 projects, the studio requests 9:16 and centre-crops during rendering.

**Note:** `gemini-omni-flash-preview` was deprecated on 30 September 2026. Use `gemini-omni-1.1-flash`.

## Characters: Nano Banana Pro + Veo 3.1 (realistic virtual people)

Character videos use the workflow behind most viral AI-character content: lock the person with clean references, make a photoreal still first, then animate it.

1. **Clean references:** **Nano Banana Pro** (`GOOGLE_IMAGE_MODEL`, default `gemini-3-pro-image`) turns your turnaround sheets into a clean face close-up and a full-body reference. You approve them on the Characters page.
   - Request: `POST models/{model}:generateContent` with the reference images as `inlineData` parts and `generationConfig.responseModalities: ["IMAGE"]` plus `imageConfig.aspectRatio`.
2. **Keyframe:** for every clip, Nano Banana Pro renders the character in the scene. It's stored on the scene, so retries reuse it.
3. **Video:**
   - **Veo 3.1 (default for characters):** the keyframe is the start frame, and up to 3 references go in `instances[0].referenceImages[{image, referenceType: "asset"}]` with `personGeneration: "allow_adult"`. Clips are 8 s when references are attached. If Veo refuses the start frame and references together, the keyframe is sent as the third reference instead.
   - **Gemini Omni 1.1 Flash:** uses `reference_to_video`. References go first in `input`, then the keyframe, all bound with `<IMAGE_REF_n>` tags.
4. Every prompt repeats the character's identity description and the chosen **Look** (Phone UGC, Cinematic or Studio).

**Needs a live check:** the Veo `referenceImages` field format and whether Veo accepts a start frame together with references. One 8 s test clip confirms both. The cost is an estimate: `COST_PER_IMAGE` per image plus Veo's per-second rate.

## Kling: motion transfer (optional)

**"Copy this movement":** your character performs the motion of a 3–30 s video, e.g. a trending dance.

1. Create a developer account at <https://kling.ai> (API section) and buy credits.
2. Put the **API key** in `KLING_API_KEY` or Settings. Legacy access/secret keys go in as `ACCESS_KEY:SECRET_KEY`; the studio then signs a short-lived HS256 JWT for each request.

| Variable                | Default                             | Notes                                                     |
| ----------------------- | ----------------------------------- | --------------------------------------------------------- |
| `KLING_API_BASE_URL`    | `https://api-singapore.klingai.com` | Regional endpoint                                         |
| `KLING_MOTION_MODEL`    | `kling-v3.0-motion-control`         | `kling-v2.6-motion-control` is cheaper (body motion only) |
| `KLING_MOTION_MODE`     | `pro`                               | `std` = 720p, `pro` = 1080p                               |
| `COST_PER_SECOND_KLING` | `0.18`                              | Estimate                                                  |

**How it's called:**

- `POST /v1/videos/motion-control` with `{model_name, image_url (keyframe, base64), video_url, character_orientation: "video", mode, keep_original_sound: "no", prompt}`.
- The studio polls `GET /v1/videos/motion-control/{task_id}` and downloads `task_result.videos[0].url` (Kling CDN hosts only).

**Needs a live check:** the studio sends the movement video as base64, because the NAS isn't reachable from the internet. If Kling only accepts a public URL, the error says so; host the clip somewhere public and paste a direct `.mp4` link.

**Responsible use:** characters require a consent confirmation (fictional adult, or the person's permission). When posting realistic AI people, turn on Instagram's "AI info" label (and TikTok's AI-generated label).

## Runway: Gen-4.5 (optional)

1. Create a key at <https://dev.runwayml.com> (API → Keys) and add credits.
2. Set `RUNWAY_API_KEY`, or paste it into Settings.

| Variable                 | Default      | Notes                                                               |
| ------------------------ | ------------ | ------------------------------------------------------------------- |
| `RUNWAY_VIDEO_MODEL`     | `gen4.5`     | Confirm the exact model ID in the Runway API docs for your account. |
| `RUNWAY_VIDEO_DURATIONS` | `5,10`       | Durations the model accepts.                                        |
| `RUNWAY_API_VERSION`     | `2024-11-06` | Sent as the `X-Runway-Version` header.                              |

**How the adapter calls Runway:**

- `POST /v1/text_to_video`, or `/v1/image_to_video` when the scene has a reference image. The body is `{model, promptText, ratio, duration, promptImage?}`.
- The task is polled at `GET /v1/tasks/{id}` and can be cancelled with `DELETE /v1/tasks/{id}`.
- Ratios map as 9:16 → `720:1280`, 16:9 → `1280:720`, 1:1 → `960:960`, 4:5 → `832:1104`.
- If the model rejects text-only generation, the error tells you to attach a reference image to the scene.
- **Settings → Test connection** shows your credit balance.

## ElevenLabs: voiceovers

1. Create a key at <https://elevenlabs.io/app/settings/api-keys>. It needs _Text to Speech_ and _Voices (read)_ permissions, plus _User (read)_ for usage display.
2. Set `ELEVENLABS_API_KEY`, or paste it into Settings.

| Variable              | Default                  | Notes                                                                          |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `ELEVENLABS_MODEL`    | `eleven_multilingual_v2` | Any TTS model ID from your account.                                            |
| `ELEVENLABS_VOICE_ID` | _(empty)_                | Default voice for new projects. It can also be set in Settings or per project. |

Speech is generated with `POST /v1/text-to-speech/{voice}/with-timestamps`. The character timings become word timings, which drive word-by-word caption highlighting. Stability, similarity, style, speed and speaker boost come from the project's voice settings. **Settings → Test connection** lists your voices, and the usage table shows characters used.

## Cost estimates

Providers don't return per-request prices, so the studio records **estimates** using `COST_PER_SECOND_GOOGLE`, `COST_PER_SECOND_VEO` and `COST_PER_SECOND_RUNWAY` (USD per generated second). Set these from your provider's current pricing. Always rely on the provider's billing dashboard for real costs.

## Rate limits and retries

Every provider call has a timeout (`HTTP_TIMEOUT_SECONDS`) and retries with exponential backoff and jitter. HTTP 429 responses respect `Retry-After`.

- **Authentication errors (401/403)** are not retried and show "check the API key".
- **Provider-side generation failures** (safety filters, invalid parameters) are not retried automatically, to avoid spending credits on the same failure. Edit the scene and click **Regenerate**.
- **Transient failures** (network errors, 5xx, rate limits) are retried by the job queue up to 4 times, backing off from 15 seconds. A generation that already started keeps polling the same provider job rather than paying for a new one.
