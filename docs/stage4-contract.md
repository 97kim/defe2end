# 단계 4 계약 — 데스크톱 앱

> 2026-10-13. 단계 4 를 여러 사람이 나눠 만들 때 서로 맞춰야 하는 결정. 바꾸려면 이 문서부터 고친다. 같은 날 구현 전 리뷰(15건)를 반영했다.
> 상위 문서: [plan.md](plan.md) 3·4.2·4.3·4.5·5·6절, [stage3-contract.md](stage3-contract.md), [action-spec.md](action-spec.md). 앱 동작의 자세한 설명은 [desktop-spec.md](desktop-spec.md) 이고, 둘이 다르면 이 문서를 따른다.

## 0. 완료 기준

- mac **실제 패키지**에서: 서버 주소 입력 → 로그인 → 연결 → PC 실행(성공·실패·취소) → 녹화 → 시나리오 저장 → 그 시나리오 PC 실행. 패키지는 mac arm64·x64, Windows x64 모두 빌드되고, **Chromium 을 동봉**해 Playwright 캐시 없는 PC 에서도 PC 실행이 된다. Windows 실기 점검은 단계 8 설치 시험에서 한다(2026-10-13 결정).
- 실행 중 네트워크를 끊었다 다시 연결하면 최종 결과가 재전송돼 반영된다. 점유 만료 시간 안에 돌아오지 않으면 그 실행은 `error`(`desktop_lost`)로 끝나고, 그 뒤 도착한 결과는 반영되지 않는다.
- 앱을 강제 종료하고 다시 켜면, 앱이 모르는 대기·실행 중 실행은 재연결 대조로 `error` 가 된다(4.4).
- **구버전 앱 거절**: 최소 버전보다 낮거나 프로토콜이 다른 앱은 연결이 거절되고, 실행에 필요한 기능이 없는 앱에는 실행이 배정되지 않는다(서버 시험 + 앱 대화상자 확인).
- 로그인 세션이 필요한 환경에서 본인 세션이 없으면 실행 생성이 명시 오류로 거부된다. 남의 세션으로 돌지 않는다.
- 원격 페이지가 허용 목록 밖의 IPC 를 부르거나 서버 출처가 아닌 프레임이 부르면 거부된다.
- 비밀 변수 원문이 앱의 디스크(보관함·로그)에 남지 않는다.

## 1. 범위

| 넣음 | 뺌(단계) |
|---|---|
| 연결·인증·버전, PC 실행(단일·그룹·시험), 로그인 세션 저장·사용, 사이드 브라우저, 녹화(시나리오 모드), 격리, mac·Windows 패키지 | 앱 안 AI 채팅·진단·MCP 소켓(6), 서버 경유 브라우저 조작 `browser-op`(없앰 — MCP 소켓으로 대체), 자동화 모드 녹화(없음), 자동 업데이트(없음, 알림만), 실행 후 세션 캡처·로그인 시나리오 자동 갱신(5 이후 검토) |

## 2. 정한 것 (2026-10-13 결정)

| 항목 | defE2End |
|---|---|
| 서버 주소 | 첫 실행 때 입력(HTTPS, `http` 는 `localhost`·`127.0.0.1` 만). 바꾸면 9절 폐기 |
| 앱 토큰 | **불투명 토큰**(해시만 DB), 7일, 기기에 묶임, 폐기 가능. **모든 요청 헤더** |
| 구버전 | 서버가 연결(426)·배정(409)에서 거절 + 앱도 대화상자 |
| 재연결 | 5초 + 0~2초 무작위 |
| 끊긴 RUNNING | **점유 만료 → `error` + 재연결 대조**(사용자 결정) |
| 재연결 시 대기 실행 | `error`(`desktop_reconnected`) |
| 실행 PC | 자동이 기본, 요청에서 기기를 고를 수 있음 |
| 스크린샷 | 별도 업로드 + 크기 상한 |
| 세션 폴백 | **없음** — 다른 사람 세션으로 돌리거나 PC 실행을 서버로 바꾸지 않는다. **명시 오류**(사용자 결정) |
| 세션 만료 | 저장 30일 또는 대상 쿠키 만료 중 이른 쪽 |
| 세션 키 | 환경×사용자(환경이 사이트에 속함) |
| 사이드 브라우저 | **전용 영구 파티션**(사용자 결정), 닫아도 유지 |
| 원격 웹 UI API | **최소 API + 출처 검사**(사용자 결정) |
| sandbox | 모든 뷰 켬 |
| `data-ga-*` 4순위 | 서버 설정 "테스트 속성 목록"(기본 비어 있음) |

