# syntax=docker/dockerfile:1.7
# Multi-target image: `web`, `worker` (also used for the one-shot `migrate`
# service) and `test` (dev dependencies + FFmpeg for the test suite).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
RUN npm ci

# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
RUN npm run build -w @studio/worker && npm run build -w @studio/web

# ---------------------------------------------------------------------------
# Production node_modules for the worker (only @studio/core runtime deps).
FROM base AS worker-deps
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
RUN npm ci --omit=dev --workspace @studio/worker --include-workspace-root=false

# ---------------------------------------------------------------------------
# Media tooling shared by the worker and test images.
FROM base AS media
ARG MONTSERRAT_VERSION=v7.222
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg fontconfig poppler-utils tini ca-certificates curl \
      fonts-dejavu-core fonts-liberation2 fonts-roboto-unhinted fonts-open-sans \
      fonts-lato fonts-noto-core fonts-league-spartan \
 && mkdir -p /usr/share/fonts/truetype/montserrat \
 && for w in Regular Medium SemiBold Bold ExtraBold Black; do \
      curl -fsSL -o /usr/share/fonts/truetype/montserrat/Montserrat-$w.ttf \
        "https://github.com/JulietaUla/Montserrat/raw/${MONTSERRAT_VERSION}/fonts/ttf/Montserrat-$w.ttf"; \
    done \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f \
 && fc-list | grep -qi montserrat

# ---------------------------------------------------------------------------
FROM media AS worker
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/drizzle \
    WORKER_HEALTH_PORT=3001
COPY --from=worker-deps /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/packages/core/drizzle ./drizzle
COPY apps/worker/package.json ./apps/worker/package.json
COPY package.json ./package.json
# Containers run as a configurable non-root user (TrueNAS: 568). HOME must be writable for fontconfig.
ENV HOME=/tmp
USER 1000:1000
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "apps/worker/dist/healthcheck.js"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/worker/dist/index.js"]

# ---------------------------------------------------------------------------
FROM base AS web
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HOME=/tmp \
    FONTS_DIR=/app/fonts
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
# Caption/brand fonts (the same files the worker renders with) for live previews.
COPY --from=media /usr/share/fonts/truetype/montserrat/Montserrat-Regular.ttf /app/fonts/montserrat-regular.ttf
COPY --from=media /usr/share/fonts/truetype/montserrat/Montserrat-Bold.ttf /app/fonts/montserrat-bold.ttf
COPY --from=media /usr/share/fonts/opentype/league-spartan/LeagueSpartan-Medium.otf /app/fonts/league-spartan-regular.otf
COPY --from=media /usr/share/fonts/opentype/league-spartan/LeagueSpartan-Bold.otf /app/fonts/league-spartan-bold.otf
COPY --from=media /usr/share/fonts/truetype/roboto/unhinted/RobotoTTF/Roboto-Regular.ttf /app/fonts/roboto-regular.ttf
COPY --from=media /usr/share/fonts/truetype/roboto/unhinted/RobotoTTF/Roboto-Bold.ttf /app/fonts/roboto-bold.ttf
COPY --from=media /usr/share/fonts/truetype/open-sans/OpenSans-Regular.ttf /app/fonts/open-sans-regular.ttf
COPY --from=media /usr/share/fonts/truetype/open-sans/OpenSans-Bold.ttf /app/fonts/open-sans-bold.ttf
COPY --from=media /usr/share/fonts/truetype/lato/Lato-Regular.ttf /app/fonts/lato-regular.ttf
COPY --from=media /usr/share/fonts/truetype/lato/Lato-Bold.ttf /app/fonts/lato-bold.ttf
COPY --from=media /usr/share/fonts/truetype/noto/NotoSans-Regular.ttf /app/fonts/noto-sans-regular.ttf
COPY --from=media /usr/share/fonts/truetype/noto/NotoSans-Bold.ttf /app/fonts/noto-sans-bold.ttf
COPY --from=media /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf /app/fonts/dejavu-sans-regular.ttf
COPY --from=media /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf /app/fonts/dejavu-sans-bold.ttf
COPY --from=media /usr/share/fonts/truetype/liberation2/LiberationSerif-Regular.ttf /app/fonts/liberation-serif-regular.ttf
COPY --from=media /usr/share/fonts/truetype/liberation2/LiberationSerif-Bold.ttf /app/fonts/liberation-serif-bold.ttf
# Next.js may write to .next/cache at runtime; allow any (non-root) UID to do so.
RUN mkdir -p apps/web/.next/cache && chmod -R 0777 apps/web/.next/cache
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------------------
FROM media AS test
COPY --from=build /app /app
ENV HOME=/tmp
CMD ["sh", "-c", "npx vitest run --project unit && npx vitest run --project integration --no-file-parallelism && npx vitest run --project ffmpeg --no-file-parallelism"]
