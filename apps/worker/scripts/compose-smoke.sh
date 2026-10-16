#!/bin/sh
# Proves the worker image in the example compose stack (stage 3 contract section 8): builds and starts it,
# checks the Chromium sandbox from inside the worker container, runs a real scenario against the web
# container and checks its screenshot reached the shared volume. Tears everything down afterwards.
# Usage: apps/worker/scripts/compose-smoke.sh   (PROJECT and WEB_PORT override the defaults)
set -eu
cd "$(dirname "$0")/../../../deploy"
PROJECT="${PROJECT:-defe2end-smoke}"
# One run per project at a time: a second start while the first is still building would share its
# containers and tear them down underneath it.
LOCK="${TMPDIR:-/tmp}/defe2end-compose-smoke-$PROJECT.lock"
mkdir "$LOCK" 2>/dev/null || { echo "compose-smoke for $PROJECT is already running ($LOCK); wait for it instead" >&2; exit 2; }
ENV_FILE="$(mktemp)"
cat > "$ENV_FILE" <<ENV
WEB_PORT=${WEB_PORT:-3916}
POSTGRES_PASSWORD=smoke-$(od -An -tx1 -N8 /dev/urandom | tr -d ' \n')
BETTER_AUTH_SECRET=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
DEFE2END_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)
ENV
compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f docker-compose.yml "$@"; }
cleanup() { compose down -v --rmi local >/dev/null 2>&1 || true; rm -f "$ENV_FILE"; rmdir "$LOCK" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# No `--wait`: Compose 2.3 keeps waiting on the one-shot migrate service after it exited.
compose up -d --build web worker
tries=0
until curl -fsS -o /dev/null "http://localhost:${WEB_PORT:-3916}/login"; do
  tries=$((tries + 1)); [ "$tries" -lt 120 ] || { compose logs web | tail -n 20; exit 1; }; sleep 1
done

echo "== health: web reaches the database"
curl -fsS "http://localhost:${WEB_PORT:-3916}/api/health"; echo

echo "== sandbox check inside the worker container"
compose exec -T worker node dist/sandbox-check.js

echo "== process tree: tini is PID 1, the worker runs as node"
compose exec -T worker sh -c 'cat /proc/1/comm; id -un'

echo "== a real run against the web container"
compose exec -T worker node --input-type=module - <<'JS'
import { createDbClient } from "@defe2end/db";
const db = createDbClient();
const ws = await db.workspace.create({ data: { name: "smoke", slug: `smoke-${Date.now()}` } });
const site = await db.site.create({ data: { workspaceId: ws.id, name: "web" } });
const env = await db.environment.create({ data: { workspaceId: ws.id, siteId: site.id, name: "compose", baseUrl: "http://web:3000" } });
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
  row = await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { artifacts: true, stepResults: { orderBy: { index: "asc" } } } });
} while (["queued", "running"].includes(row.status) && Date.now() < deadline);
console.log(JSON.stringify({ status: row.status, errorCode: row.errorCode, errorMessage: row.errorMessage, browserVersion: row.browserVersion, steps: row.stepResults.map((s) => [s.action, s.status]), artifacts: row.artifacts.map((a) => [a.kind, a.storageKey, a.sizeBytes]) }, null, 2));
await db.$disconnect();
if (row.status !== "passed" || row.artifacts.length !== 1) process.exit(1);
await import("node:fs").then((fs) => fs.writeFileSync("/tmp/smoke-artifact", row.artifacts[0].storageKey));
JS

KEY="$(compose exec -T worker cat /tmp/smoke-artifact)"
echo "== the screenshot is on the shared volume, readable by web: $KEY"
compose exec -T web sh -c "test -s '/data/storage/$KEY' && ls -l '/data/storage/$KEY'"

echo "== stop: the worker shuts down within its grace"
compose stop worker
compose logs worker | tail -n 5
echo "compose smoke passed"
