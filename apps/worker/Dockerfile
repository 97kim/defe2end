# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/worker/Dockerfile .
ARG NODE_IMAGE=node:22.22.2-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/db packages/db
COPY packages/shared packages/shared
COPY packages/runner packages/runner
COPY packages/test-fixtures packages/test-fixtures
COPY apps/worker apps/worker
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @defe2end/worker...
RUN pnpm --filter @defe2end/db run generate && pnpm --filter @defe2end/worker... run build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @defe2end/worker deploy --prod /out

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
# Chromium lives outside the app so the non-root user can read it and rebuilds of the app layer keep it.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# tini is PID 1: it reaps the browsers' children and, when the worker dies, the container (and every browser
# in it) ends with it (contract section 4.3). Chromium's headless shell and its system libraries are installed
# with the Playwright version the runner uses; nothing else is downloaded at run time.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && node "$(find -L node_modules -path '*/node_modules/playwright/cli.js' | head -n 1)" install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/storage && chown node:node /data/storage
# Non-root, with the Chromium sandbox on (CHROMIUM_SANDBOX defaults to true). The sandbox needs user namespaces,
# which Docker's default seccomp profile refuses; deploy/docker-compose.yml applies deploy/chromium-seccomp.json.
# Check it with: docker compose exec worker node dist/sandbox-check.js
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
