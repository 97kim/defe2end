#!/bin/sh
# Upgrade test (stage 8 contract section 4): starts the previous version, makes data through its API (admin,
# workspace, site, environment, scenario, a secret variable, a run with a screenshot), then switches the same
# volumes to this version's images. Checks that this version's web refuses the old database until migrate ran,
# then migrates and checks login, one new run, the secret and the old screenshot.
#
# The previous version is the source at UPGRADE_FROM_REF (built with that commit's compose). Once a release
# exists, set UPGRADE_FROM_VERSION=X.Y.Z instead to start its published images with deploy/docker-compose.yml.
# Usage: deploy/test/upgrade.sh   (PROJECT and WEB_PORT override the defaults; needs git history and node)
set -eu
cd "$(dirname "$0")/.."
DEPLOY="$(pwd)"
UPGRADE_FROM_REF="${UPGRADE_FROM_REF:-6dbe822}"
UPGRADE_FROM_VERSION="${UPGRADE_FROM_VERSION:-}"
PROJECT="${PROJECT:-defe2end-upgrade-test}"
PORT="${WEB_PORT:-3919}"
BASE="http://localhost:$PORT"
WORK="$(mktemp -d)"
cat > "$WORK/env" <<ENV
WEB_PORT=$PORT
BETTER_AUTH_URL=$BASE
POSTGRES_PASSWORD=upgrade-$(od -An -tx1 -N8 /dev/urandom | tr -d ' \n')
BETTER_AUTH_SECRET=$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')
DEFE2END_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)
DEFE2END_VERSION=$UPGRADE_FROM_VERSION
ENV
if [ -n "$UPGRADE_FROM_VERSION" ]; then
  OLD_COMPOSE="$DEPLOY/docker-compose.yml"
else
  git worktree add --detach "$WORK/old" "$UPGRADE_FROM_REF" >/dev/null
  OLD_COMPOSE="$WORK/old/deploy/docker-compose.yml"
fi
# Same project name for both: the old and the new stack share the postgres and storage volumes.
old() { docker compose -p "$PROJECT" --env-file "$WORK/env" -f "$OLD_COMPOSE" "$@"; }
new() { docker compose -p "$PROJECT" --env-file "$WORK/env" -f "$DEPLOY/docker-compose.build.yml" "$@"; }
cleanup() {
  new down -v --rmi local >/dev/null 2>&1 || true
  old down -v --rmi local >/dev/null 2>&1 || true
  [ -d "$WORK/old" ] && git worktree remove --force "$WORK/old" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval("v"+process.argv[1]))})' "$1"; }
api() { # api METHOD PATH [BODY] -> body on stdout, fails on HTTP >= 400
  curl -fsS -b "$WORK/cookies" -c "$WORK/cookies" -H "Origin: $BASE" -H "Content-Type: application/json" -X "$1" "$BASE$2" ${3:+-d "$3"}
}
wait_web() {
  tries=0
  until curl -fsS -o /dev/null "$BASE/api/health"; do
    tries=$((tries + 1)); [ "$tries" -lt 180 ] || { "$1" logs web | tail -n 20; exit 1; }; sleep 1
  done
}
wait_run() { # wait_run SLUG RUN_ID -> final run JSON
  tries=0
  while :; do
    api GET "/api/w/$1/runs/$2" > "$WORK/run.json"
    status="$(json .status < "$WORK/run.json")"
    case "$status" in queued|running) ;; *) break ;; esac
    tries=$((tries + 1)); [ "$tries" -lt 90 ] || break; sleep 1
  done
  [ "$status" = passed ] || { echo "run ended $status" >&2; cat "$WORK/run.json" >&2; exit 1; }
}

