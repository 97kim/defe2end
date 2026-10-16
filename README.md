# defE2End

Self-hosted E2E regression testing for your web flows.

> Status: 1.0 release candidate. Try it and report issues; expect small changes before 1.0.0.

defE2End lets a team write no-code browser test scenarios, run them on a server
worker or on their own PC through a desktop app, schedule them, and compare two
environments side by side. You host it yourself with `docker compose`.

## Quick start

```sh
git clone --depth 1 --branch v1.0.0 https://github.com/97kim/defe2end.git
cd defe2end/deploy && cp .env.example .env
# In .env: set DEFE2END_VERSION, POSTGRES_PASSWORD, and two secrets from `openssl rand -base64 32`
docker compose up -d
docker compose logs web | grep setup   # open the link to create the first admin
```

Full steps, HTTPS and settings: [docs/guide/install.md](docs/guide/install.md).

## Documentation

- [Install](docs/guide/install.md) · [Configuration](docs/guide/configuration.md) · [Upgrade](docs/guide/upgrade.md) · [Backup and restore](docs/guide/backup-restore.md)
- [Desktop app](docs/guide/desktop-app.md) · [AI and MCP](docs/guide/ai.md) · [Running from CI](docs/ci.md)
- [Security and limits](docs/guide/security.md) · [Requirements](docs/guide/requirements.md) · [Troubleshooting](docs/guide/troubleshooting.md)
- 한국어: [docs/guide/ko](docs/guide/ko/README.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Exceptions:

- The bundled fonts (Geist, Geist Mono, IBM Plex Sans KR) are under the SIL Open
  Font License 1.1. The license text sits next to the font files.
- The CSS transitions adapted from transitions.dev follow that project's own
  license, not Apache-2.0.

See [NOTICE](NOTICE) for the full list, sources, and file paths.
