# Install

defE2End runs as three containers next to a Postgres database: `web` (UI and API), `worker` (runs scenarios in Chromium) and `migrate` (one-shot schema update). You run them with Docker Compose on your own server.

## What you need

- A Linux host (amd64 or arm64) with Docker Engine and Docker Compose v2.3 or later. See [requirements.md](requirements.md) for CPU, memory and disk.
- `openssl` (or any tool that prints 32 random bytes as base64) to generate secrets.
- A URL your users can reach. For anything beyond a quick try, put HTTPS in front (see below).

## 1. Get the compose files

Pick a release version (`X.Y.Z`) from the GitHub Releases page. Images are published only under exact version tags (`X.Y.Z`, or `X.Y.Z-rc.N` for release candidates); there is no `X.Y` or `latest` tag. `DEFE2END_VERSION` pins all three images to the same version.

```sh
git clone --depth 1 --branch v1.0.0 https://github.com/97kim/defe2end.git
cd defe2end/deploy
```

You need three files from `deploy/`: `docker-compose.yml`, `chromium-seccomp.json` and `.env.example`. Copying just those to another folder works too.

`docker-compose.yml` runs the published images. To build from source instead (development, CI), use `deploy/docker-compose.build.yml`.

## 2. Create `.env`

```sh
cp .env.example .env
openssl rand -base64 32   # paste as BETTER_AUTH_SECRET
openssl rand -base64 32   # paste as DEFE2END_ENCRYPTION_KEY
```

Edit `.env`:

- `DEFE2END_VERSION`: the release you picked, for example `1.0.0`.
- `BETTER_AUTH_SECRET`, `DEFE2END_ENCRYPTION_KEY`: the two values you just generated. Use different values.
- `POSTGRES_PASSWORD`: a long random password.
- `BETTER_AUTH_URL`: the URL users open, for example `https://e2e.example.com`.

**Store `DEFE2END_ENCRYPTION_KEY` somewhere safe, apart from your backups.** Secret variables can't be read without it, and the web server refuses to start with a different key than the one the database was set up with. All settings are in [configuration.md](configuration.md).

## 3. Start

```sh
docker compose up -d
docker compose ps
```

`migrate` runs once and exits; `web` and `worker` start after it succeeds.

## 4. Create the first admin

Until an admin exists, the web server prints a one-time setup link on every start:

```sh
docker compose logs web | grep setup
```

Open `<BETTER_AUTH_URL>/setup#token=…` and create the admin account. A new token is issued on each restart until setup is done.

If you lose the admin account later, see [../admin-recovery.md](../admin-recovery.md).

## 5. HTTPS

defE2End does not terminate TLS. Put a reverse proxy in front of `web` (port `WEB_PORT`, default 3000) and set `BETTER_AUTH_URL` (and `PUBLIC_URL`) to the `https://` address. Session cookies are marked `Secure` when the URL is https.

Example with Caddy, on the same host:

```
e2e.example.com {
    reverse_proxy localhost:3000
}
```

The proxy must pass long-lived responses through without buffering: run progress uses server-sent events.

## Next

- [Desktop app](desktop-app.md): run scenarios on your own PC, record, and chat with AI.
- [Backup and restore](backup-restore.md), [Upgrade](upgrade.md).
