# Backup and restore

The `migrate` image has three commands: `backup`, `restore [--without-key]` and `resume-automation`. Run them from the `deploy/` folder, next to `docker-compose.yml`. Taking, storing and testing backups is up to you.

Always pass `--no-deps`: without it, Compose starts the services `migrate` depends on, which would bring back a stopped `web` or `worker`.

## What a backup holds

A backup is a folder with:

- `db.dump`: the database,
- `files/`: the run files from `STORAGE_DIR`,
- `manifest.json`: server version, migrations with checksums, creation time, the SHA-256 of the dump and of every file, the names (not values) of the environment variables the install needs, and a key check value (an HMAC made with your encryption key, not the key itself).

**The encryption key is not in the backup.** Store `DEFE2END_ENCRYPTION_KEY` separately, for example in a password manager. Without the original key a restored server won't start and stored secrets can't be read.

## Back up

Back up only while `web` and `worker` are stopped. While they run, cleanup and deletes can remove files the dump still refers to, so `backup` refuses while they are connected to the database.

```sh
docker compose stop web worker
mkdir -p -m 0700 backups/2026-10-16
sudo chown 1000:1000 backups/2026-10-16   # the migrate image runs as uid 1000
docker compose run --rm --no-deps -T -v "$PWD/backups/2026-10-16:/backup" migrate backup /backup
docker compose start web worker
```

The target folder must be empty. Only uid 1000 (and root) should be able to open it: the dump holds all your data.

Check the permissions after the backup. The folder should be `drwx------` and every file `-rw-------`:

```sh
sudo ls -laR backups/2026-10-16
# if anything is wider:
sudo find backups/2026-10-16 -type d -exec chmod 0700 {} +
sudo find backups/2026-10-16 -type f -exec chmod 0600 {} +
```

Copy the finished folder off the server and keep the same restrictions where you store it.

## Restore into an empty install

`restore` checks everything before it changes anything, and refuses if:

- the database or file storage is not empty (there is no force option),
- the backup was made by another version (restore with that version, then [upgrade](upgrade.md)),
- the dump or a file doesn't match its checksum,
- the key check value doesn't match `DEFE2END_ENCRYPTION_KEY`.

Steps:

1. On the new host, follow [install.md](install.md) steps 1–2. Set `DEFE2END_VERSION` to the `version` in the backup's `manifest.json`, and `DEFE2END_ENCRYPTION_KEY` to the **original** key.
2. Start only the database, on fresh volumes. Don't start `migrate` or `web` first.
   ```sh
   docker compose up -d postgres
   ```
3. Put the backup folder on the new host with the same owner and permissions (`sudo chown -R 1000:1000 …`, folders `0700`, files `0600`), then restore (the folder can be mounted read-only):
   ```sh
   docker compose run --rm --no-deps -T -v "$PWD/backups/2026-10-16:/backup:ro" migrate restore /backup
   ```
4. Start everything:
   ```sh
   docker compose up -d
   ```
5. Sign in and check scenarios, runs and screenshots.
6. Resume automation (below).

If a restore stops halfway, `web` and `worker` refuse to start, so the instance never runs half restored. Remove the volumes and start over from step 2.

### Automation is paused after a restore

A restored install starts with automation paused, so it doesn't repeat work the original already did: schedules, Slack notifications and queued runs wait. Runs that were going when the backup was made end as `error` (`restore_interrupted`).

When you've checked the restored install, and the original no longer runs the same schedules, resume:

```sh
docker compose run --rm --no-deps -T migrate resume-automation
```

### If the key is lost

Only if the original key is truly lost: set a new `DEFE2END_ENCRYPTION_KEY` and restore with `--without-key`.

```sh
docker compose run --rm --no-deps -T -v "$PWD/backups/2026-10-16:/backup:ro" migrate restore --without-key /backup
```

Secret values and saved login sessions are dropped. Enter the secrets again.

`docker compose run --rm --no-deps migrate --help` prints the usage.
