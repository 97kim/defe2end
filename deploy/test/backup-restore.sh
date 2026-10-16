#!/bin/sh
# Backup and restore through the compose stack (stage 8 contract section 4): makes data (an admin, a workspace,
# a scenario, a real run with its screenshot, a secret variable), checks backup refuses while web and worker
# run, backs up with them stopped, wipes everything, restores into the empty stack with the same key, checks
# automation is paused until resume-automation, then the data, the files and the secret. Then: another key is
# refused, --without-key drops the secrets, and a restore left half done keeps web from starting.
# Usage: deploy/test/backup-restore.sh   (PROJECT and WEB_PORT override the defaults)
set -eu
cd "$(dirname "$0")/.."
PROJECT="${PROJECT:-defe2end-backup-test}"
PORT="${WEB_PORT:-3917}"
WORK="$(mktemp -d)"
BACKUP="$WORK/backup"
mkdir -p "$BACKUP"
# The migrate image runs as a non-root user; the bind-mounted directory must be writable for it.
chmod 777 "$BACKUP"
KEY="$(head -c 32 /dev/urandom | base64)"
OTHER_KEY="$(head -c 32 /dev/urandom | base64)"
cat > "$WORK/env" <<ENV
WEB_PORT=$PORT
POSTGRES_PASSWORD=backup-$(od -An -tx1 -N8 /dev/urandom | tr -d ' \n')
BETTER_AUTH_SECRET=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
DEFE2END_ENCRYPTION_KEY=$KEY
ENV
compose() { docker compose -p "$PROJECT" --env-file "$WORK/env" -f docker-compose.build.yml "$@"; }
cleanup() { compose down -v --rmi local >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

wait_web() {
  tries=0
  until curl -fsS -o /dev/null "http://localhost:$PORT/api/health"; do
    tries=$((tries + 1)); [ "$tries" -lt 120 ] || { compose logs web | tail -n 20; exit 1; }; sleep 1
  done
}

compose up -d --build web worker
wait_web

echo "== make data: admin, workspace, scenario, a real run with a screenshot, a secret variable"
compose exec -T worker node --input-type=module - > "$WORK/seed.json" <<'JS'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDbClient } from "@defe2end/db";
import { encryptSecret, parseEncryptionKey } from "@defe2end/shared/server";
const db = createDbClient();
const admin = await db.user.create({ data: { id: "backup-admin", name: "Admin", email: "admin@example.test", emailVerified: true, isInstanceAdmin: true } });
const ws = await db.workspace.create({ data: { name: "backup", slug: "backup" } });
await db.membership.create({ data: { userId: admin.id, workspaceId: ws.id, role: "ADMIN" } });
const site = await db.site.create({ data: { workspaceId: ws.id, name: "web" } });
const env = await db.environment.create({ data: { workspaceId: ws.id, siteId: site.id, name: "compose", baseUrl: "http://web:3000" } });
const k = parseEncryptionKey(process.env.DEFE2END_ENCRYPTION_KEY);
await db.slackWebhook.create({ data: { workspaceId: ws.id, name: "alerts", urlEncrypted: encryptSecret("https://hooks.example.test/x", k), urlHint: "/x" } });
await db.authSession.create({ data: { workspaceId: ws.id, environmentId: env.id, userId: admin.id, encryptedState: encryptSecret("{}", k), cookieCount: 0, sizeBytes: 2, savedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) } });
const secret = `s3cret-${Date.now()}`;
await db.variable.create({ data: { workspaceId: ws.id, environmentId: env.id, key: "PASSWORD", isSecret: true, valueEncrypted: encryptSecret(secret, parseEncryptionKey(process.env.DEFE2END_ENCRYPTION_KEY)) } });
const steps = [{ id: "s1", action: "goto", url: "/login" }, { id: "s2", action: "screenshot", name: "login" }];
const scenario = await db.scenario.create({ data: { workspaceId: ws.id, siteId: site.id, name: "login page", steps } });
const run = await db.run.create({
  data: {
    workspaceId: ws.id, scenarioId: scenario.id, environmentId: env.id, trigger: "manual",
    snapshot: { scenario: { id: scenario.id, name: scenario.name, stepFormatVersion: 1, steps }, environment: { id: env.id, name: env.name, baseUrl: env.baseUrl }, device: { viewport: { width: 1280, height: 720 } }, attachments: [], variableKeys: [] },
  },
});
const deadline = Date.now() + 90_000;
let row;
do {
  await new Promise((r) => setTimeout(r, 500));
  row = await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { artifacts: true } });
} while (["queued", "running"].includes(row.status) && Date.now() < deadline);
if (row.status !== "passed" || row.artifacts.length !== 1) throw new Error(`run ended ${row.status}: ${row.errorMessage}`);
const artifact = row.artifacts[0];
const sha256 = createHash("sha256").update(readFileSync(`${process.env.STORAGE_DIR}/${artifact.storageKey}`)).digest("hex");
console.log(JSON.stringify({ workspaceId: ws.id, scenarioId: scenario.id, runId: run.id, secret, artifactKey: artifact.storageKey, sha256 }));
await db.$disconnect();
JS
cat "$WORK/seed.json"

