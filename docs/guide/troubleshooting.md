# Troubleshooting

Start with the logs: `docker compose logs web worker migrate`.

## The web server exits right after start

- `BETTER_AUTH_SECRET must be set to at least 32 characters`: generate one with `openssl rand -base64 32`.
- `DEFE2END_ENCRYPTION_KEY must be base64 of exactly 32 bytes`: generate one the same way.
- The key differs from the one the database was set up with: use the original key. If it is truly lost, you need a fresh database (or accept losing secret values after a restore).

## `web` or `worker` exits: migrations don't match

The database's migrations differ from the ones the image knows, usually because the images run different versions. Run `web`, `worker` and `migrate` at the same `DEFE2END_VERSION` ([upgrade.md](upgrade.md)).

## `web` or `worker` exits: a restore is in progress

A restore stopped halfway. Empty the database and storage and restore again ([backup-restore.md](backup-restore.md)).

## Schedules don't fire after a restore

Automation is paused after a restore. Resume it with `docker compose run --rm --no-deps migrate resume-automation` ([backup-restore.md](backup-restore.md#automation-is-paused-after-a-restore)).

## `migrate` fails

The database isn't reachable or a migration failed. Check `docker compose logs migrate`. `web` and `worker` wait for `migrate` to succeed. If you upgraded, check the release notes for required intermediate versions.

## I can't find the setup link

`docker compose logs web | grep setup`. A new link is printed on every start until the first admin exists. If an admin exists and you lost access, see [../admin-recovery.md](../admin-recovery.md).

## Sign-in redirects to the wrong address

`BETTER_AUTH_URL` must be exactly the URL users open, including `https://` and the port. Restart `web` after changing it. For OIDC and GitHub, the callback URL registered at the provider must use the same base.

## Runs stay queued

- After a restore, automation is paused until you resume it.

- Is `worker` running? `docker compose ps`.
- Free disk below `MIN_FREE_DISK_MB`: the worker takes no new runs.
- Concurrency limits (`WORKER_CONCURRENCY`, `MAX_CONCURRENT_RUNS`, `WORKSPACE_CONCURRENCY`) are full.

## Chromium fails to start in the worker

The worker keeps Chromium's sandbox on, which needs user namespaces. The example compose file uses `chromium-seccomp.json` for that; keep it next to `docker-compose.yml`. Check with:

```sh
docker compose exec worker node dist/sandbox-check.js
```

If your host can't provide user namespaces, you can set `CHROMIUM_SANDBOX=false`, but scenarios then run without that isolation.

## Live progress doesn't update

Your reverse proxy is buffering server-sent events. Turn off response buffering for the defE2End site.

## Links in Slack or `/api/v1` responses are missing

Set `PUBLIC_URL` in `.env` and run `docker compose up -d` ([configuration.md](configuration.md)).

## The desktop app won't open

See [desktop-app.md](desktop-app.md#install-and-first-launch). If your company policy blocks unsigned apps, ask your IT team.

## MCP tools return `desktop-not-running`

Start the desktop app and sign in. `defe2end-mcp` works only through the running app.

## The AI chat refuses to start

- CLI not found: install it and press "find again" in the app.
- Version too old: update to the minimum in [ai.md](ai.md).
- Sign-in expired: run `claude login` or `codex login` in a terminal.
- "unsafe": the CLI loaded something other than defE2End's tools. Check the CLI for unusual setup, then restart the app.
