# Backup and restore

A backup is a folder with:

- a consistent database dump, taken from a single snapshot even while `web` and `worker` are running,
- the run files from `STORAGE_DIR` that the dump refers to,
- `manifest.json`: server version, migration state, and the names (not values) of the environment variables the install needs.

**The encryption key is not in the backup.** Store `DEFE2END_ENCRYPTION_KEY` separately, for example in a password manager. Without the same key, a restored install can't read secret variables; you would have to enter them again.

Taking, storing and testing backups is up to you.

## Back up

Run the `backup` command of the `migrate` image. From the `deploy/` folder:

```sh
mkdir -p backups
docker compose run --rm -v "$PWD/backups:/backup" migrate backup /backup/$(date +%Y%m%d-%H%M%S)
```

Copy the resulting folder off the server. Files created after the dump may be left out; they are not referenced by the dumped data.

## Restore into an empty install

`restore` only works on an empty database and empty file storage, and only with the same version that made the backup. It refuses otherwise; there is no force option.

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
5. Sign in and check a few scenarios, runs and screenshots.

To move to a newer version, restore with the old version first, then [upgrade](upgrade.md).

> The exact command line may change before 1.0; check `docker compose run --rm migrate --help` for your version.
