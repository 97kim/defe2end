# Backup and restore (short)

Commands run in the migrate image, next to the compose example. The full guide is in `docs/guide/`.

```sh
docker compose stop web worker                       # backup refuses while they are connected
mkdir -p backups/2026-10-16 && chmod 777 backups/2026-10-16   # the image runs as uid 1000
docker compose run --rm --no-deps -v "$PWD/backups/2026-10-16:/backup" migrate backup /backup
docker compose start web worker
```

A backup holds `db.dump`, `files/` and `manifest.json` (version, migrations with checksums, file checksums,
environment variable names, a check value of the key). **The encryption key is not in it**: keep
`DEFE2END_ENCRYPTION_KEY` separately.

Restore into an empty stack with the same version and the same key:

```sh
docker compose up -d postgres                        # fresh volumes; don't start migrate or web first
docker compose run --rm --no-deps -v "$PWD/backups/2026-10-16:/backup:ro" migrate restore /backup
docker compose up -d
docker compose run --rm --no-deps migrate resume-automation    # after you checked the instance
```

- Restore refuses a non-empty database or storage, another version (restore with that version, then
  upgrade), damaged files, and another key.
- Automation stays paused after a restore: schedules, notifications and queued runs wait for
  `resume-automation`. Runs that were going end as `error(restore_interrupted)`.
- Key lost: `restore --without-key` with the new key set. Secret values and login sessions are dropped;
  enter the secrets again.
- If a restore stops half way, web and worker refuse to start. Start over on empty volumes.
