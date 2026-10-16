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
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
CMD ["node_modules/.bin/prisma", "migrate", "deploy"]
