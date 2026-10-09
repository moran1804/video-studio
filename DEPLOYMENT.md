# Deploying on TrueNAS SCALE

These instructions are for **TrueNAS SCALE 24.10 (Electric Eel) or newer**, where apps run on Docker. Check your version under **System → General → Version**.

The app runs as a "Custom App" installed from YAML. It has five containers:

| Service    | Image                  | Purpose                                                                      |
| ---------- | ---------------------- | ---------------------------------------------------------------------------- |
| `web`      | `video-studio-web`     | UI + API on port 3000                                                        |
| `worker`   | `video-studio-worker`  | Generation, analysis, voiceover and FFmpeg rendering                         |
| `migrate`  | `video-studio-worker`  | One-shot: database migrations, storage folders, first admin; exits when done |
| `postgres` | `postgres:16-bookworm` | Projects, storyboards, jobs, asset metadata                                  |
| `redis`    | `redis:7-alpine`       | Job queues (append-only file persistence)                                    |

Every container runs as the TrueNAS **apps** user (**UID/GID 568**) with all Linux capabilities dropped and `no-new-privileges`; none is privileged.

In the paths below, replace `tank` with your pool name.

---

## 1. Create the datasets

1. Go to **Datasets**, select your pool, then **Add Dataset**.
   - Name: `apps` (skip this if you already have an `apps` parent dataset).
2. Select `apps`, then **Add Dataset**:
   - Name: `video-studio`.
   - Dataset Preset: **Apps**.
3. Inside `video-studio`, create four child datasets (preset **Apps**, or **Generic**):

   | Dataset                 | Mounted at                 | Contents                                                             |
   | ----------------------- | -------------------------- | -------------------------------------------------------------------- |
   | `video-studio/data`     | `/data`                    | Uploads, references, generated clips, audio, previews, exports, temp |
   | `video-studio/postgres` | `/var/lib/postgresql/data` | Database files                                                       |
   | `video-studio/redis`    | `/data` in Redis           | Queue persistence                                                    |
   | `video-studio/config`   | (not mounted)              | `studio.env` configuration file                                      |

Separate datasets let you snapshot, replicate and apply quotas to media and database independently. Consider a quota on `data`, because generated video adds up quickly.

## 2. Set folder permissions

Every container runs as **568:568**, so the datasets must be writable by that user.

**Using the UI:** for `data`, `postgres` and `redis`, choose **Datasets → dataset → Permissions → Edit**. Set **User** to `apps` and **Group** to `apps`, tick **Apply User** / **Apply Group** and **Apply permissions recursively**, then **Save**.

**Using the shell:** open **System → Shell**, or SSH in as an admin user.

```bash
sudo chown -R 568:568 /mnt/tank/apps/video-studio/{data,postgres,redis}
sudo chmod 750 /mnt/tank/apps/video-studio/{data,postgres,redis}
```

The `config` dataset holds secrets, so keep it root-only (step 3).

> If a dataset uses an **NFSv4 ACL**, make sure the ACL grants `apps` (568) _modify_ permission as well as owning the directory. Postgres refuses to start when it cannot create its own `pgdata` folder.

## 3. Create the configuration file

```bash
sudo mkdir -p /mnt/tank/apps/video-studio/config
sudo nano /mnt/tank/apps/video-studio/config/studio.env      # paste .env.example and edit
sudo chmod 600 /mnt/tank/apps/video-studio/config/studio.env
```

Settings you must set:

| Setting                         | Value                                                                                                                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`                       | The HTTPS URL your reverse proxy serves, e.g. `https://studio.example.com`. Used for Secure cookies and CSRF origin checks. |
| `ALLOWED_ORIGINS`               | Any other URL you open the studio from, e.g. `http://192.168.1.10:3000`. Comma-separated.                                   |
| `TRUST_PROXY`                   | `true` when behind a reverse proxy, so rate limiting uses the real client IP.                                               |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The first administrator. Password must be at least 10 characters.                                                           |
| `SESSION_SECRET`                | `openssl rand -hex 32`. **Keep it stable**: it also encrypts API keys saved in Settings.                                    |
| `POSTGRES_PASSWORD`             | A long random password.                                                                                                     |
| `DATABASE_URL`                  | `postgres://studio:<POSTGRES_PASSWORD>@postgres:5432/studio`. The password must match.                                      |
| `REDIS_URL`                     | `redis://redis:6379`                                                                                                        |
| `PUID` / `PGID`                 | `568`                                                                                                                       |
| `MOCK_PROVIDERS`                | `true` for a dry run with no paid API calls; `false` for real generation                                                    |
| API keys / model IDs            | See [docs/PROVIDERS.md](docs/PROVIDERS.md). You can also add keys later in **Settings**.                                    |

