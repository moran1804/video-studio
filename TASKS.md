# Build task list

Legend: [x] done · [~] in progress · [ ] todo

## Phase 1 – Foundation

- [x] Monorepo (npm workspaces), TypeScript, ESLint, Prettier
- [x] Core config validation, logger with redaction
- [x] Drizzle schema + migrations, bootstrap/migrate script
- [x] Storage layout + path safety
- [x] Dockerfile (web, worker, test targets) + compose files + health checks

## Phase 2 – Auth & shell

- [x] Admin bootstrap, Argon2id, DB sessions, login/logout
- [x] CSRF, rate limiting, CSP / security headers, AUTH_ENABLED=false mode
- [x] Dark studio layout + dashboard

## Phase 3 – Projects & Reference Board

- [x] New project form (all fields, 4 aspect ratios)
- [x] Streaming uploads + MIME sniffing + size limits
- [x] Link references (SSRF-safe fetch, oEmbed/OpenGraph, direct media download)

## Phase 4 – Reference analysis

- [x] ffprobe, scene detection, frames, palette, loudness, transcript, vision analysis

## Phase 5 – Brief & storyboard

- [x] OpenAI structured outputs + mock
- [x] Editable / approvable brief
- [x] Storyboard timeline (add, delete, duplicate, reorder, edit, regenerate prompt)

## Phase 6 – Video generation

- [x] Provider interface + Google (Omni Flash), Veo 3.1, Runway, Mock
- [x] Generation queue with polling, retries, cancel, recovery
- [x] Replace with uploaded clip, per-scene preview & download

## Phase 7 – Voiceover & audio

- [x] ElevenLabs voices, sample, settings, full / per-scene, uploaded VO (+ transcription)
- [x] Music / SFX / mix settings

## Phase 8 – Captions & brands

- [x] Caption builder (ASS + SRT), styles, safe zones, word highlight, preview
- [x] Brand profiles, logo overlay, watermark, intro/outro

## Phase 9 – Rendering & export

- [x] FFmpeg pipeline (normalize, xfade, mix, duck, captions, overlays, loudnorm)
- [x] Preview + final, progress, history, downloads, retry, temp cleanup

## Phase 10 – Settings

- [x] Connection status/tests, models, defaults, storage, FFmpeg version, queue health, usage

## Phase 11 – Reliability

- [x] Startup recovery / reconciliation

## Phase 12 – Tests, docs, verification

- [x] Unit tests (79): providers, storyboard, security, captions, FFmpeg args, config
- [x] Integration tests (4): BullMQ + Postgres, retries, cancellation, recovery
- [x] FFmpeg tests (8): full render, preview, analysis, corrupt input, mock provider, job pipeline
- [x] API integration tests + mocked end-to-end flow against the Compose stack (18)
- [x] Browser tests (Playwright, 3: desktop + mobile)
- [x] README, DEPLOYMENT, ARCHITECTURE, TROUBLESHOOTING, docs/PROVIDERS, GitHub Actions workflow
- [x] Format, lint, typecheck, docker build, compose up, health checks, worker crash/restart recovery

## Feature – Brand design system

- [x] Brand asset library (logo variants, product / mood imagery, guideline docs) with roles and notes
- [x] Design system schema + migration (palette roles, typography, visual style, tone, do/don't, logo usage, prompt keywords, negative prompt)
- [x] "Generate design system" job (vision model over logos/imagery + measured colours + guideline text), edit and approve
- [x] Brand guide passed to brief, storyboard and prompt-rewrite requests; keywords + negative prompt on every generation
- [x] Brand imagery as fallback reference image; captions default to the brand's font and accent colour
- [x] Tests: unit (8), pipeline (1), API flow, browser flow

## Feature – Animate uploaded artwork (no brand needed)

- [x] Reference usage: "Use as inspiration" or "Animate this image" (upload, toggle on cards)
- [x] "Animate → new scene" quick path; new-project artwork upload lands on the Storyboard
- [x] Scene "Animate an image (start frame)" picker; start frame fitted without cropping (blurred fill)
- [x] Layout-preserving prompt rules; AI storyboards map animate references to scenes
- [x] Mock provider animates the actual image (Ken Burns) so the flow is testable offline
- [x] Fixed: ffprobe on image files, test files sharing the DB, artwork picker dropping files
- [x] Tests: unit (4), FFmpeg (3), API flow, browser flow

## Needs manual configuration / live verification

- [ ] API keys (OpenAI, Google Gemini, Runway, ElevenLabs) and billing on each account
- [ ] Confirm model IDs: GOOGLE_VIDEO_MODEL (Gemini Omni Flash), GOOGLE_VEO_MODEL, RUNWAY_VIDEO_MODEL
- [ ] Confirm Google image-conditioning field and duration/resolution combos with a live key
- [ ] Choose an image delivery route (GHCR via GitHub Actions, or build on the NAS)
- [ ] Reverse proxy (HTTPS, body size, timeouts) + APP_URL / ALLOWED_ORIGINS
