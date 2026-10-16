# 문제 해결

먼저 로그를 보세요: `docker compose logs web worker migrate`.

## web 서버가 시작하자마자 끝나요

- `BETTER_AUTH_SECRET must be set to at least 32 characters`: `openssl rand -base64 32`로 만드세요.
- `DEFE2END_ENCRYPTION_KEY must be base64 of exactly 32 bytes`: 같은 방법으로 만드세요.
- DB를 처음 만들 때의 키와 달라요: 원래 키를 쓰세요. 정말 잃었다면 새 DB가 필요해요(또는 복원하면서 비밀 값을 포기해야 해요).

## `web`이나 `worker`가 끝나요: 마이그레이션이 맞지 않아요

DB의 마이그레이션이 이미지가 아는 목록과 달라요. 보통 이미지 버전이 섞였을 때예요. `web`, `worker`, `migrate`를 같은 `DEFE2END_VERSION`으로 돌리세요([upgrade.md](upgrade.md)).

## `web`이나 `worker`가 끝나요: 복원 중이에요

복원이 중간에 멈췄어요. DB와 저장소를 비우고 다시 복원하세요([backup-restore.md](backup-restore.md)).

## 복원 뒤 스케줄이 돌지 않아요

복원 뒤에는 자동화가 멈춰 있어요. `docker compose run --rm --no-deps migrate resume-automation`으로 다시 켜세요([backup-restore.md](backup-restore.md#복원-뒤에는-자동화가-멈춰-있어요)).

## `migrate`가 실패해요

DB에 닿지 않거나 마이그레이션이 실패했어요. `docker compose logs migrate`를 확인하세요. `web`과 `worker`는 `migrate`가 성공할 때까지 기다려요. 업그레이드했다면 릴리스 노트에서 거쳐야 할 버전이 있는지 확인하세요.

## 설정 링크를 못 찾겠어요

`docker compose logs web | grep setup`. 첫 관리자가 생길 때까지 시작할 때마다 새 링크가 나와요. 관리자가 있는데 접근을 잃었다면 [계정 복구](../../admin-recovery.md)를 보세요.

## 로그인 뒤 엉뚱한 주소로 가요

`BETTER_AUTH_URL`은 `https://`와 포트까지 사용자가 여는 주소와 정확히 같아야 해요. 바꾼 뒤 `web`을 다시 시작하세요. OIDC·GitHub는 제공자에 등록한 콜백 URL도 같은 주소로 시작해야 해요.

## 실행이 대기 상태에서 넘어가지 않아요

- 복원 뒤라면 다시 켤 때까지 자동화가 멈춰 있어요.
- `worker`가 돌고 있나요? `docker compose ps`.
- 남은 디스크가 `MIN_FREE_DISK_MB`보다 적으면 worker가 새 실행을 받지 않아요.
- 동시 실행 한도(`WORKER_CONCURRENCY`, `MAX_CONCURRENT_RUNS`, `WORKSPACE_CONCURRENCY`)가 찼어요.

## worker에서 Chromium이 시작하지 않아요

worker는 Chromium 샌드박스를 켜 두고, 여기에는 user namespace가 필요해요. 예시 compose 파일은 이를 위해 `chromium-seccomp.json`을 써요. `docker-compose.yml` 옆에 두세요. 다음으로 확인할 수 있어요.

```sh
docker compose exec worker node dist/sandbox-check.js
```

호스트가 user namespace를 줄 수 없으면 `CHROMIUM_SANDBOX=false`로 정할 수 있지만, 그러면 시나리오가 그 격리 없이 돌아요.

## 실시간 진행이 갱신되지 않아요

리버스 프록시가 server-sent events를 버퍼링하고 있어요. defE2End 사이트의 응답 버퍼링을 끄세요.

## Slack이나 `/api/v1` 응답에 링크가 없어요

`.env`에 `PUBLIC_URL`을 정하고 `docker compose up -d`를 실행하세요([configuration.md](configuration.md)).

## 데스크톱 앱이 열리지 않아요

[desktop-app.md](desktop-app.md#설치와-처음-실행)를 보세요. 회사 정책이 서명 없는 앱을 막는다면 IT 담당자에게 문의하세요.

## MCP 도구가 `desktop-not-running`을 돌려줘요

데스크톱 앱을 켜고 로그인하세요. `defe2end-mcp`는 실행 중인 앱을 거쳐야만 동작해요.

## AI 채팅이 시작하지 않아요

- CLI를 못 찾아요: 설치하고 앱에서 "다시 찾기"를 누르세요.
- 버전이 너무 낮아요: [ai.md](ai.md)의 최소 버전으로 올리세요.
- 로그인이 만료됐어요: 터미널에서 `claude login`이나 `codex login`을 실행하세요.
- "unsafe": CLI가 defE2End 도구 말고 다른 것을 불러왔어요. CLI에 평소와 다른 설정이 있는지 확인하고 앱을 다시 켜세요.
