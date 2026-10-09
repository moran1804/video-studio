# AI Social Video Studio

A self-hosted studio for making polished social videos: Reels, TikTok, Shorts, and Facebook/Instagram or landscape promos. It goes from a creative brief to a finished MP4:

**Create screen (home page).** Type what you want in one message, like chatting with an AI. Optionally attach images to animate or use as inspiration, then pick options: dropdowns for format, length, brand / design system and video model, and checkboxes for voiceover (with a voice choice), captions, background music, and logo and outro. Press **Create video** and one background job does the rest. The AI plans the clip(s); requests longer than the model's maximum clip length are split automatically. It then generates the footage, records the voiceover, adds captions and renders the final MP4. Your videos appear in the conversation with **Download**, **Try again** and **Open in advanced editor**. The detailed brief → storyboard → scene workflow described below is still available under **Advanced projects**.

**Characters (realistic virtual people).** Upload your turnaround sheets and character references once on the **Characters** page. The AI writes an identity description, and Nano Banana Pro makes a clean face close-up and full-body reference for you to approve; **Make a test shot** checks the likeness. On the Create screen, pick the character and a **Look** (Phone UGC, Cinematic or Studio). Every clip starts from a photoreal keyframe of that person and is animated by **Veo 3.1** with the references attached, so the face, hair and outfit stay consistent. Attach a 3–30 s video and choose **Copy this movement** to have the character perform it (Kling Motion Control, optional). See [docs/PROVIDERS.md](docs/PROVIDERS.md).

1. **Project brief.** Record the objective, audience, tone, message, call to action, event and brand details.
2. **Reference Board.** Upload images, logos, posters, clips, audio, music, text, Markdown or PDF, or paste public video links. Each reference records what you like about it. Reference videos are analysed with FFmpeg (duration, resolution, average shot length, pace, palette, loudness) and a vision model (camera, lighting, captions, hook, CTA). Speech is transcribed.
3. **Animate your artwork.** Upload a poster, flyer or any image and choose **Animate this image**, either on the new-project form or on the Reference Board. The studio creates a ready-to-generate scene that uses the image as the video's start frame, fitted without cropping, and asks the model to keep all text, logos and layout unchanged. No brand or brief is needed. AI storyboards also respect images marked for animation.
4. **Creative brief.** OpenAI Structured Outputs draft it; you edit and approve it before anything is generated.
5. **Storyboard.** Editable scene cards on a timeline: add, delete, duplicate, drag-reorder, edit any field, or rewrite a prompt with AI.
6. **Video generation.** Scenes are generated asynchronously with **Google Gemini Omni Flash** (default), **Google Veo 3.1** or **Runway Gen-4.5**. You can generate one scene or all, regenerate a failed scene, or replace a scene with your own clip.
7. **Voice and audio.** ElevenLabs voices with preview and settings, as one full take or per scene, or your own uploaded recording. Licensed music with volume, looping, fades and automatic ducking under speech. Sound effects are placed on the timeline.
8. **Captions.** Burned-in captions with word-by-word highlighting, safe zones for TikTok, Reels and Shorts, a live preview and an SRT export.
9. **Branding and design system.** Each brand profile has an asset library: logo variants, product and mood imagery, and brand-guideline PDFs. Clicking **Generate design system** has the AI draft one from those assets: palette with roles, typography, visual style, tone of voice, do's and don'ts, logo usage, video prompt keywords and a negative prompt. You edit and approve it. The approved system is passed to every AI step:
   - the brief, storyboard and prompt rewrites (the exact text is shown under **AI context**);
   - every video-generation request, as style keywords, a negative prompt, and a brand image as reference when a scene has none;
   - captions, intro/outro cards and the logo overlay.
10. **Rendering.** FFmpeg normalises clips, applies transitions, mixes and ducks audio, burns captions, overlays the logo and normalises loudness. The final export is H.264/AAC, 1080×1920, 30 fps, yuv420p with fast start. There are also quick preview renders, render history and downloads.

It runs as a four-service Docker Compose app (**web, worker, Postgres, Redis**) and is designed for **TrueNAS SCALE 24.10+**, with all media stored on a TrueNAS dataset.

> **Mock mode.** Set `MOCK_PROVIDERS=true` to run the whole pipeline without calling any paid API. Video clips are rendered locally as labelled test patterns, voiceovers are synthetic tones with real word timings, and briefs and storyboards are generated from your inputs.

