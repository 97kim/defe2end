# Upgrade

Upgrading means changing `DEFE2END_VERSION` and starting again. The `migrate` container updates the database schema before `web` and `worker` start.

1. Read the release notes of every version between yours and the target. They say when you can't skip a version and whether a step is needed.
2. [Back up](backup-restore.md) and make sure you still have `DEFE2END_ENCRYPTION_KEY`.
3. Get the new compose files (the `deploy/` folder of the new release tag) and compare them with yours. Carry over any changes you made.
4. Set the new version in `.env`:
   ```sh
   DEFE2END_VERSION=1.0.1
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

Update the desktop app too ([desktop-app.md](desktop-app.md#updates)). A server supports apps of the same version and one version back; older apps are asked to update.
