# syntax=docker/dockerfile:1
#
# Production images for Vamos Betting: api, worker, scraper, web (apps/web/server.mjs) and admin.
# One Dockerfile, one target per service. Build from the repository root:
#
#   docker build -f infra/docker/Dockerfile --target api    -t vamos-api .
#   docker build -f infra/docker/Dockerfile --target worker -t vamos-worker .
#   docker build -f infra/docker/Dockerfile --target scraper -t vamos-scraper .
#   docker build -f infra/docker/Dockerfile --target web    -t vamos-web   --build-arg NEXT_PUBLIC_API_URL=https://api.example.et .
#   docker build -f infra/docker/Dockerfile --target admin  -t vamos-admin --build-arg NEXT_PUBLIC_API_URL=https://api.example.et .
#
# (`docker compose -f infra/docker-compose.prod.yml build` does all of it.)
#
# Layout of the stages:
#   fetch     pnpm fetch: downloads the locked packages. Cached until pnpm-lock.yaml changes.
#   build-*   full install (offline from the fetched store) and the app builds.
#   deps-*    production-only install of one service's dependencies (pnpm install --prod).
#   api, worker, scraper, web, admin   minimal runtime images (node:22-alpine, non-root user `node`).
#
# The api, worker and scraper are bundled by tsup (the @vamos/* packages are inlined, and so is
# cheerio, which only packages/scraper uses), so their images carry only dist/ and the npm packages
# that stay external (the scraper: drizzle-orm, ioredis, pg, pino, zod). The api image also carries the operations
# scripts (migrate, seed, admin-create, admin-unlock, totp-rekey) in dist/ops and the SQL migrations in
# dist/migrations: the compose `migrate` job is this image with another command.
#
# Behind a TLS-intercepting proxy, pass its CA to the install steps:
#   docker build --secret id=extra-ca,src=/path/to/ca.pem ...

ARG NODE_VERSION=22
ARG PNPM_VERSION=10.28.0

# ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=true \
    npm_config_store_dir=/pnpm/store \
    npm_config_update_notifier=false
