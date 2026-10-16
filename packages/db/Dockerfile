# syntax=docker/dockerfile:1
# One-shot migration image: applies pending migrations and exits.
# Build from the repo root: docker build -f packages/db/Dockerfile .
ARG NODE_IMAGE=node:22.22.2-bookworm-slim

FROM ${NODE_IMAGE} AS base
# Prisma's schema engine needs OpenSSL (detected at install and at run time).
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/db packages/db
# db depends on shared (workspace package); migrate never imports it, but pnpm deploy needs it to resolve.
COPY packages/shared packages/shared
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @defe2end/db deploy /out

FROM base
# backup/restore (ops/cli.mjs) need a PostgreSQL client that matches the server (postgres 18 in the compose example).
ARG PG_CLIENT_MAJOR=18
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-${PG_CLIENT_MAJOR} \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data/storage && chown node:node /data/storage
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# `backup <dir>` and `restore <dir>`: docker compose run --rm migrate backup /backup
ENV PATH=/app/ops/bin:$PATH
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]
