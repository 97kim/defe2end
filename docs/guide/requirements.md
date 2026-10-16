# Requirements

> The sizes below are **estimates**. They have not been measured on a reference install yet.

## Server

| | Minimum (estimate) | Notes |
|---|---|---|
| CPU | 2 vCPU | Each concurrent run uses about one core while Chromium renders. |
| Memory | 4 GB | About 0.5–1 GB per concurrent run, plus Postgres and the web server. Raise with `WORKER_CONCURRENCY`. |
| Disk | 20 GB free | Screenshots and videos grow with use. The worker stops taking runs below `MIN_FREE_DISK_MB` (default 1024 MB). |
| OS | Linux, amd64 or arm64 | Docker Engine with Compose v2.3+. The worker needs user namespaces for Chromium's sandbox (see [troubleshooting.md](troubleshooting.md)). |
| Postgres | 18 (bundled) | An external Postgres works via `DATABASE_URL`. |

Supported in 1.0: Chromium only, one worker instance. More workers can run, but are not part of what 1.0 is tested with.

## Desktop app

| | Minimum (estimate) |
|---|---|
| macOS | Apple Silicon or Intel, a currently supported macOS release |
| Windows | Windows 10 or 11, x64 |
| Memory | 8 GB |
| Disk | 1 GB for the app and its bundled Chromium |

## AI (optional)

Claude Code 2.1.300+ or Codex CLI 0.162.1+ on the same PC as the desktop app. See [ai.md](ai.md).
