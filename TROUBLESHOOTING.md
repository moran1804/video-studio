# Troubleshooting

Start with the tools in the app:

- **Dashboard → Needs attention** lists failed jobs, with their error and a **Retry** button.
- **Settings** shows provider connection tests, worker heartbeat and FFmpeg version, queue counts, storage and usage.
- **Container logs:**
  - In the UI: Apps → video-studio → Workloads.
  - In a shell: `docker logs -f --tail 200 ix-video-studio-worker-1`.

## The app doesn't start

| Symptom                                                                                             | Fix                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrate` exits with `[config] error: …`                                                            | The message names the missing or invalid variable, e.g. `SESSION_SECRET must be set to at least 32 random characters`. Fix `studio.env` and redeploy.                                                                                           |
| `No users exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD`                                            | Set both. The password needs at least 10 characters.                                                                                                                                                                                            |
| `Database not reachable after 60s`                                                                  | Postgres isn't healthy. Check its logs. The usual cause is permissions (next row).                                                                                                                                                              |
| Postgres: `could not create directory …: Permission denied` or `data directory has wrong ownership` | `sudo chown -R 568:568 /mnt/tank/apps/video-studio/postgres`. With NFSv4 ACLs, also grant `apps` modify.                                                                                                                                        |
| Postgres: `could not write lock file … No space left on device`                                     | The pool is full. Free space (old exports and previews are in `data/projects/*/previews`). Postgres restarts automatically.                                                                                                                     |
| Redis: `Can't open the append-only file: Permission denied`                                         | `sudo chown -R 568:568 /mnt/tank/apps/video-studio/redis`                                                                                                                                                                                       |
| web and worker never start                                                                          | They wait for `migrate` to finish successfully. Read `docker logs ix-video-studio-migrate-1`.                                                                                                                                                   |
| `password authentication failed for user "studio"`                                                  | The password in `DATABASE_URL` doesn't match `POSTGRES_PASSWORD`. If you changed `POSTGRES_PASSWORD` after the first start, Postgres still has the old one. Change it back, or update it inside Postgres with `ALTER USER studio PASSWORD '…'`. |

## Can't sign in / "Request blocked"

- **"Request blocked: origin not allowed":** you opened the studio from a URL other than `APP_URL`. Add that URL (scheme, host and port) to `ALLOWED_ORIGINS`, or use `APP_URL`.
- **"Security token missing or expired":** reload the page. If it keeps happening, your proxy may be stripping cookies. The `vs_csrf` cookie must reach the browser.
- **Signed in, but immediately sent back to the login page:** `APP_URL` is `https://…` but you are browsing over plain http. Secure cookies are not sent over http. Use the HTTPS URL.
- **"Too many sign-in attempts":** wait 5 minutes. Limits are per client and per account.
- **Forgot the password:** set `ADMIN_PASSWORD=<new>` and `ADMIN_RESET_PASSWORD=true`, redeploy, then set `ADMIN_RESET_PASSWORD=false`.

## Failed generation jobs

The scene card and the dashboard show the provider's message. Common causes:

| Message                                            | Cause and fix                                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `… API key is not configured. Add it in Settings.` | Add the key in Settings, or in `studio.env` and redeploy.                                                                                    |
| `authentication failed – check the API key`        | The key is wrong, revoked, or lacks permission or billing. Use **Test connection**.                                                          |
| `no model configured (set GOOGLE_VIDEO_MODEL)`     | Set the Gemini Omni Flash model ID ([docs/PROVIDERS.md](docs/PROVIDERS.md)), or choose another provider for the scene.                       |
| `HTTP 404 – models/… is not found`                 | Wrong model ID, or the model isn't enabled for your key. **Settings → List Google models**.                                                  |
| `HTTP 400 – … durationSeconds / aspectRatio …`     | The model rejects that combination. Adjust `GOOGLE_VIDEO_DURATIONS` / `GOOGLE_VIDEO_RESOLUTION` / `RUNWAY_VIDEO_DURATIONS`.                  |
| `Blocked by the provider's safety filters: …`      | Rephrase the prompt: avoid real people's names, brands or unsafe content. Then **Regenerate**. These failures are not retried automatically. |
| `rate limit or quota reached`                      | Retried automatically with backoff. If it persists, check your quota and billing. Lower `GENERATION_CONCURRENCY`.                            |
| `Generation did not finish within 20 minutes`      | The provider is slow or stuck. Retry, or raise `GENERATION_TIMEOUT_MINUTES`.                                                                 |
| `Runway: … attach a reference image`               | Your Runway model needs an input image. Select a reference image in the scene's _Reference assets_.                                          |
| `Downloaded clip is invalid`                       | The provider returned a broken file. This is retried automatically; otherwise **Regenerate**.                                                |
| Stuck on _queued_                                  | The worker isn't running, or the queue is busy. Settings → Worker should show _online_. Check the queue counts and worker logs.              |

Retrying from the UI starts a fresh provider request. A job that was interrupted by a restart **resumes polling** the existing provider job instead, so you are not charged twice.

## Voiceover problems

- **"Choose a voice first":** select a voice under Voice & Audio. The list comes from ElevenLabs, so check the key if it is empty.
- **The voiceover is longer than the scene:** the storyboard shows a warning. Shorten the text, extend the scene, or use _Full script_ mode.
- **Captions don't follow my uploaded recording:** transcription needs OpenAI. Without it, captions are spread evenly across the script. Using `whisper-1` as the transcription model gives word-level timing.

## Render failures

| Message                                  | Fix                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Scenes without footage: 2, 5`           | Generate or upload clips for those scenes.                                                                                 |
| `Scene 3: clip is not a valid video`     | Replace the scene's footage (upload a different file, or regenerate).                                                      |
| `ffmpeg exited with code …`              | The last FFmpeg lines appear in the error. Common causes: a corrupt music or SFX file (re-upload it), or the disk is full. |
| `ffmpeg was not found` in the worker log | You are running the worker outside the provided image. Install FFmpeg.                                                     |
| Render is slow / NAS is busy             | Lower `FFMPEG_THREADS` (e.g. `4`) and keep `RENDER_CONCURRENCY=1`. Use _Render preview_ for checks.                        |
| Render marked "Interrupted by a restart" | Click **Retry** in Export → Render history.                                                                                |

## Uploads

- **"File is larger than the … MB limit":** raise `MAX_UPLOAD_MB` **and** your proxy's body limit (`client_max_body_size`).
- **HTTP 413 from the proxy (before the app):** the proxy's body limit is too low.
- **"Unsupported file type":** the type is detected from the file's contents, not its extension. Supported types:
  - Images: JPEG, PNG, WebP, GIF.
  - Video: MP4, MOV, WebM, MKV.
  - Audio: MP3, WAV, M4A/AAC, OGG/Opus, FLAC.
  - Documents: TXT, Markdown, PDF.
  - SVG and HTML are rejected for security.

## Reference links

- **"Links to private or reserved IP addresses are not allowed" / "local or internal hosts":** SSRF protection. Only public internet URLs on ports 80/443 are fetched.
- **Status "metadata only" for YouTube, TikTok, Instagram or Vimeo links:** by design. Only public metadata and the thumbnail are read. Upload the video file, if you own it or have permission, for a full analysis.
- **"The video is not publicly accessible (HTTP 401/403)":** the link needs a login. Upload the file instead.

## Jobs after restarts

- After a crash, stalled jobs are picked up again once their lock expires, within about 1–2 minutes of the worker restarting.
- Generation jobs resume polling their provider job.
- Renders and analyses restart, or are marked _Interrupted_ with a Retry button.
- To inspect the queues directly:

```bash
docker exec -it ix-video-studio-redis-1 redis-cli --scan --pattern 'studio:*:id' | head
docker exec -it ix-video-studio-postgres-1 psql -U studio -c \
  "select type,status,attempts,left(error,80) from jobs where status in ('queued','running','failed') order by updated_at desc limit 20;"
```

## Health endpoints

```bash
curl -s http://<nas-ip>:3000/api/health     # {"ok":true,"db":"ok","redis":"ok","worker":"ok (5s ago)"}
docker exec ix-video-studio-worker-1 node apps/worker/dist/healthcheck.js && echo worker ok
```

## Running the browser tests

`npm run test:e2e` needs Playwright browsers. Without installing them locally, use the official image:

```bash
docker run --rm --network host --ipc=host -v "$PWD:/work" -w /work/apps/web \
  -e STUDIO_URL=http://localhost:3000 -e STUDIO_EMAIL=… -e STUDIO_PASSWORD=… \
  mcr.microsoft.com/playwright:v1.63.0-noble npx playwright test
```
