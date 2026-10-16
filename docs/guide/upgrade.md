# Upgrade

Upgrading means changing `DEFE2END_VERSION` and starting again. The `migrate` container updates the database schema before `web` and `worker` start.

**Run `web`, `worker` and `migrate` at the same version.** On start, `web` and `worker` compare the database's migrations with the ones their image knows, and refuse to start if they differ. The example compose file pins all three with `DEFE2END_VERSION`; if you run the images another way, change all three together.

1. Read the release notes of every version between yours and the target. They say when you can't skip a version and whether a step is needed.
2. [Back up](backup-restore.md) and make sure you still have `DEFE2END_ENCRYPTION_KEY`.
3. Get the new compose files (the `deploy/` folder of the new release tag) and compare them with yours. Carry over any changes you made.
4. Set the new version in `.env`:
   ```sh
   DEFE2END_VERSION=1.0.1   # exact version, no X.Y or latest
   ```
5. Pull and restart:
   ```sh
   docker compose pull
   docker compose up -d
   docker compose logs migrate
   ```
6. Check that `migrate` exited with code 0 and that the web UI works.

Runs still going when the worker stops end as `error` (`worker_shutdown`); start them again after the upgrade.

## Going back

Schema migrations only move forward. To return to the old version, restore the backup you made in step 2 into an empty install running the old version.

## Desktop app

Update the desktop app too ([desktop-app.md](desktop-app.md#updates)). The app works with a server of the same major version when the app's minor version is at most one behind the server's (server 1.4 accepts app 1.3 and later 1.x). Older apps are asked to update.