## 3. 연결·인증·버전 (`packages/shared/src/desktop-protocol.ts` — 책임자: 리드)

### 3.1 첫 실행·로그인
- 앱 로컬 화면(지금의 `static/`)에서 서버 주소를 받는다. 주소를 정규화(끝 `/` 제거, origin 만)하고 `GET {서버}/api/health` 로 defE2End 서버인지 확인한 뒤 저장한다.
- 메인 창은 **서버 웹 UI 를 기본 세션으로 로드**하고, 사용자는 웹에서 평소대로 로그인한다.
- 첫 화면(로컬 번들)은 서버 연결 전이라 서버 origin 이 없다. 이 화면에는 **정확한 로컬 번들 URL 의 메인 프레임**에서만 `setup`(주소 확인·저장) IPC 를 허용한다(8절).
- 외부 로그인(OIDC·GitHub)은 메인 창 안에서 이어진다. 앱은 `GET {서버}/api/desktop/config` 로 **허용된 인증 origin 목록**을 받아 —서버가 OIDC discovery 의 `authorization_endpoint` origin, issuer origin, GitHub(`github.com`), 관리자가 설정 `DESKTOP_EXTRA_AUTH_ORIGINS` 로 더한 origin 을 모아 준다— 메인 창이 그 origin 으로 이동하는 것만 추가로 허용한다. 그 페이지들은 IPC 를 쓸 수 없다(출처 검사로 거부).
- 앱(메인 프로세스)은 기본 세션의 서버 쿠키로 `POST /api/desktop/token` 을 부른다. 본문 `{ installId, label }`, `Origin` 은 서버 origin 이어야 한다. 응답 `{ token, userId, deviceId, expiresAt }`. 동시에 여러 번 불려도 한 번에 하나만 돈다(desktop-spec 1.2).
- `installId`: 첫 실행 때 만든 UUID(앱 데이터 폴더). **기기 = 설치 × 사용자**: 서버는 (installId, userId) 마다 `DesktopDevice` 를 하나 만들고 그 `deviceId` 를 돌려준다. 같은 PC 에서 계정을 바꾸면 다른 기기가 되어, 이전 사용자의 실행·비밀·세션이 새 계정 연결로 가지 않는다. `label`: 랜덤 4자 또는 사용자 별칭(40자, 표시용). 호스트 이름은 읽지 않는다.
- **소유 일치 규칙**: 모든 앱 API·배정·`run_finalized` 응답은 "토큰의 사용자 = 기기 소유자 = 실행 요청자 = 실행의 `desktopDeviceId`" 를 확인한다. 어긋나면 404. 앱이 받는 desktop API 오류는 최상위 `{ code, … }` 이고, 웹 UI 가 받는 실행 생성 오류는 웹 공통 형식 `{ error: { code, message, … } }` 이다(409 `missing` 도 그 안).
- 토큰은 OS 보안 저장소(Electron `safeStorage`)에만 둔다. 401 이면 교환을 다시 해 **한 번만** 재전송, 403 은 그대로. 새 토큰의 `userId` 가 다르면 진행 중 연결에 넘기지 않는다.

