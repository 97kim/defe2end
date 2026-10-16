# Running defE2End from CI

CI starts runs through the fixed `/api/v1` API with a **bot token**, waits for them to finish, and passes only when the response says `"passed": true`.

## 1. Create a bot token

An admin opens **Settings → Bot tokens → New token**:

- **Scopes**: `runs:create` and `runs:read` are enough for CI; add `runs:cancel` if your job cancels runs on abort.
- **Expiry** is required (default 90 days, at most 365). Renew the token before it expires.
- The token (`d2e_…`) is shown **once**. Store it in your CI secrets (for example `DEFE2END_TOKEN`).
- **Values & sessions**: bot runs never use a person's values or login session. Set the bot's own value for every personal variable the scenarios use, and create the bot's login session (from the desktop app) for environments that need one. Missing ones make run creation fail with `409 variable_missing` or `409 auth_session_missing`.

Revoking a token stops it at once, including requests that are already waiting.

## 2. The API

All requests send `Authorization: Bearer $DEFE2END_TOKEN`. Errors are `{ "error": { "code", "message" } }`.

| Request | Purpose |
|---|---|
| `POST /api/v1/runs` | Start a run or a group. Header `Idempotency-Key` (1–128 characters) is required. |
| `GET /api/v1/runs/{id}?wait=<seconds>` | Read a run or group. With `wait` (at most 60) the server holds the request until it finishes or the time is up. |
| `POST /api/v1/runs/{id}/cancel` | Cancel a run or every unfinished run of a group. |

Request bodies for `POST /api/v1/runs` (all runs go to the server):

```json
{ "environmentId": "…", "scenarioId": "…" }
{ "environmentId": "…", "scenarioIds": ["…", "…"], "mode": "sequential", "continueOnFailure": false }
{ "environmentId": "…", "tag": "smoke", "mode": "parallel", "continueOnFailure": true }
```

Each shape also takes `"options": { "failOnWarning": true, "video": true }` (both optional, off by default).

The response (also for reads and cancels):

```json
{ "id": "…", "kind": "run", "status": "queued", "startedAt": null, "finishedAt": null, "warningCount": 0, "failOnWarning": false, "passed": false, "url": "https://e2e.example.com/w/acme/runs/…" }
```

Groups have `"kind": "group"` and a `children` list. `url` is null when the server has no `PUBLIC_URL`.

- **Idempotency**: sending the same key with the same body within 24 hours returns the run created the first time (status `200` instead of `201`), so a retried CI step never starts a second run. A tag request keeps the scenarios it chose the first time. The same key with a different body is `409 idempotency_conflict`. Keys belong to one token. Use something unique per pipeline attempt, such as `$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT`.
- **Verdict**: read `passed` once `finishedAt` is set. Only status `passed` passes; `failed`, `error`, `cancelled` and `timed_out` fail the job. A `passed` run can still have warnings (`warningCount`): with `options.failOnWarning` in the request, warnings make `passed` false. The stored status stays `passed`.
- **Waiting**: a token may hold at most 5 waiting requests at a time (`429 too_many_waits` beyond that). Repeat the read until `finishedAt` is set.

## 3. curl

```sh
BASE=https://e2e.example.com
KEY="deploy-$(date +%s)"

run=$(curl -fsS -X POST "$BASE/api/v1/runs" \
  -H "Authorization: Bearer $DEFE2END_TOKEN" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"environmentId":"ENV_ID","tag":"smoke","options":{"failOnWarning":true}}')
id=$(echo "$run" | jq -r .id)
echo "Started: $(echo "$run" | jq -r .url)"

while :; do
  run=$(curl -fsS "$BASE/api/v1/runs/$id?wait=60" -H "Authorization: Bearer $DEFE2END_TOKEN")
  [ "$(echo "$run" | jq -r .finishedAt)" != "null" ] && break
done

echo "Finished: $(echo "$run" | jq -r .status)"
[ "$(echo "$run" | jq -r .passed)" = "true" ]
```

## 4. GitHub Actions

```yaml
name: e2e
on: [deployment_status]

jobs:
  e2e:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    env:
      BASE: https://e2e.example.com
      DEFE2END_TOKEN: ${{ secrets.DEFE2END_TOKEN }}
    steps:
      - name: Start runs
        id: start
        run: |
          run=$(curl -fsS --retry 3 --retry-all-errors -X POST "$BASE/api/v1/runs" \
            -H "Authorization: Bearer $DEFE2END_TOKEN" \
            -H "Idempotency-Key: ${{ github.run_id }}-${{ github.run_attempt }}" \
            -H "Content-Type: application/json" \
            -d '{"environmentId":"${{ vars.DEFE2END_ENVIRONMENT_ID }}","tag":"smoke"}')
          echo "id=$(echo "$run" | jq -r .id)" >> "$GITHUB_OUTPUT"
          echo "Results: $(echo "$run" | jq -r .url)" >> "$GITHUB_STEP_SUMMARY"

      - name: Wait and judge
        run: |
          while :; do
            run=$(curl -fsS --retry 3 --retry-all-errors "$BASE/api/v1/runs/${{ steps.start.outputs.id }}?wait=60" \
              -H "Authorization: Bearer $DEFE2END_TOKEN")
            [ "$(echo "$run" | jq -r .finishedAt)" != "null" ] && break
          done
          echo "defE2End: $(echo "$run" | jq -r .status) (warnings: $(echo "$run" | jq -r .warningCount))"
          test "$(echo "$run" | jq -r .passed)" = "true"
```

Retrying the "Start runs" step (or re-running the job with the same attempt) reuses the same `Idempotency-Key`, so it never starts the runs twice.

## 5. Notes

- Bot runs are recorded with the token as their origin (`api`); Slack webhooks that include the `api` source report them.
- The trust model is the same as for schedules: anyone who can edit a scenario's steps can make the bot's runs use its values. Give bot values only what CI needs.