RUN --mount=type=secret,id=extra-ca \
    if [ -s /run/secrets/extra-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi; \
    npm install --global "pnpm@${PNPM_VERSION}"
WORKDIR /app

# ---------------------------------------------------------------------------------------------
# Only the lockfile: this layer is rebuilt when dependencies change, not when sources do.
# (`pnpm fetch` also fills a virtual store in node_modules; drop it, the installs below rebuild it
# per service and must not inherit every package.)
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=secret,id=extra-ca \
    if [ -s /run/secrets/extra-ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra-ca; fi; \
    pnpm fetch \
    && rm -rf node_modules

# The workspace manifests (package.json of every project): enough for `pnpm install --offline`.
FROM fetch AS manifests
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/scraper/package.json apps/scraper/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/feed/package.json packages/feed/package.json
COPY packages/i18n/package.json packages/i18n/package.json
COPY packages/payments/package.json packages/payments/package.json
COPY packages/scraper/package.json packages/scraper/package.json
COPY e2e/package.json e2e/package.json

# ---------------------------------------------------------------------------------------------
# Production-only dependencies per service (workspace packages are linked, not copied: the api and
# worker bundles inline them; the Next.js apps compile them with `transpilePackages`).
FROM manifests AS deps-api
RUN pnpm install --offline --frozen-lockfile --prod --filter "@vamos/api..."

FROM manifests AS deps-worker
RUN pnpm install --offline --frozen-lockfile --prod --filter "@vamos/worker..."

FROM manifests AS deps-scraper
RUN pnpm install --offline --frozen-lockfile --prod --filter "@vamos/scraper-app..."

FROM manifests AS deps-web
RUN pnpm install --offline --frozen-lockfile --prod --filter "@vamos/web..."
# Alpine is musl: drop the glibc builds of Next's compiler and sharp that pnpm also installs.
RUN cd node_modules/.pnpm && rm -rf @next+swc-linux-*-gnu@* \
    @img+sharp-libvips-linux-x64@* @img+sharp-libvips-linux-arm64@* \
    @img+sharp-linux-x64@* @img+sharp-linux-arm64@*

FROM manifests AS deps-admin
RUN pnpm install --offline --frozen-lockfile --prod --filter "@vamos/admin..."
# Alpine is musl: drop the glibc builds of Next's compiler and sharp that pnpm also installs.
RUN cd node_modules/.pnpm && rm -rf @next+swc-linux-*-gnu@* \
    @img+sharp-libvips-linux-x64@* @img+sharp-libvips-linux-arm64@* \
    @img+sharp-linux-x64@* @img+sharp-linux-arm64@*

# ---------------------------------------------------------------------------------------------
# Full install and builds.
FROM manifests AS build
RUN pnpm install --offline --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps

FROM build AS build-server
RUN pnpm --filter @vamos/api --filter @vamos/worker build \
    && pnpm --filter @vamos/api exec tsup --config tsup.ops.config.ts \
    && cp -r packages/db/migrations apps/api/dist/migrations

FROM build AS build-scraper
RUN pnpm --filter @vamos/scraper-app build

FROM build AS build-web
# Inlined into the browser bundle at build time: the public URL of the API.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN test -n "$NEXT_PUBLIC_API_URL" || { echo "build-arg NEXT_PUBLIC_API_URL is required (https://api.example.et)" >&2; exit 1; }
RUN pnpm --filter @vamos/web build

FROM build AS build-admin
ARG NEXT_PUBLIC_API_URL
# `licensed` hides the demo banner; the API's own mode is what counts.
ARG NEXT_PUBLIC_OPERATING_MODE=demo
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_OPERATING_MODE=${NEXT_PUBLIC_OPERATING_MODE}
RUN test -n "$NEXT_PUBLIC_API_URL" || { echo "build-arg NEXT_PUBLIC_API_URL is required (https://api.example.et)" >&2; exit 1; }
RUN pnpm --filter @vamos/admin build

# ---------------------------------------------------------------------------------------------
# Runtime images.
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
       /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-*
USER node

# api and worker: the code belongs to root, like web and admin, so the app user can read but never
# change it (compose also runs them with read-only root filesystems).
FROM runtime AS api
ENV API_HOST=0.0.0.0 API_PORT=4000
COPY package.json pnpm-workspace.yaml ./
COPY --from=deps-api /app/node_modules ./node_modules
COPY --from=deps-api /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build-server /app/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/package.json
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=4 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${API_PORT}/health" || exit 1
CMD ["node", "dist/server.js"]

FROM runtime AS worker
ENV WORKER_HEALTH_HOST=0.0.0.0 WORKER_HEALTH_PORT=4100
COPY package.json pnpm-workspace.yaml ./
COPY --from=deps-worker /app/node_modules ./node_modules
COPY --from=deps-worker /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build-server /app/apps/worker/dist ./apps/worker/dist
COPY apps/worker/package.json ./apps/worker/package.json
WORKDIR /app/apps/worker
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=4 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${WORKER_HEALTH_PORT}/health" || exit 1
CMD ["node", "dist/main.js"]

# scraper: like the worker, plus the raw snapshot archive (SCRAPER_ARCHIVE_DIR). Compose mounts the
# `scraper_archive` volume there; a new named volume takes the owner of this directory (the app user).
FROM runtime AS scraper
ENV SCRAPER_PORT=4200 SCRAPER_ARCHIVE_DIR=/var/lib/vamos/scraper
COPY package.json pnpm-workspace.yaml ./
COPY --from=deps-scraper /app/node_modules ./node_modules
COPY --from=deps-scraper /app/apps/scraper/node_modules ./apps/scraper/node_modules
COPY --from=build-scraper /app/apps/scraper/dist ./apps/scraper/dist
COPY apps/scraper/package.json ./apps/scraper/package.json
USER root
RUN mkdir -p /var/lib/vamos/scraper && chown node:node /var/lib/vamos/scraper
USER node
WORKDIR /app/apps/scraper
EXPOSE 4200
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=4 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${SCRAPER_PORT}/health" || exit 1
CMD ["node", "dist/main.js"]

# web and admin: the code belongs to root, so the app user cannot change it; only Next's cache
# directory is the app user's (compose also runs them read-only with a tmpfs there).
FROM runtime AS web
ENV PORT=3000
COPY package.json pnpm-workspace.yaml ./
COPY --from=deps-web /app/node_modules ./node_modules
COPY --from=deps-web /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build-web /app/apps/web/.next ./apps/web/.next
COPY apps/web/package.json apps/web/next.config.ts apps/web/server.mjs ./apps/web/
COPY apps/web/public ./apps/web/public
USER root
RUN rm -rf /app/apps/web/.next/cache && mkdir /app/apps/web/.next/cache \
    && chown node:node /app/apps/web/.next/cache
USER node
WORKDIR /app/apps/web
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/" || exit 1
CMD ["node", "server.mjs"]

FROM runtime AS admin
ENV PORT=3001
COPY package.json pnpm-workspace.yaml ./
COPY --from=deps-admin /app/node_modules ./node_modules
COPY --from=deps-admin /app/apps/admin/node_modules ./apps/admin/node_modules
COPY --from=build-admin /app/apps/admin/.next ./apps/admin/.next
COPY apps/admin/package.json apps/admin/next.config.ts ./apps/admin/
USER root
RUN rm -rf /app/apps/admin/.next/cache && mkdir /app/apps/admin/.next/cache \
    && chown node:node /app/apps/admin/.next/cache
USER node
WORKDIR /app/apps/admin
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/login" || exit 1
CMD ["node", "node_modules/next/dist/bin/next", "start", "--port", "3001"]
