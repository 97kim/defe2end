# Backup and restore

A backup is a folder with:

- a database dump,
- the run files from `STORAGE_DIR`,
- `manifest.json`: server version, migration names and checksums, creation time, the names (not values) of the environment variables the install needs, the SHA-256 of the dump and of every file, and a key check value (an HMAC made with your encryption key, not the key itself).

**The encryption key is not in the backup.** Store `DEFE2END_ENCRYPTION_KEY` separately, for example in a password manager. Restore uses the key check value to make sure you supply the right key.

Taking, storing and testing backups is up to you.

## Back up

Back up only while `web` and `worker` are stopped. While they run, cleanup and deletes can remove files the dump still refers to, so `backup` refuses if they are still connected to the database. From the `deploy/` folder:

```sh
docker compose stop web worker
mkdir -p backups
docker compose run --rm -v "$PWD/backups:/backup" migrate backup /backup/$(date +%Y%m%d-%H%M%S)
docker compose start web worker
```

Copy the resulting folder off the server.

## Restore into an empty install

`restore` checks everything before it changes anything:

- the database and file storage are empty (there is no force option),
- the backup's version and migration checksums match the `migrate` image you run,
- the dump and file hashes match `manifest.json`,
- the key check value matches `DEFE2END_ENCRYPTION_KEY`.

Steps:

1. On the new host, follow [install.md](install.md) steps 1–2. Set `DEFE2END_VERSION` to the version in the backup's `manifest.json`, and set `DEFE2END_ENCRYPTION_KEY` to the **original** key.
2. Start only the database:
   ```sh
   docker compose up -d postgres
   ```
3. Restore:
   ```sh
   docker compose run --rm -v "/path/to/backups:/backup" migrate restore /backup/20261016-120000
   ```
4. Start everything: `docker compose up -d`.
5. Sign in and check scenarios, runs and screenshots.
6. Resume automation (see below).

While a restore is in progress the database carries a "restoring" mark. If a restore stops halfway, `web` and `worker` refuse to start; empty the database and storage and restore again.

### Automation is paused after a restore

A restored install starts with automation paused, so it doesn't repeat work the original already did: schedules don't fire, Slack messages aren't sent and queued runs don't start. Runs that were in progress in the backup end as errors (interrupted by restore), and pending notifications are cancelled.

When you've checked the restored install, and the original no longer runs the same schedules, resume:

```sh
docker compose run --rm migrate resume-automation
```

### If the key is lost

Only if the original key is truly lost, restore with a new key and `--without-key`:

```sh
docker compose run --rm -v "/path/to/backups:/backup" migrate restore --without-key /backup/20261016-120000
```

Secret variables, Slack webhooks and saved login sessions are then marked unreadable. Enter them again.

### Moving to a newer version

Restore with the backup's version first, then [upgrade](upgrade.md).

> Check `docker compose run --rm migrate --help` for the exact options of your version.
