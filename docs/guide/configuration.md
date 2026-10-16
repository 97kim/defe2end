# Configuration

All settings are environment variables. With the example compose file you put them in `deploy/.env`; compose passes them to the containers. After a change, run `docker compose up -d` again.

"Service" says which container reads the variable. Required variables have no default; the container refuses to start without them.

This table is checked against the code by a test (`packages/shared/src/env-docs.test.ts`): every variable the server code or the compose file reads must be listed here, and nothing else.

## Compose and database

| Variable | Service | Required | Default | Description |
|---|---|---|---|---|
| `DEFE2END_VERSION` | compose | yes | — | Image version to run, for example `1.0.0`. Pins `web`, `worker` and `migrate` to the same release. |
| `WEB_PORT` | compose | no | `3000` | Host port for the web UI and API. |
| `POSTGRES_USER` | compose | no | `defe2end` | Database user for the bundled Postgres. |
| `POSTGRES_PASSWORD` | compose | yes | — | Database password. |
| `POSTGRES_DB` | compose | no | `defe2end` | Database name. |
| `DATABASE_URL` | web, worker, migrate | yes | built by compose | Postgres connection string. Compose builds it from the three values above. Set it yourself to use an external Postgres. |
| `STORAGE_DIR` | web, worker, migrate | no | `./data/storage` (compose: `/data/storage`) | Folder for screenshots, videos and other run files. `web`, `worker` and `migrate` (for backup and restore) must share it. |

## Security and sign-in

| Variable | Service | Required | Default | Description |
|---|---|---|---|---|
| `DEFE2END_ENCRYPTION_KEY` | web, worker, migrate | yes | — | Base64 of exactly 32 bytes (`openssl rand -base64 32`). Encrypts secret variables. Keep it apart from backups; the web server refuses to start if it differs from the key the database was set up with. |
| `BETTER_AUTH_SECRET` | web | yes | — | Session signing secret, at least 32 characters. |
| `BETTER_AUTH_URL` | web | no | `http://localhost:3000` | URL users open (scheme, host, port). Used for sign-in callbacks, setup and reset links. Cookies are `Secure` when it is https. |
| `PUBLIC_URL` | web, worker | no | — | Public URL used in links sent outside the UI: Slack messages, daily reports and `url` in `/api/v1` responses. Without it those links are left out. Usually the same as `BETTER_AUTH_URL`. |
| `OIDC_DISCOVERY_URL` | web | no | — | OpenID Connect discovery URL (`…/.well-known/openid-configuration`). OIDC sign-in turns on when this and `OIDC_CLIENT_ID` are set. Redirect URI: `<BETTER_AUTH_URL>/api/auth/oauth2/callback/oidc`. |
| `OIDC_CLIENT_ID` | web | no | — | OIDC client id. |
| `OIDC_CLIENT_SECRET` | web | no | — | OIDC client secret. |
| `OIDC_PROVIDER_NAME` | web | no | `OIDC` | Label on the sign-in button. |
| `GITHUB_CLIENT_ID` | web | no | — | GitHub OAuth app client id. GitHub sign-in turns on when both GitHub values are set. Callback URL: `<BETTER_AUTH_URL>/api/auth/callback/github`. |
| `GITHUB_CLIENT_SECRET` | web | no | — | GitHub OAuth app client secret. |

## Desktop app

| Variable | Service | Required | Default | Description |
|---|---|---|---|---|
| `DESKTOP_MIN_VERSION` | web | no | `0.0.0` | Oldest desktop app version the server accepts. Older apps are asked to update. |
| `DESKTOP_DOWNLOAD_URL` | web | no | — | Download page shown to apps that are too old. |
| `DESKTOP_EXTRA_AUTH_ORIGINS` | web | no | — | Comma-separated origins the app's main window may open during external sign-in, in addition to the OIDC and GitHub origins found automatically. |

## Runs and limits

| Variable | Service | Required | Default | Description |
|---|---|---|---|---|
| `WORKER_ID` | worker | no | hostname + pid | Worker name in run records. |
| `HEARTBEAT_INTERVAL_MS` | worker | no | `10000` | How often a worker records a heartbeat (min 1000). |
| `RUN_LEASE_MS` | worker | no | `30000` | A run whose worker misses heartbeats this long is taken back. At least twice the heartbeat. |
| `POLL_INTERVAL_MS` | worker | no | `1000` | How often the worker looks for queued runs (min 50). |
| `CANCEL_POLL_INTERVAL_MS` | worker | no | `1000` | How often the worker checks for cancel requests (min 50). |
| `CLAIM_LOCK_TIMEOUT_MS` | worker | no | `3000` | Longest wait for the queue lock per claim round (min 100). |
| `MAINTENANCE_INTERVAL_MS` | worker | no | `600000` | How often temp files, orphaned files and expired test runs are cleaned up (min 1000). |
| `WORKER_CONCURRENCY` | worker | no | `2` | Runs one worker executes at once. |
| `MAX_CONCURRENT_RUNS` | worker | no | `4` | Runs across all workers at once. |
| `WORKSPACE_CONCURRENCY` | worker | no | `4` | Runs per workspace at once. |
| `RUN_TIMEOUT_MS` | web, worker | no | `900000` | A run is stopped after this long (min 1000). `web` uses it for runs sent to the desktop app. |
| `RUN_RETRY_ATTEMPTS` | web, worker | no | `2` | Whole-run attempts including the first, for scenarios that allow retry. `1` = no retry. |
| `MIN_FREE_DISK_MB` | web, worker | no | `1024` | Below this much free disk, the worker takes no new run and the web server refuses new runs (`503 storage_low`). |
| `SHUTDOWN_GRACE_MS` | worker | no | `30000` | On shutdown, running runs get this long to finish. Keep it below the compose `stop_grace_period` (45s). |
| `BLOCK_PRIVATE_NETWORKS` | worker | no | `false` | `true` = scenarios can't reach private, loopback or link-local addresses. |
| `CHROMIUM_SANDBOX` | worker | no | `true` | Chromium's sandbox. Turn off only on a host that can't provide user namespaces. |
| `ATTACHMENT_MAX_MB` | web | no | `20` | Largest upload file for file-upload steps. |
| `ATTACHMENT_WORKSPACE_MAX_MB` | web | no | `500` | Total upload files per workspace. |
| `SSE_MAX_CONNECTIONS_PER_USER` | web | no | `8` | Live progress connections one user may hold open. |

## Internal

Set by the runtime or the build. Don't set these yourself.

| Variable | Service | Required | Default | Description |
|---|---|---|---|---|
| `NEXT_RUNTIME` | web | — | — | Set by Next.js. |
| `NEXT_DIST_DIR` | web | — | `.next` | Build output folder, used by tests. |

## File storage

Run files live in `STORAGE_DIR` on a local volume (`run-files` in the example compose file). S3-compatible storage is not available in 1.0.