### 3.2 SSE `GET /api/desktop/stream`
- 요청 헤더: `Authorization: Bearer`, `Defe2end-Client: app=<semver>; runner=<semver>; protocol=1`, `Defe2end-Capabilities: <쉼표 목록>`, `Defe2end-Active-Runs: <runId 쉼표 목록>`(4.4).
- 거절: 토큰 무효 401. `protocol` 이 다르거나 `app` 이 최소 버전 미만이면 **426** `{ code: "app_update_required", minimum, downloadUrl? }`(`downloadUrl` 은 서버 환경 변수 `DESKTOP_DOWNLOAD_URL` 이 있을 때만, 없으면 앱이 GitHub Releases 를 연다).
- 메시지(`type`): `connected { connectionId, minimum, serverVersion, recorder: { testAttributes } }`, `run`, `capture-auth-state`, `stop-run { runId }`, `heartbeat`(**30초**). 범위 없는 "전부 중지" 메시지는 두지 않는다(연결은 사용자 단위라 다른 워크스페이스 실행까지 멈출 수 있으므로) — 워크스페이스 전체 중지도 실행마다 `stop-run` 으로 보낸다.
- 앱: 75초 무수신이면 끊고 재연결. 오류 시 5초 + 0~2초 무작위 뒤 재연결, 401·426 은 각각 토큰 재교환·대화상자.
- 서버는 연결마다 새 `connectionId` 를 만들어 `DesktopDevice` 에 **현재 연결**로 기록한다(버전·기능·`connectedAt`·`lastSeenAt`, 15초마다 갱신). **온라인 = `lastSeenAt` 이 45초 이내.** 연결 상태를 프로세스 메모리에만 두지 않는다(web 이 여러 개여도 배정이 되게).
- **연결 세대**: 기기의 현재 `connectionId` 가 아닌 스트림은 배정·`stop-run` 을 보내지 않고 스스로 닫는다. 같은 기기의 새 연결이 생기면 옛 스트림은 다음 폴링에서 닫힌다.
- **권한 재검사**: 스트림은 1초 폴링마다 토큰(폐기·만료)·사용자 활성을 확인하고, 실행을 보낼 때마다 요청자의 그 워크스페이스 `run.create` 권한을 다시 확인한다(단계 3 원칙). 토큰이 무효가 되면 그 자리에서 닫는다. 권한이 사라진 실행은 보내지 않고 `error`(`permission_lost`).

### 3.3 버전·기능
- `DESKTOP_PROTOCOL_VERSION = 1`. 최소 앱 버전은 서버 환경 변수 `DESKTOP_MIN_VERSION`, 비면 shared 상수(서버 N → 앱 N-1, plan 6절).
- 기능 목록 = 앱이 실행할 수 있는 **액션 이름 전부** + 기능 플래그(`stop-run`, `auth-session`, `video`, `test-run`). 서버는 실행을 만들 때 snapshot 의 액션·옵션이 대상 기기의 기능에 다 있는지 보고, 없으면 **409** `app_update_required { missing }`(426 본문과 다른 스키마, `minimum` 없음). 버전 비교는 SemVer 우선순위(`+build` 무시, 프리릴리스는 정식보다 낮음).
- 앱의 강제 업데이트 대화상자: 버튼 [다운로드 페이지 열기](GitHub Releases) [종료]. 새 버전 알림은 앱 시작 때·하루 한 번 GitHub Releases 최신 버전을 확인하고, 설정으로 끌 수 있다.

## 4. PC 실행

### 4.1 생성·배정 (`packages/db` — 리드)
- `Run` 에 `location`(`server` 기본·`desktop`)과 `desktopDeviceId?` 추가. 실행 생성 API 는 `location`·`deviceId?` 를 받는다. 생성 경로는 단계 3 의 하나뿐인 서비스 함수 그대로. 그룹은 위치·기기를 그룹 단위로 정하고 자식이 모두 따른다.
- 기기: `deviceId` 가 있으면 **요청자 본인 기기이고 온라인**이어야 한다. 없으면 요청자의 가장 최근 온라인 기기. 없으면 **409** `desktop_not_connected`.
- **worker 는 `location = desktop` 을 집지 않는다.** PC 실행은 워크스페이스 대기열 길이(100)에 들어가고 서버 동시 실행 수에는 들어가지 않는다. 앱 동시 실행은 기본 1, 동시 그룹은 메시지의 `concurrency`(앱 상한 **4**).
- 배정: 기기의 **현재 연결** SSE 를 쥔 web 프로세스가 **1초마다** 그 기기의 `queued` 이고 아직 안 보낸 실행 중 **시작 가능한 것**(그룹 자식이면 단계 3 점유와 같은 조건: 순차 그룹은 앞 자식이 모두 끝났고, `continueOnFailure = false` 그룹은 끝난 자식이 모두 `passed`)을 읽는다. 행을 잠그고 현재 연결인지 다시 확인한 뒤 `dispatchedAt`·`dispatchedConnectionId` 를 기록하고 `run` 을 보낸다. 보내기에 실패해도 바로 실패시키지 않는다(재연결 대조가 정리). 그룹 조건 판정은 worker 의 점유 쿼리와 **같은 db 함수**를 쓴다.
- `run` 메시지: 실행 계획(단계 3 shared 스키마 + `storageState?`), **해석된 변수 값과 비밀 참조 위치**, 첨부 목록, **실행 정책**(전체 재시도 횟수·전체 제한 시간·영상·trace 여부 — 서버가 확정), `concurrency`. 변수는 보낼 때 한 번 읽고 `variablesResolvedAt` 을 기록한다. 앱은 이 메시지를 **메모리에만** 둔다.

