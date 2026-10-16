# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/web/Dockerfile .
ARG NODE_IMAGE=node:22.22.2-bookworm-slim

FROM ${NODE_IMAGE} AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs tsconfig.base.json ./
COPY packages/db packages/db
COPY packages/shared packages/shared
COPY packages/i18n packages/i18n
COPY apps/web apps/web
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @defe2end/web...
RUN pnpm --filter @defe2end/db run generate && pnpm --filter @defe2end/web... run build
# Admin CLI: its own few packages (pg and @prisma/client come from the standalone output below).
RUN node apps/web/cli/stage.mjs /repo/cli-runtime

FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
# Standalone output leaves public/ out; it holds the self-hosted Korean font slices.
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
# Admin CLI for emergency recovery: `docker compose exec web defe2end admin …` (docs/admin-recovery.md).
# Link pg and @prisma/client to the copies Next traced for the server, then fail the build if any import is missing.
COPY --from=build --chown=node:node /repo/cli-runtime ./apps/web/cli
RUN set -e; cd /app/apps/web/cli/node_modules; \
    ln -s /app/node_modules/.pnpm/node_modules/pg pg; \
    client=$(ls -d /app/node_modules/.pnpm/@prisma+client@*/node_modules/@prisma/client); \
    test "$(echo "$client" | wc -l)" -eq 1; ln -s "$client" @prisma/client; \
    node --input-type=module -e 'await import("/app/apps/web/cli/defe2end.mjs")'; \
    printf '#!/bin/sh\nexec node /app/apps/web/cli/defe2end.mjs "$@"\n' > /usr/local/bin/defe2end; \
    chmod +x /usr/local/bin/defe2end
# Run files (STORAGE_DIR), shared with the worker through a volume.
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