## Documentation

| Document                                 | What it covers                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [DEPLOYMENT.md](DEPLOYMENT.md)           | TrueNAS install: datasets, permissions, env, YAML, reverse proxy, first login, updates, backup/restore, logs |
| [docs/PROVIDERS.md](docs/PROVIDERS.md)   | Getting and configuring OpenAI, Google Gemini/Veo, Runway and ElevenLabs keys and model IDs                  |
| [ARCHITECTURE.md](ARCHITECTURE.md)       | Services, job lifecycle, provider abstraction, rendering pipeline, storage, security                         |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Failed generations, renders, uploads, logins, permissions, recovery                                          |
| [.env.example](.env.example)             | Every configuration option, documented                                                                       |

## Quick start (any Docker host)

```bash
cp .env.example .env
# Edit .env: at least ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_SECRET (openssl rand -hex 32),
# POSTGRES_PASSWORD (+ the same password inside DATABASE_URL), APP_URL, PUID/PGID.
# For a first look without API keys: MOCK_PROVIDERS=true and DEFAULT_VIDEO_PROVIDER=mock
mkdir -p .local/data .local/postgres .local/redis   # owned by PUID:PGID
docker compose up -d --build
```

Open `http://localhost:3000` (or your `APP_URL`) and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

For TrueNAS, follow [DEPLOYMENT.md](DEPLOYMENT.md).

## Development

Requirements: Node 22, npm 10, Docker. FFmpeg is only needed locally if you want to run the FFmpeg test suite outside Docker.

```bash
npm install
docker compose -f docker-compose.test.yml up -d --wait postgres-test redis-test   # throwaway DB + Redis

# Run the app against them (two terminals)
export DATABASE_URL=postgres://studio:studio@localhost:55432/studio_test REDIS_URL=redis://localhost:56379 \
       SESSION_SECRET=$(openssl rand -hex 32) DATA_ROOT=$PWD/.local/dev-data MOCK_PROVIDERS=true \
       APP_URL=http://localhost:3000 ADMIN_EMAIL=dev@example.com ADMIN_PASSWORD=devpassword123
npm run migrate          # migrations + admin account
npm run dev:worker       # needs ffmpeg on PATH for generation/rendering
npm run dev:web          # http://localhost:3000
```

### Repository layout

```
apps/web        Next.js 15 (App Router) UI + REST API (route handlers under src/app/api)
apps/worker     BullMQ worker, migrate/bootstrap entrypoint, health endpoint
packages/core   Shared server code: config, DB schema, queues, providers, FFmpeg, captions, security
packages/core/drizzle   SQL migrations (generated with `npm run db:generate`)
Dockerfile      Targets: web, worker (also runs migrations), test
docker-compose.yml          Local / generic Docker host
docker-compose.truenas.yml  TrueNAS "Install via YAML"
docker-compose.test.yml     Test Postgres/Redis + test runner
```

### Quality checks and tests

| Command                           | What it runs                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format` / `format:check` | Prettier                                                                                                                           |
| `npm run lint`                    | ESLint (TypeScript, Next.js, React Hooks rules)                                                                                    |
| `npm run typecheck`               | `tsc --noEmit` for every workspace                                                                                                 |
| `npm run test:unit`               | Provider adapters (mocked HTTP), storyboard/brief validation, path/URL/upload security, captions, FFmpeg argument builders, config |
| `npm run test:integration`        | BullMQ + Postgres job tracking, retries, cancellation, restart recovery (needs `TEST_DATABASE_URL`, `TEST_REDIS_URL`)              |
| `npm run test:ffmpeg`             | Real FFmpeg renders from generated fixture clips, reference analysis, mock provider, and the full job pipeline                     |
| `npm run test:api`                | API integration tests plus the mocked end-to-end flow against a running stack (`STUDIO_URL`, `STUDIO_EMAIL`, `STUDIO_PASSWORD`)    |
| `npm run test:e2e`                | Playwright browser tests: login, project creation, brief, storyboard editing and reordering, mobile layout                         |
| `npm run test:docker`             | Unit, integration and FFmpeg suites inside the Docker `test` image (FFmpeg included)                                               |

No test calls a paid API: provider adapters are tested against recorded request/response shapes, and everything else runs in mock mode.