### 4.2 시작·소유권·점유
- 앱은 `POST /api/desktop/runs/{id}/start`(`Idempotency-Key: run-start-{id}`)로 시작을 알린다. 서버는 행을 잠그고 그 기기에 배정됐는지, **그룹 시작 조건을 다시** 확인한 뒤 `queued` 면 `running`·새 `claimToken`·`leaseExpiresAt = now() + 90초` 로 바꾸고 `{ status, claimToken }` 을 준다. 이미 같은 기기의 `running` 이고 점유가 유효하면 **같은 `claimToken` 을 다시** 준다(응답 유실 대비). `cancelled` 등 종료 상태면 그대로 알려 앱이 끝낸다. 앱은 실행 번호마다 브라우저를 **한 번만** 띄운다. 재시도 일정은 desktop-spec 2.2.
- 그 뒤 모든 쓰기(heartbeat·스텝·산출물·완료)는 **단계 3 의 4.1 소유권 검사와 같은 규칙**(행 잠금 → `running`·자기 `claimToken`·`leaseExpiresAt > now()`)을 거친다.
- heartbeat: 앱은 실행마다 **15초**마다 `POST …/heartbeat`, 서버는 `leaseExpiresAt = now() + 90초` 로 연장하고 응답에 `leaseRemainingMs` 를 준다. 앱은 이 값을 **요청을 보낸 시점부터 단조 시계로** 센다(서버·PC 시계 비교 금지). 같은 기기의 start 재요청도 점유를 연장하고 `leaseRemainingMs` 를 준다. 실행이 끝난 뒤에도 **완료가 받아들여지거나 `run_finalized` 를 받을 때까지** 계속 보낸다(보관함 재전송 전에 만료되지 않게). 만료된 점유는 연장하지 않는다.
- **소유권 상실**: heartbeat·쓰기가 `409 lease_lost`·404 를 받으면 앱은 그 실행을 **10초 안에** 중단하고(브라우저 종료) 남은 결과를 보내지 않는다. **응답이 없을 때**는 마지막으로 성공한 heartbeat 의 `leaseExpiresAt`(서버가 응답에 실어 줌)에서 **10초 전**까지 연장하지 못하면 스스로 중단한다. 이미 끝난 실행은 중단할 것이 없으니 보관함 재전송만 계속한다.
- **보관함 정리**: `run_finalized`·2xx 를 받으면 지운다. 소유 불일치·삭제된 실행으로 **404**, 또는 점유를 잃어 **409 `lease_lost`** 를 받으면(서버가 곧 `desktop_lost` 로 끝낸다) 그 파일은 격리 폴더로 옮기고 역압에서 뺀다(다시 보내지 않음).
- **만료 정리**: worker 의 기존 정리 작업(5초)이 `location = desktop` 도 다룬다. 만료되면 `error`(`desktop_lost`). 자동 재실행하지 않는다. 오프라인이 90초를 넘으면 늦게 온 결과는 반영되지 않는다(plan 5절 "시간 안에 안 오면 `error`").
- 만료·대조·완료·취소 확정은 모두 **그룹 집계(`settleGroup`)** 로 이어진다.

