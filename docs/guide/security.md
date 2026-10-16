# Security and limits

One install serves one organization. defE2End assumes people in the same install don't attack each other; it does not isolate separate organizations on one server.

## Secrets and the encryption key

- Secret variables are encrypted with AES-256-GCM using `DEFE2END_ENCRYPTION_KEY`. The worker decrypts them just before a run.
- The key is not in the database or in backups. Lose it and secret values can't be recovered; enter them again.
- The web server checks the key against the database on start and refuses to start with a different key.
- Bot tokens are stored as hashes and shown once, when created.

## Screen masking

Masking hides personal data on screen and in screenshots, but it has gaps: videos, the first frames before masking applies, text inside canvas or images, closed shadow DOM, cross-origin iframes, and data without a known format such as names or addresses. Read [../masking.md](../masking.md) before recording videos of pages with personal data.

## Network reach of scenarios

The worker opens whatever URLs scenarios point to, including addresses inside your network. Set `BLOCK_PRIVATE_NETWORKS=true` if scenarios must not reach private, loopback or link-local addresses. Chromium's sandbox stays on by default (`CHROMIUM_SANDBOX`).

## Desktop app and local MCP

- The app and `defe2end-mcp` talk over a local socket. On macOS it is a Unix socket in the app data folder (folder `0700`, socket `0600`). On Windows it is a named pipe restricted to the current user's SID. The session token for the socket is kept in the OS secure store (Keychain, DPAPI).
- **Processes running as the same OS user are trusted.** Any program you run under your account can open the socket and read the token, just as it can read your browser data. defE2End does not defend against malware on your own account.
- **Windows pipe permissions:** the access control is tested in CI but has not yet been verified by hand on a clean Windows PC for this release.
- The app is not code-signed. Verify every installer (checksum and provenance) ([desktop-app.md](desktop-app.md#verify-the-file)).

## AI

Model requests go from your PC to your CLI's provider. See [ai.md](ai.md) for what the in-app chat can and can't do.

## What you operate

TLS, the reverse proxy, firewall rules, database hosting, OS patches, backups and monitoring are yours. Keep `web` behind HTTPS and don't expose Postgres outside the compose network.

## Reporting a vulnerability

Please report security issues privately through GitHub's "Report a vulnerability" on the repository, not in public issues.