echo "== backup is refused while web and worker run"
if compose run --rm --no-deps -T -v "$BACKUP:/backup" migrate backup /backup > "$WORK/out" 2>&1; then cat "$WORK/out"; exit 1; fi
grep -q "docker compose stop web worker" "$WORK/out" || { cat "$WORK/out"; exit 1; }
rm -rf "$BACKUP" && mkdir -p "$BACKUP" && chmod 777 "$BACKUP"

echo "== backup with web and worker stopped"
compose stop web worker
compose run --rm --no-deps -T -v "$BACKUP:/backup" migrate backup /backup
test -s "$BACKUP/db.dump" && test -s "$BACKUP/manifest.json"
if grep -q "$KEY" "$BACKUP/manifest.json"; then echo "the encryption key leaked into manifest.json" >&2; exit 1; fi

echo "== wipe everything, start an empty postgres"
compose down -v
compose up -d --wait postgres

echo "== a backup from another version is refused"
mkdir -p "$WORK/other" && cp -R "$BACKUP/." "$WORK/other/"
sed 's/"appVersion": "[^"]*"/"appVersion": "0.0.0-other"/' "$BACKUP/manifest.json" > "$WORK/other/manifest.json"
if compose run --rm --no-deps -T -v "$WORK/other:/backup:ro" migrate restore /backup > "$WORK/out" 2>&1; then cat "$WORK/out"; exit 1; fi
grep -q "Restore with the image of version 0.0.0-other first" "$WORK/out" || { cat "$WORK/out"; exit 1; }

echo "== a link in the storage volume counts as not empty (nothing is written through it)"
compose run --rm --no-deps -T --entrypoint sh migrate -c 'ln -s /tmp /data/storage/workspaces'
if compose run --rm --no-deps -T -v "$BACKUP:/backup:ro" migrate restore /backup > "$WORK/out" 2>&1; then cat "$WORK/out"; exit 1; fi
grep -q "is not empty" "$WORK/out" || { cat "$WORK/out"; exit 1; }
compose run --rm --no-deps -T --entrypoint sh migrate -c 'rm /data/storage/workspaces'

echo "== a database restore that fails half way is rolled back"
# A type with the dump's name: no tables, so the empty check passes, but the dump's CREATE TYPE fails.
compose exec -T postgres psql -U defe2end -d defe2end -q -c "CREATE TYPE public.\"Role\" AS ENUM ('x')"
if compose run --rm --no-deps -T -v "$BACKUP:/backup:ro" migrate restore /backup > "$WORK/out" 2>&1; then cat "$WORK/out"; exit 1; fi
grep -q "was rolled back" "$WORK/out" || { cat "$WORK/out"; exit 1; }
tables="$(compose exec -T postgres psql -U defe2end -d defe2end -At -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
[ "$tables" = "0" ] || { echo "a failed restore left $tables tables" >&2; exit 1; }
compose exec -T postgres psql -U defe2end -d defe2end -q -c 'DROP TYPE public."Role"'

echo "== restore into the empty stack"
compose run --rm --no-deps -T -v "$BACKUP:/backup:ro" migrate restore /backup

echo "== a second restore is refused: the database is not empty"
if compose run --rm --no-deps -T -v "$BACKUP:/backup:ro" migrate restore /backup > "$WORK/out" 2>&1; then cat "$WORK/out"; exit 1; fi
grep -q "Restore needs an empty database" "$WORK/out" || { cat "$WORK/out"; exit 1; }