## 4. Get the container images

A Custom App installed from YAML cannot build from source, so the images must exist somewhere TrueNAS can pull from, or already be loaded on the NAS.

**Option A (recommended): GitHub Container Registry, built automatically**

1. Push this repository to GitHub.
2. The included workflow (`.github/workflows/build.yml`) runs all tests. It then publishes `ghcr.io/<owner>/video-studio-web` and `ghcr.io/<owner>/video-studio-worker`, tagged `latest`, `sha-xxxx`, and `x.y.z` for `vX.Y.Z` git tags.
3. Make the two packages public (GitHub → Packages → Package settings → Change visibility). If you keep them private, add a registry credential in TrueNAS instead: **Apps → Configuration → Manage Container Image Registries → Add**, with `ghcr.io`, your username, and a PAT with `read:packages`.

**Option B: build on the NAS**

```bash
cd /mnt/tank/apps/video-studio
sudo git clone https://github.com/<you>/<repo>.git src && cd src
sudo docker build --target web    -t video-studio-web:1.0.0 .
sudo docker build --target worker -t video-studio-worker:1.0.0 .
```

Then use `video-studio-web:1.0.0` and `video-studio-worker:1.0.0` as the image names in the YAML.

**Option C: build elsewhere and copy**

```bash
docker build --target web -t video-studio-web:1.0.0 . && docker build --target worker -t video-studio-worker:1.0.0 .
docker save video-studio-web:1.0.0 video-studio-worker:1.0.0 | gzip | ssh admin@truenas 'gunzip | sudo docker load'
```

## 5. Install the app

1. Open `docker-compose.truenas.yml` and replace:
   - `/mnt/tank/apps/video-studio` with your dataset path (it appears in several places).
   - `ghcr.io/OWNER/...` with your image names.
   - `"3000:3000"` with `"<host-port>:3000"` if port 3000 is taken.
   - Optionally, the `deploy.resources.limits` CPU and memory values. The worker is set to 4 CPUs and 4 GB; FFmpeg is the heavy part. Rendering also honours `FFMPEG_THREADS` and `RENDER_CONCURRENCY` from `studio.env`.
2. In TrueNAS go to **Apps → Discover Apps**, open the **⋮** menu, and choose **Install via YAML**.
3. Name the app `video-studio`, paste the edited YAML, and click **Save**.
4. Watch **Apps → Installed → video-studio**. Postgres and Redis become healthy first, `migrate` runs and exits, then `web` and `worker` start and turn healthy. The first start takes 20–60 seconds.

## 6. Reverse proxy (HTTPS)

Point your proxy at `http://<truenas-ip>:<host-port>`. The settings that matter:

- **Large uploads:** allow request bodies up to `MAX_UPLOAD_MB`. In Nginx or Nginx Proxy Manager, use `client_max_body_size 1024m;` and `proxy_request_buffering off;`.
- **Long requests:** `proxy_read_timeout 300s;`. Generation and rendering run in the background, but uploads and downloads can be long.
- Forward the `X-Forwarded-For` and `X-Forwarded-Proto` headers. Proxies do this by default.

**Nginx Proxy Manager:** add a Proxy Host for your domain, forward it to the TrueNAS IP and port, request an SSL certificate, and enable **Force SSL**. Under **Advanced**, add:

```nginx
client_max_body_size 1024m;
proxy_request_buffering off;
proxy_read_timeout 300s;
```

**Caddy:**

```caddy
studio.example.com {
  request_body { max_size 1GB }
  reverse_proxy 192.168.1.10:3000
}
```

**Traefik:** add a router for `studio.example.com` with TLS, pointing at a service on `http://192.168.1.10:3000`. If you use a buffering middleware, raise its `maxRequestBodyBytes`.

Set `APP_URL` to the exact public HTTPS URL. If you also open the studio directly by LAN IP, add that URL to `ALLOWED_ORIGINS`. Otherwise changes made from it are rejected by the CSRF protection.

## 7. First login

1. Open `APP_URL` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
2. Go to **Settings** and check that the worker shows **online** and an FFmpeg version is listed.
3. Optionally remove `ADMIN_PASSWORD` from `studio.env`. It is only used to create the first account. To reset a forgotten password, set `ADMIN_PASSWORD` to a new value and `ADMIN_RESET_PASSWORD=true`, restart the app, then set `ADMIN_RESET_PASSWORD=false` again.

## 8. Configure API keys

Keys can be set in either place:

- **In `studio.env`.** These take precedence and are shown as "(env)" in Settings.
- **In Settings → paste key → Save.** Keys are stored AES-256-GCM encrypted in Postgres, using a key derived from `SESSION_SECRET`.