### 4.3 결과·산출물
- **실행 전체 재시도**(action-spec 4.3)는 지금 worker 에 있다. 리드가 재시도 루프를 `packages/runner` 의 공용 함수로 옮기고 worker·앱이 같이 쓴다. 앱은 `run` 메시지의 실행 정책을 따른다. 모든 스텝 결과·산출물에 `attempt` 가 붙는다.
- 스텝: `POST /api/desktop/runs/{id}/steps`(`stepStarted`·`stepFinished` 이벤트, 단계 3 스키마, `(attempt, index)` 로 멱등). 실시간 표시용 최선 노력이다. 유실돼도 완료 때 복구된다(아래).
- 산출물: `PUT /api/desktop/runs/{id}/artifacts/{kind}/{attempt}/{key}`(`claimToken` 은 헤더 `Defe2end-Claim-Token`, 응답은 `artifactRef`) — `kind` 는 단계 3 과 같은 `screenshot`·`video`·`trace`·`log`, `key` 는 스크린샷 `step-{index}`·영상 `main`·`popup-N`·trace `trace`·로그 `log`. 스트리밍, `Content-Length` 필수, 하나 상한 스크린샷 **10MB**·그 밖 실행 총량 안. 같은 키 재업로드는 **교체**이고 총량은 키마다 한 번만 센다. 총량(단계 3 과 같은 **200MB**)은 서버가 행 잠금 아래 계산하고, 넘으면 **413** → 앱의 `ArtifactSink` 가 `ArtifactLimitError` 를 던져 worker 와 같이 `error`(`artifact_limit`)로 끝난다. 저장은 단계 3 `StorageDriver`.
- 첨부: `GET /api/desktop/runs/{id}/attachments/{attachmentId}`(소유권 검사, snapshot 에 고정된 버전만).
- 완료: `POST /api/desktop/runs/{id}/complete { claimToken, verdict, stopCause, attemptCount, passedAfterRetry, durationMs, steps }`. `steps` 는 **모든 시도의 스텝 결과 전체**(가린 값, action-spec 4.3)로, 서버가 `(attempt, index)` 로 덮어써 유실된 스텝을 복구한다. `stopCause` 는 `none`·`cancelled`·`timed_out`·`infra { code }`(브라우저 시작 실패 등) — 스텝만으로는 복원할 수 없는 중단 원인이다. 앱은 runner 와 shared 판정 함수로 `verdict` 를 정하고, 서버는 `judgeRun(steps, stopCause)` 를 다시 돌려 다르면 `error`(`verdict_mismatch`)로 저장한다. 리드가 shared 판정 함수에 `stopCause` 입력을 더한다.
- 이미 끝난 실행에 온 완료는 소유 일치 확인 뒤 **409** `run_finalized { status }` — 앱은 이를 종결 응답으로 보고 보관 파일을 지운다.
- **보관함**: 완료 본문 전체(스텝 포함)를 보내기 전에 디스크에 쓴다(서버 origin 의 SHA-256 폴더, 0700). 파일에는 **서버 origin·userId·deviceId** 를 함께 기록하고, 그 셋이 지금 토큰과 같을 때만 보낸다. 쓰기 전에 `maskSecrets`. 재시도·역압·깨진 파일 격리는 desktop-spec 2.4.
- **`claimToken` 없는 완료는 없다.** 시작 전(대기열) 취소는 서버가 이미 `cancelled` 로 확정한 것이므로 앱은 대기열에서 빼기만 한다.

### 4.4 취소·재연결 대조
- 취소는 단계 3 4.2 그대로 행 잠금으로 접수한다. `queued` 면 바로 `cancelled`. 기기의 SSE 쪽이 `cancelRequestedAt` 이 있고 끝나지 않은 실행에 `stop-run` 을 보내고, 재연결 때마다 다시 보낸다. 전체 중지(ADMIN)는 워크스페이스의 PC 실행도 포함한다.
- **재연결 대조**: SSE 연결 때 `Defe2end-Active-Runs` 를 받는다 — 앱이 **받아 둔 대기열 + 실행 중 + 보관함에 완료가 남은** 실행 전부. 대조 대상은 그 기기에서 **이전 연결로 배정된**(`dispatchedConnectionId` 가 이번 연결이 아니고 `dispatchedAt` 이 이번 연결 시각 전) 실행뿐이다. 아직 안 보낸 `queued` 는 건드리지 않는다. 목록에 없는 것: `queued` → `error`(`desktop_reconnected`), `running` → `error`(`desktop_lost`). 행 잠금 뒤 조건부 갱신이라 그 사이 완료가 먼저 확정되면 완료가 이긴다.

### 4.4.1 브라우저 표시 (2026-10-13 결정)
- PC 실행(시험 실행 포함)은 **기본으로 브라우저 창을 보여 준다**. 앱 설정 "브라우저 숨기고 실행"을 켜면 headless 로 돈다. 이 설정은 PC 하나의 로컬 설정이라 서버로 보내지 않고, 서버 실행(worker)은 늘 headless 다.
- 실행 중 사용자가 브라우저 창(또는 첫 페이지)을 직접 닫으면 **`cancelled`** 로 끝내고 다시 시도하지 않는다(2026-10-13 결정). 스텝은 중단 원인대로 `cancelled`, 남은 스텝은 `skipped`. runner 가 스스로 닫은 경우와 구분한다.
- 창을 보이려면 화면 있는 Chromium 이 필요하므로, 패키지에는 headless shell 대신 **runner 의 Playwright 버전에 맞는 Chromium** 하나를 넣고 두 모드 모두 그것으로 띄운다.

### 4.5 시험 실행
- 저장 전 시험 실행도 `location = desktop` 으로 같은 경로(`trigger: test`). 취소는 4.4 와 같다.