echo "== previous version (${UPGRADE_FROM_VERSION:-$UPGRADE_FROM_REF}): start and make data through its API"
if [ -n "$UPGRADE_FROM_VERSION" ]; then old up -d web worker; else old up -d --build web worker; fi
wait_web old
TOKEN="$(old logs web | sed -n 's/.*setup#token=\([^ ]*\).*/\1/p' | tail -n 1)"
[ -n "$TOKEN" ] || { echo "no install token in the web log" >&2; exit 1; }
SLUG="$(api POST /api/setup "{\"token\":\"$TOKEN\",\"name\":\"Admin\",\"email\":\"admin@example.test\",\"password\":\"upgrade-pass-1\",\"workspaceName\":\"Upgrade\"}" | json .slug)"
api POST /api/auth/sign-in/email '{"email":"admin@example.test","password":"upgrade-pass-1"}' > /dev/null
SITE="$(api POST "/api/w/$SLUG/sites" '{"name":"web"}' | json .id)"
ENVIRONMENT="$(api POST "/api/w/$SLUG/sites/$SITE/environments" '{"name":"compose","baseUrl":"http://web:3000"}' | json .id)"
SECRET="s3cret-$(od -An -tx1 -N6 /dev/urandom | tr -d ' \n')"
api POST "/api/w/$SLUG/environments/$ENVIRONMENT/variables" "{\"key\":\"PASSWORD\",\"value\":\"$SECRET\",\"isSecret\":true}" > /dev/null
STEPS='[{"id":"s1","action":"goto","url":"/login"},{"id":"s2","action":"screenshot","name":"login"}]'
SCENARIO="$(api POST "/api/w/$SLUG/scenarios" "{\"name\":\"login page\",\"siteId\":\"$SITE\",\"steps\":$STEPS}" | json .id)"
RUN="$(api POST "/api/w/$SLUG/runs" "{\"scenarioId\":\"$SCENARIO\",\"environmentId\":\"$ENVIRONMENT\"}" | json .id)"
wait_run "$SLUG" "$RUN"
ARTIFACT="$(json '.artifacts[0].id' < "$WORK/run.json")"
api GET "/api/w/$SLUG/runs/$RUN/artifacts/$ARTIFACT" > "$WORK/before.png"
echo "made: workspace $SLUG, run $RUN with artifact $ARTIFACT"

echo "== switch to this version"
old down
new build
echo "== this version's web refuses the old database until migrate ran"
new up -d --wait postgres
if new run --rm --no-deps -T web > "$WORK/out" 2>&1; then cat "$WORK/out"; exit 1; fi
grep -q "Run this version's migrate first" "$WORK/out" || { cat "$WORK/out"; exit 1; }
grep "not applied yet" "$WORK/out" | head -n 1

echo "== migrate and start"
rm -f "$WORK/cookies"
new up -d web worker
wait_web new
api POST /api/auth/sign-in/email '{"email":"admin@example.test","password":"upgrade-pass-1"}' > /dev/null
echo "login: ok"
api GET "/api/w/$SLUG/runs/$RUN/artifacts/$ARTIFACT" > "$WORK/after.png"
cmp -s "$WORK/before.png" "$WORK/after.png" || { echo "the old screenshot differs after the upgrade" >&2; exit 1; }
echo "old screenshot: same bytes"
RUN2="$(api POST "/api/w/$SLUG/runs" "{\"scenarioId\":\"$SCENARIO\",\"environmentId\":\"$ENVIRONMENT\"}" | json .id)"
wait_run "$SLUG" "$RUN2"
echo "new run: passed"
new exec -T -e SECRET="$SECRET" worker node --input-type=module -e '
import { createDbClient } from "@defe2end/db";
import { decryptSecret, parseEncryptionKey } from "@defe2end/shared/server";
const db = createDbClient();
const v = await db.variable.findFirstOrThrow({ where: { key: "PASSWORD" } });
if (decryptSecret(v.valueEncrypted, parseEncryptionKey(process.env.DEFE2END_ENCRYPTION_KEY)) !== process.env.SECRET) throw new Error("secret differs");
console.log("secret: decrypts to the original value");
await db.$disconnect();'
echo "upgrade passed"