echo "== automation is paused after the restore"
compose up -d web worker
wait_web
compose exec -T worker node --input-type=module -e '
import { createDbClient, isAutomationPaused } from "@defe2end/db";
const db = createDbClient();
if (!(await isAutomationPaused(db))) throw new Error("automation is not paused after restore");
await db.$disconnect();'
compose run --rm --no-deps -T migrate resume-automation

echo "== check data, file and secret"
compose exec -T -e SEED="$(cat "$WORK/seed.json")" -e OTHER_KEY="$OTHER_KEY" worker node --input-type=module - <<'JS'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createDbClient } from "@defe2end/db";
import { decryptSecret, parseEncryptionKey } from "@defe2end/shared/server";
const seed = JSON.parse(process.env.SEED);
const db = createDbClient();
const admin = await db.user.findUniqueOrThrow({ where: { id: "backup-admin" } });
if (!admin.isInstanceAdmin) throw new Error("admin lost its role");
await db.scenario.findUniqueOrThrow({ where: { id: seed.scenarioId } });
const run = await db.run.findUniqueOrThrow({ where: { id: seed.runId }, include: { artifacts: true } });
if (run.status !== "passed" || run.artifacts[0]?.storageKey !== seed.artifactKey) throw new Error("run or artifact row differs");
const sha256 = createHash("sha256").update(readFileSync(`${process.env.STORAGE_DIR}/${seed.artifactKey}`)).digest("hex");
if (sha256 !== seed.sha256) throw new Error("artifact file differs");
const variable = await db.variable.findFirstOrThrow({ where: { workspaceId: seed.workspaceId, key: "PASSWORD" } });
if (decryptSecret(variable.valueEncrypted, parseEncryptionKey(process.env.DEFE2END_ENCRYPTION_KEY)) !== seed.secret) throw new Error("secret differs");
let readable = true;
try { decryptSecret(variable.valueEncrypted, parseEncryptionKey(process.env.OTHER_KEY)); } catch { readable = false; }
if (readable) throw new Error("another key read the secret");
console.log("restored: admin, scenario, run, artifact file (checksum), secret (same key reads it, another key can't)");
await db.$disconnect();
JS
curl -fsS -o /dev/null "http://localhost:$PORT/login"

echo "== the web server refuses another key and says to restore the original"
compose stop web
if compose run --rm --no-deps -T -e DEFE2END_ENCRYPTION_KEY="$OTHER_KEY" web > "$WORK/out" 2>&1; then cat "$WORK/out"; exit 1; fi
grep -q "Restore the original key" "$WORK/out" || { cat "$WORK/out"; exit 1; }

echo "== restore with another key is refused; --without-key drops the secrets"
compose down -v
compose up -d --wait postgres
if compose run --rm --no-deps -T -e DEFE2END_ENCRYPTION_KEY="$OTHER_KEY" -v "$BACKUP:/backup:ro" migrate restore /backup > "$WORK/out" 2>&1; then cat "$WORK/out"; exit 1; fi
grep -q "not the key this backup was made with" "$WORK/out" || { cat "$WORK/out"; exit 1; }
compose run --rm --no-deps -T -e DEFE2END_ENCRYPTION_KEY="$OTHER_KEY" -v "$BACKUP:/backup:ro" migrate restore --without-key /backup
nulls="$(compose exec -T postgres psql -U defe2end -d defe2end -At -c 'SELECT count(*) FROM "Variable" WHERE "isSecret" AND "valueEncrypted" IS NULL')"
[ "$nulls" = "1" ] || { echo "the secret was not dropped ($nulls)" >&2; exit 1; }
left="$(compose exec -T postgres psql -U defe2end -d defe2end -At -c 'SELECT (SELECT count(*) FROM "AuthSession") + (SELECT count(*) FROM "SlackWebhook" WHERE "invalidAt" IS NULL)')"
[ "$left" = "0" ] || { echo "site login sessions or valid webhooks remain after --without-key ($left)" >&2; exit 1; }

echo "== a restore left half done keeps web from starting"
compose exec -T postgres psql -U defe2end -d defe2end -c 'UPDATE "InstanceSetting" SET "restoreInProgressAt" = now()'
if compose run --rm --no-deps -T -e DEFE2END_ENCRYPTION_KEY="$OTHER_KEY" web > "$WORK/out" 2>&1; then cat "$WORK/out"; exit 1; fi
grep -q "did not finish" "$WORK/out" || { cat "$WORK/out"; exit 1; }
echo "backup and restore passed"