## 5. 대상 사이트 로그인 세션

- 모델 `AuthSession`: `workspaceId`, `environmentId`, `userId`, `encryptedState`(단계 2 비밀 값과 같은 설치 키·AES-256-GCM), `cookieCount`, `sizeBytes`(≤ **512KB**), `savedAt`, `expiresAt`. 고유(environmentId, userId).
- `expiresAt` = `savedAt + 30일` 과 "대상 host 쿠키 중 만료 시각이 있는 것의 가장 늦은 값" 중 이른 쪽. 만료된 세션은 없는 것으로 본다.
- `Environment.useAuthSession`(기본 false). 켠 환경의 실행은 **요청자 본인의 유효한 세션**이 있어야 생성된다. 없으면 서버·PC 실행 모두 **409** `auth_session_missing`. 작성자·다른 사람 세션으로 대신하지 않고, 실행 위치도 바꾸지 않는다. 사람 요청자가 없는 실행(스케줄·API)은 단계 5 에서 정하고, 그 전엔 같은 오류.
- 주입: 실행 계획에 `storageState?`(Playwright 저장 상태 형식)를 더하고, runner 가 실행마다 새 컨텍스트를 만들 때 넣는다. 계획과 같이 **메모리에만**, 저장·로그·이벤트에 싣지 않는다. 이 스키마·runner 변경은 리드 선행 작업이다.
- 서버 실행은 worker 가 실행 직전 복호화해 계획에 넣는다. PC 실행은 `run` 메시지로 그 실행의 기기(소유 일치)에만 보낸다. 다른 기기·다른 사용자에게 보내지 않는다.
- 만들기: (1) 사이드 브라우저 "이 사이트 로그인 저장" — 현재 탭 host 와 상위 도메인 쿠키만, localStorage 는 현재 origin(desktop-spec 3.1-2). (2) 웹 UI 의 "로그인 세션 만들기" → SSE `capture-auth-state` → 앱이 화면 있는 Chromium 을 띄우고 2.5초마다 스냅샷, 닫으면 등록(desktop-spec 3.1-1). 등록 `POST /api/desktop/auth-sessions`, 소유자는 토큰의 사용자.
- 쿠키 값·토큰은 어떤 로그에도 남기지 않고 개수만. 목록 API 는 본인 것만 메타(환경·저장·만료 시각·쿠키 수)를 준다. 삭제는 본인.
- 권한: `authSession.write`(EDITOR 이상, 본인 것만).

## 6. 사이드 브라우저

- 메인 창 안 `WebContentsView` 탭들, 위치·크기는 웹 UI 가 준 영역. 열기·닫기·최소화·새 창 처리·기기 보기는 desktop-spec 4장 그대로.
- **파티션 `persist:defe2end-target` 하나**: 서버 웹 UI 와 쿠키·저장소가 섞이지 않는다. 닫거나 앱을 다시 켜도 남는다. 앱 설정에 "사이드 브라우저 데이터 지우기", 서버 주소를 바꾸면 자동으로 지운다.
- 권한 요청(알림·위치·카메라 등)은 모두 거절. 다운로드는 막는다.

## 7. 녹화 (`packages/recorder` 새 패키지 + 앱 preload)

- 세 부분으로 나눈다.
  - **DOM 수집**(녹화 담당, 탭 preload): 셀렉터 후보·클릭·입력·키·스크롤·우클릭·대화상자 감싸기. 원천 이벤트를 IPC 로 보낸다.
  - **녹화 제어**(앱 담당, 메인 프로세스): 시작·정지, 시작 탭과 새 창 계보, 메인 프레임 이동, 페이지·프레임 재주입, 원천 이벤트 보관·버리기, 이벤트마다 변환기를 불러 웹 UI 로 결과 보내기, 기기 전환 금지.
  - **변환기**(녹화 담당, `packages/recorder`): 원천 이벤트 → 스텝·경고. **Electron 을 모르는 순수 함수**, 이벤트 준비물로 시험.