Keys are never sent to the browser; only a masked form such as `sk-…abcd` is shown. Use **Test connection** on each provider card to confirm. Set the model IDs, especially `GOOGLE_VIDEO_MODEL`, as described in [docs/PROVIDERS.md](docs/PROVIDERS.md).

If you change `SESSION_SECRET`, keys saved in Settings can no longer be decrypted; re-enter them. All sessions also end.

## 9. Updating

Database migrations run automatically on every start (the `migrate` service), before `web` and `worker` start.

- **Images tagged `latest` (Option A):** Apps → **video-studio** → **Update** when TrueNAS shows one is available. Or open **Edit**, then **Save** to redeploy, which pulls newer images.
- **Pinned versions (recommended):** publish a new git tag such as `v1.1.0`, then **Edit** the app YAML, change both image tags to `:1.1.0`, and **Save**.
- **Built on the NAS (Option B):** `git pull`, rebuild with a new tag, update the tags in the YAML, and **Save**.

Running generation jobs survive an update (see _Reliability_ in [ARCHITECTURE.md](ARCHITECTURE.md)). A render that was mid-encode restarts from the beginning.

## 10. Backup and restore

What to protect:

| Data                                                  | Where                            | How                                             |
| ----------------------------------------------------- | -------------------------------- | ----------------------------------------------- |
| Uploaded assets, generated clips, exports             | `video-studio/data`              | ZFS snapshots and replication                   |
| Projects, storyboards, jobs, settings, encrypted keys | `video-studio/postgres`          | `pg_dump`, plus snapshots                       |
| Queue state                                           | `video-studio/redis`             | Optional; jobs are also tracked in Postgres     |
| Configuration and secrets                             | `video-studio/config/studio.env` | Snapshots, plus a copy in your password manager |

**Snapshots:** go to **Data Protection → Periodic Snapshot Tasks → Add**, select dataset `tank/apps/video-studio`, tick **Recursive**, and choose a schedule and lifetime (e.g. hourly, kept for 2 weeks). Add a **Replication Task** to another pool or machine for off-box copies.

**Consistent database dumps:** go to **System → Advanced → Cron Jobs → Add**, run as `root`, daily:

```bash
mkdir -p /mnt/tank/apps/video-studio/backups && \
docker exec $(docker ps -qf name=video-studio-postgres) pg_dump -U studio -Fc studio \
  > /mnt/tank/apps/video-studio/backups/studio-$(date +\%F).dump && \
find /mnt/tank/apps/video-studio/backups -name 'studio-*.dump' -mtime +30 -delete
```

**Restore from a snapshot (whole app):**

1. Apps → video-studio → **Stop**.
2. Datasets → `video-studio` → Snapshots → select the snapshot → **Rollback**. Do this for `data` and `postgres`, from the same time.
3. **Start** the app.

**Restore only the database from a dump:**

```bash
# App running; replace the date
docker exec -i $(docker ps -qf name=video-studio-postgres) pg_restore -U studio -d studio --clean --if-exists \
  < /mnt/tank/apps/video-studio/backups/studio-2026-09-30.dump
```

Then restart the app so the worker re-reads job state. Media files in `data/` are referenced by path from the database, so restore `data` and `postgres` from matching points in time.

## 11. Viewing logs

- **In the UI:** Apps → **video-studio** → **Workloads**. Each container has a logs icon.
- **In the shell:**

  ```bash
  docker ps --filter name=video-studio                # container names
  docker logs -f --tail 200 ix-video-studio-worker-1   # jobs, FFmpeg, provider calls
  docker logs -f --tail 200 ix-video-studio-web-1      # API requests / errors
  docker logs ix-video-studio-migrate-1                # migrations + admin bootstrap
  ```

Logs are JSON (pino). API keys and bearer tokens are redacted. Set `LOG_LEVEL=debug` in `studio.env` for more detail.

## 12. Troubleshooting failed generation jobs

Start in the UI:

- **Dashboard → Needs attention** lists failed jobs with their error message and a **Retry** button.
- **Storyboard:** a failed scene shows the provider's error. Fix the prompt, provider or key, then click **Regenerate**.
- **Settings:** shows provider connection tests, worker heartbeat, queue counts (waiting, active, failed) and usage.

For causes and fixes, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Health checks

| Service  | Check                                                             |
| -------- | ----------------------------------------------------------------- |
| web      | `GET /api/health` (DB + Redis; also reports the worker heartbeat) |
| worker   | `GET :3001/health` (DB + Redis)                                   |
| postgres | `pg_isready`                                                      |
| redis    | `redis-cli ping`                                                  |

All long-running services use `restart: unless-stopped`.