- 원천 이벤트 타입과 웹 패널 결과 형식 `RecordingResult { steps, sourceEventIds, warnings, origin, eventCount, device }`(`sourceEventIds[i]` 는 스텝 i 를 만든 원천 이벤트 ID 목록 — 합쳐지거나 나뉜 스텝을 지울 때 버릴 이벤트를 정한다) 는 리드가 병렬 전에 고정한다.
- 규칙은 desktop-spec 5장(셀렉터 후보 순서·재정렬, 기록 시점, 대화상자·팝업·iframe, 비밀번호, 스텝 이름)을 따르되:
  - **시나리오 모드만.** 탭 전환·자동화 변환 없음.
  - 셀렉터 4순위는 `connected.recorder.testAttributes` 의 속성 목록 순서(기본 비어 있으면 건너뜀). 서버 설정 `InstanceSetting` 에 둔다.
  - 출력은 action-spec 액션 이름 그대로(`click`·`fill`·`select`·`pressKey`·`scroll`·`hover`·`waitForUrl`·`assertUrl`·`waitForSelector`·`assertVisible`·`assertVisibleOrWarn`·`assertText`·`clickAndAcceptDialog`·`clickAndDismissDialog`·`clickAndSubmitPrompt`·`clickAndWaitPopup`·`clickInPopup`·`fillInPopup`·`assertVisibleInPopup`·`assertPopupUrl`·`closePopup`·`clickInIframe`·`fillInIframe`·`goto`·`screenshot`). shared 스텝 스키마를 통과하지 못하는 스텝은 만들지 않는다.
  - 비밀번호는 `{{PASSWORD}}` 고정. prompt 는 "직접 추가하세요" 경고.
- 결과는 웹 UI 녹화 패널로 가고, **저장은 기존 시나리오 API 로 사용자가 한다**(AI 없음). 녹화 중 기기 전환 금지.

## 8. Electron 격리

- 모든 뷰 `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. 사이드 브라우저 탭만 `nodeIntegrationInSubFrames: true`(녹화 preload 를 iframe 에서도) — preload 는 Node 없이 `ipcRenderer` 만 쓴다.
- **메인 창 preload API**(이것만): `connection`(상태 구독·연결·해제·로그아웃·별칭), `sideBrowser`(열기·닫기·영역·이동·기기·탭·세션 저장), `recorder`(시작·정지·이벤트 버리기·검증 추가·이벤트 구독), `runs`(진행 구독), `app`(버전·서버 주소 바꾸기). AI·CLI·파일 열기는 없다.
- **모든 IPC 처리기**: 메인 창의 메인 프레임이고 `senderFrame.origin` 이 저장된 서버 origin 일 때만 처리. 예외는 `setup` 하나로, 정확한 로컬 번들 URL 의 메인 프레임에서만. 사이드 브라우저 발 IPC 는 알려진 탭의 webContents 인지 확인. 어긋나면 무시하고 로그.
- 메인 창 이동은 서버 origin 과 허용된 인증 origin(3.1) 안에서만. 그 밖의 `http(s)` 링크는 시스템 브라우저로, 그 밖 스킴은 막는다. 새 창은 막는다. 권한 요청은 모두 거절.

## 9. 서버 주소 변경·로그아웃

- 앱은 **연결 세대 번호**(로그인·서버 변경·계정 변경마다 1씩 늘어나는 앱 안 카운터)를 쥐고, 모든 작업(실행·캡처·토큰 교환·HTTP 요청)에 붙인다. 번호가 바뀌면 옛 번호의 콜백·응답은 버린다(같은 계정으로 다시 로그인해도 옛 작업은 섞이지 않는다). 보관함 파일은 4.3 의 서버 origin·userId·deviceId 로 거른다.
- 서버 주소를 바꾸거나 로그아웃하거나 계정이 바뀌면 순서대로: SSE 종료 → 진행 중 실행·캡처 중단(브라우저 종료, 최대 5초) → 진행 중 HTTP 요청 취소 → 옛 서버에 `DELETE /api/desktop/token`(최선 노력, 2초) → 보안 저장소의 토큰 삭제 → 기본 세션의 서버 쿠키 삭제(로그아웃이면 웹 로그아웃 API 도 먼저 부름 — 쿠키로 토큰을 다시 교환하지 못하게) → **사이드 브라우저 파티션 삭제**(다음 사용자가 이전 사용자의 대상 사이트 로그인을 쓰지 못하게) → 새 세대 시작. 중단된 실행의 결과는 보내지 않는다(서버에서는 점유 만료로 `error`). 옛 세대의 보관함은 지우지 않지만 세대가 다르므로 보내지 않는다.
- 웹에서 로그아웃하거나 계정이 비활성화되면 그 사용자의 앱 토큰을 모두 폐기한다.

## 10. 데이터 모델 (새 마이그레이션 하나 — 리드)

| 모델 | 핵심 필드 |
|---|---|
| `DesktopDevice` | `id`(= deviceId), `installId`, `userId`, `label`, `appVersion?`, `runnerVersion?`, `capabilities`(문자열 배열), `connectionId?`(현재 연결), `connectedAt?`, `lastSeenAt?`, `createdAt`. 고유(installId, userId) |
| `DesktopToken` | `tokenHash`(고유), `userId`, `deviceId`, `expiresAt`, `revokedAt?`, `lastUsedAt?` |
| `Run` 추가 | `location`, `desktopDeviceId?`, `dispatchedAt?`, `dispatchedConnectionId?` · 인덱스(desktopDeviceId, status) |
| `GroupRun` 추가 | `location`, `desktopDeviceId?` |
| `StepResult` | 고유를 (runId, attempt, index) 로(지금과 다르면) |
| `AuthSession` | 5절 |
| `Environment` 추가 | `useAuthSession` |

권한(`can()`): `desktop.connect`(활성 사용자), `authSession.write`(EDITOR 이상·본인). PC 실행 생성은 기존 `run.create`.

## 11. 시험

- **서버(실제 Postgres)**: 토큰 교환(Origin 검사·폐기·만료), 같은 설치의 계정 전환 → 다른 기기·이전 실행 안 감, 열린 스트림에서 토큰 폐기·권한 회수 → 닫힘·`permission_lost`, 426(낮은 버전·다른 프로토콜), 기능 부족 409, 기기 선택·`desktop_not_connected`, worker 가 PC 실행을 안 집음, 옛 연결은 배정 안 함, start 조건부 갱신·응답 유실 재요청, 그룹 순차·중단 조건(배정·start 둘 다), 소유권 검사·늦은 쓰기 무시, 완료 전까지 heartbeat 연장, 점유 만료 → `error`, 재연결 대조(받아 둔 대기열 보존·새 `queued` 보존·경합), 취소·전체 중지 → `stop-run`, `run_finalized`(소유 일치), 완료의 스텝 복구·`verdict_mismatch`·`stopCause`, 산출물 총량(교체·동시 업로드)·413 → `artifact_limit`, 세션 필수 환경의 `auth_session_missing`(남의 세션이 있어도), 세션 암호화·만료·512KB, 다른 워크스페이스 ID 404.
- **앱(vitest, Electron 없이 되는 부분)**: SSE 클라이언트(무수신 75초·재연결·세대 번호), 토큰 재교환 단일화, 보관함(먼저 쓰기·재시도·복구·격리·가림·세대 불일치 미전송), 소유권 상실 시 10초 안 중단, 세대 전환 순서, IPC 출처 검사(`setup` 예외 포함), 서버 주소 정규화.
- **녹화 변환기**: desktop-spec 5장 규칙별 이벤트 준비물 → 기대 스텝. 셀렉터 후보는 테스트 HTML 로.
- **패키지 실기**(리드, 마지막): 0절 흐름을 mac·Windows 패키지에서 수동 점검표로.

## 12. 진행 순서와 담당 경계

1. **리드**: 10절 마이그레이션, `desktop-protocol.ts`(메시지·헤더·기능 목록·오류 코드·완료 본문 스키마), `can()` 추가, 실행 계획 `storageState?`와 runner 주입, 실행 전체 재시도 루프를 runner 공용 함수로 이동(worker 가 그걸 쓰게), 판정 함수 `stopCause` 입력, 그룹 시작 조건 db 함수 분리, `packages/recorder` 빈 패키지와 원천 이벤트·`RecordingResult` 타입. 이게 머지된 뒤 병렬.
2. **3갈래 병렬**(각 25분 상한, 경계를 넘는 변경은 리드에게)
   - **서버 담당**(`apps/web`·`apps/worker`·`packages/db` 서비스): 3·4·5·9절 서버 쪽 API와 SSE·배정·대조, worker 정리 확장, 웹 UI(실행 위치·기기 선택, 로그인 세션 화면, 환경의 세션 필수 설정, 녹화 패널과 저장).
   - **앱 담당**(`apps/desktop`): 3절 앱 쪽, 4절 실행(runner 사용)·보관함, 6절, 7절의 녹화 제어, 8절, 9절 앱 쪽, 패키징.
   - **녹화 담당**(`packages/recorder` + 탭 녹화 preload): 7절의 DOM 수집·변환기. 앱 담당과는 리드가 1에서 고정한 원천 이벤트·`RecordingResult` 형식으로만 만난다.
