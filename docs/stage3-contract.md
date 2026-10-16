# 단계 3 계약 — 서버 실행

> 2026-10-11. 단계 3 을 여러 사람이 나눠 만들 때 서로 맞춰야 하는 결정. 바꾸려면 이 문서부터 고친다. 같은 날 구현 전 리뷰를 반영했다.
> 상위 문서: [plan.md](plan.md) 2.1·2.2·4.4·4.5·5·6절, [stage2-contract.md](stage2-contract.md). 화면은 `design/export/` 의 ap-2(실행 결과)·s-2(실행 중)·s-3(로딩)·s-4(오류)를 따른다.
> PC 실행(데스크톱 앱)은 단계 4, 시각 회귀·개인정보 마스킹 강화는 단계 7 이다. 여기서는 **서버 worker 실행**만 다룬다.

## 0. 완료 기준

테스트 HTML 준비물(`packages/test-fixtures`)을 대상으로 자동 시험한다.

- 성공·실패(검증 실패)·오류(인프라)·취소·시간 초과가 각각 올바른 종료 상태와 스텝 결과로 끝난다.
- **worker 를 강제 종료(SIGKILL)** 하면 그 실행은 점유 만료 뒤 `error` 로 끝나고 자동으로 다시 돌지 않는다. 그 실행의 Chromium 프로세스가 남지 않는다(4.3절).
- 만료된 worker 의 늦은 쓰기(heartbeat·스텝 결과·산출물·판정)는 반영되지 않는다.
- 취소와 완료가 겹치면 먼저 확정된 쪽이 이기고, 종료 상태는 다시 바뀌지 않는다.
- 자원 상한을 넘는 요청이 동시 요청에서도 정해진 응답으로 거부된다.
- 비밀 변수 원문이 DB·이벤트·텍스트 로그·오류 메시지 어디에도 남지 않는다. 가릴 수 없는 산출물(영상·trace)은 6절 규칙을 따른다.

## 1. 액션 1.0 목록과 판정 의미 (`packages/shared` 스텝 형식)

> **2026-10-12: 이 절은 [action-spec.md](action-spec.md) 로 대체됐다.** 액션 목록·입력 칸·판정 규칙·실행 전체 재시도는 그 문서가 기준이다. 아래 표는 이력으로만 남긴다.

스텝 형식은 공개 전이라 `stepFormatVersion: 1` 을 그대로 두고 확장한다. 모르는 액션·키는 저장 단계에서 거부한다.

| 액션 | target | value | 통과 조건 |
|---|---|---|---|
| `navigate` | — | URL 또는 `/` 로 시작하는 경로(환경 baseUrl 기준) | 문서 로드 완료. 주 문서 응답이 4xx·5xx 면 실패(`options.allowHttpError` 로 끔) |
| `click` | 선택자 | — | 요소가 보이고 클릭 가능해져 클릭됨 |
| `hover` | 선택자 | — | 요소 위에 올림 |
| `fill` | 선택자 | **필수.** 명시적 `""` 는 입력란을 비운다(값 없음은 저장 거부) | 입력됨 |
| `select` | 선택자 | option 의 value, 없으면 label | 선택됨 |
| `press` | 선택자(없으면 페이지) | 키(`Enter`, `Control+a` 등) | 눌림 |
| `upload` | 선택자 | 워크스페이스 첨부 이름(**고정 이름만**, `{{변수}}` 는 저장 거부 — 첨부 버전을 실행 요청 때 고정하므로) | 파일 지정됨. 서버 파일 경로는 쓸 수 없다 |
| `scroll` | 선택자(있으면 화면에 드러냄) | 선택자가 없으면 `x,y` 이동량 | 스크롤됨. 콘텐츠 로드 확인은 별도 검증으로 |
| `wait` | 선택자(있으면 보일 때까지) | 선택자가 없으면 ms(최대 60000) | 조건 충족 |
| `assertText` | 선택자 | 기대 텍스트 | 아래 주석 |
| `assertVisible` / `assertHidden` | 선택자 | — | 제한 시간 안에 보임 / 숨겨짐(요소가 없어도 숨김으로 본다) |
| `assertCount` | 선택자 | 기대 개수 | 개수 일치 |
| `assertAttribute` | 선택자 | `name=value` | 속성 값 일치 |
| `assertUrl` | — | 기대 URL·경로 | `options.match` 규칙 |
| `assertResponse` | — | URL 글롭 | 아래 주석 |
| `dialog` | — | `accept`·`dismiss`·`accept:텍스트` | 아래 주석 |
| `switchPage` | — | `popup`·`main` | 아래 주석 |
| `screenshot` | 선택자(없으면 전체 페이지) | 이름(표시용, 파일 경로로 쓰지 않음) | 저장됨 |

- **텍스트 검증**: 요소의 `innerText` 를 공백 정규화(연속 공백 하나로, 앞뒤 제거)해 비교한다. `options.match`: `contains`(기본)·`equals`·`regex`, `options.caseSensitive`(기본 false). 잘못된 정규식은 저장 거부. 선택자가 여러 요소에 맞으면 실패(`ambiguous_target`) — 정확한 선택자를 요구한다.
- **`assertResponse`**: `options.triggerStepId` 로 요청을 일으키는 앞 스텝을 지정한다. 그 스텝 **실행 전부터** 응답을 모으고, URL(과 `options.method`)이 맞는 **첫 응답**의 상태를 `options.status`(기본 2xx)와 비교한다. 다르면 바로 실패하고 뒤의 성공 응답으로 대신하지 않는다. 응답 없음·요청 실패·시간 초과는 실패.
- **`dialog`**: **바로 다음 스텝 한 번**에만 적용되는 예약이다. 다음 스텝은 대화상자가 뜨고 처리될 때까지 끝나야 통과하고, 안 뜨면 시간 초과 실패. 예약 없이 뜬 대화상자는 닫고 그 스텝을 실패로 한다.
- **`switchPage`**: 팝업 수집은 앞 스텝 실행 전에 시작한다. `popup` 은 바로 앞 스텝에서 열린 **유일한** 팝업으로 바꾸고, 여러 개면 `ambiguous_popup` 실패. `main` 은 처음 페이지.
- 공통 옵션: `timeoutMs`(기본 15000, 최대 600000), `retries`(0~10), `onFailure`(`stop` 기본·`continue`), `frame`(iframe 선택자 — target 이 있는 액션에만).
- **재시도**: `retries` 는 첫 시도에 **더하는** 횟수다. 인프라 오류·취소·전체 시간 초과는 재시도하지 않는다. 바꾸는 액션(click·fill 등)은 페이지를 되돌리지 않고 반복하므로 화면에 "중복 제출 가능" 표시를 한다. `onFailure` 는 재시도가 끝난 뒤 적용한다.
- **변수**: target·value 의 `{{KEY}}` 를 한 번만 치환하고, 결과를 다시 템플릿으로 해석하지 않는다. 없는 키, 값이 비어 있는 비밀 변수는 그 스텝 **실패**(`unknown_variable`·`missing_secret`).
- 선택자는 Playwright 선택자 문법(CSS, `text=`, `role=` 등).
- **스텝 상태**: `passed`·`failed`·`error`(인프라)·`cancelled`·`timed_out`(실행 중단 시 그 스텝)·`skipped`(실행하지 않은 스텝).
- **실행 판정**: 모두 통과 → `passed`. 하나라도 `failed` → `failed`(`continue` 라도). 인프라 → `error`. 중단 원인(취소·전체 시간 초과)으로 브라우저를 닫아 생긴 예외는 `error` 로 덮지 않고 원인대로 판정한다. **CI 는 `passed` 만 통과로 본다**(plan 2.3).

## 2. 데이터 모델 (`packages/db`, 새 마이그레이션 하나 — 책임자: 얇은 흐름 담당)

| 모델 | 핵심 필드 |
|---|---|
| `Run` | `workspaceId`, `scenarioId?`(시험 실행은 없음), `environmentId?`, `groupRunId?`, `groupIndex?`, `trigger`(`manual`·`test`·`schedule`·`api`), `status`, `requestedById?`, `idempotencyKey?`, `requestHash?`, `snapshot`(JSON), `options`(영상 수집 여부 등), `runnerVersion?`, `browserVersion?`, `workerId?`, `claimToken?`, `leaseExpiresAt?`, `heartbeatAt?`, `cancelRequestedAt?`, `queuedAt`, `startedAt?`, `finishedAt?`, `variablesResolvedAt?`, `errorCode?`, `errorMessage?`(가린 값). 고유(workspaceId, idempotencyKey) |
| `StepResult` | `runId`, `index`, `stepId`, `action`, `status`, `attempts`, `startedAt`, `durationMs`, `errorCode?`, `errorMessage?`, `expected?`, `actual?`(모두 가린 값), 고유(runId, index) |
| `Artifact` | `runId`, `workspaceId`, `kind`(`screenshot`·`video`·`trace`·`log`), `stepIndex?`, `storageKey`, `contentType`, `sizeBytes` |
| `GroupRun` | `workspaceId`, `environmentId`, `mode`(`sequential`·`parallel`), `continueOnFailure`, `requestedById?`, `status` |
| `Attachment` | `workspaceId`, `name`, `version`, `storageKey`, `contentType`, `sizeBytes`. 고유(workspaceId, name, version) — 바꾸면 새 버전 |

- **snapshot**(요청 시 고정): 시나리오 이름·스텝, 환경 이름·baseUrl, 기기 설정, 첨부 이름→ID·버전(`attachments: [{ name, id, version }]` — uploadFile 값의 `attachment:<이름>` 토큰이 가리키는 이름만, 요청 시점 최신 버전. 없는 이름이면 스텝 번호와 이름을 담은 400), **변수 키 목록만**. 시나리오를 나중에 고쳐도 결과 화면은 실행 당시 스텝으로 보인다.
- **변수 값**은 worker 가 실행 시작 때 한 번 읽어 실행 동안 고정하고 `variablesResolvedAt` 을 기록한다. 대기 중 변수를 바꾸면 그 값으로 돈다. 재실행은 최신 변수로 새 Run 을 만들므로 과거 입력의 완전 재현은 보장하지 않는다.
- **비밀 값은 DB 의 어떤 실행 관련 필드에도 들어가지 않는다.** worker 가 실행 직전에 복호화해 메모리에서만 쓴다.
- **삭제 정책**: `queued`·`running` 실행이 참조하는 시나리오·환경·첨부의 삭제는 409. 종료된 실행 기록은 참조하던 자원이 지워져도 남는다(`scenarioId`·`environmentId` 는 null 이 되고 snapshot 으로 보여 준다). 워크스페이스 삭제는 실행 기록까지 지운다.

## 3. 생성·점유·상한 (원자성)

- 실행 생성 경로는 **하나**다. 단일·그룹·시험 실행·재실행 모두 같은 서비스 함수를 거친다.
- **생성**: 짧은 트랜잭션 하나에서 워크스페이스 단위 잠금 → 요청자 활성·권한 재검증(단계 2 와 같은 원칙) → 입력 소속 검증(scenario·environment·attachment 가 같은 워크스페이스, environment 는 scenario 의 site 소속) → 대기열 길이·디스크 확인 → Run 생성.
- **중복 방지**: `(workspaceId, idempotencyKey)` DB 고유 제약. 같은 키·같은 요청(`requestHash`)이면 현재 권한을 확인한 뒤 기존 Run 을 돌려주고, 대기열·디스크 상한으로 거부하지 않는다. 같은 키·다른 요청은 `409 idempotency_conflict`.
- **점유**: 짧은 트랜잭션 하나에서 전역 점유 잠금 → 전체·워크스페이스 동시 실행 수 확인 → 한도에 걸린 워크스페이스는 건너뛰고 가장 오래된 `queued` 를 `FOR UPDATE SKIP LOCKED` 로 집음 → `running`, 새 `claimToken`, `leaseExpiresAt = now() + 30s`(DB 시각). 순차 그룹은 앞 자식이 끝나고 계속 조건을 만족한 뒤에만 다음 자식을 집는다.
- 잠금 순서는 고정(워크스페이스 → Run)이고, **브라우저 실행 중에는 DB 트랜잭션을 열어 두지 않는다.**

| 상한 | 기본(측정 전 추정) | 넘으면 |
|---|---|---|
| 전체 동시 실행 `MAX_CONCURRENT_RUNS` | 4 | 점유 안 함 |
| worker 한 개 동시 실행 `WORKER_CONCURRENCY` | 2 | 점유 안 함 |
| 워크스페이스 동시 실행 | 4 | 그 워크스페이스 건너뜀 |
| 워크스페이스 대기열 길이 | 100 | 생성 `429 queue_full`(그룹은 전체 자식 수로 판단, 넘으면 전부 거부) |
| 스텝 제한 시간 | 15초(최대 10분) | 스텝 `failed`(`timeout`) |
| 실행 전체 시간(`startedAt` 부터, 재시도·대기 포함) | 15분 | `timed_out` |
| 저장소 남은 공간 `MIN_FREE_DISK_MB` | 1024 | 생성 `503 storage_low`, worker 도 점유 전 확인 |
| 실행 하나의 산출물·로그 총량 | 200MB | 수집 중단, `error`(`artifact_limit`) |
| 첨부 파일 하나 / 워크스페이스 첨부 총량 | 20MB / 500MB | 업로드 413 |

## 4. 소유권·취소·종료 (worker)

```
queued ──claim──▶ running ──▶ passed | failed | error | timed_out
   │                 │
   └──cancel──▶ cancelled ◀──cancel 확정──┘
```

### 4.1 점유 소유권과 늦은 쓰기
- heartbeat·스텝 결과 저장·산출물 등록·최종 판정은 모두 **Run 행을 잠근 뒤** `status = running` · 자기 `claimToken` · `leaseExpiresAt > now()`(잠금 뒤 DB 시각)를 확인하고 같은 트랜잭션에서 쓴다. 하나라도 어긋나면 쓰지 않는다.
- **만료된 점유는 연장하지 않는다.** 종료 후 도착한 결과는 버리고 그 임시 파일을 지운다.
- heartbeat(10초)는 스텝 실행과 **독립된 타이머**다. 연장에 실패하면 마지막으로 확인된 만료 시각 안에 실행을 멈추고, 그 뒤 새 액션을 시작하지 않는다. 이미 대상 서버에 보낸 요청의 효과를 되돌린다고 보장하지 않는다.
- **만료 정리**: worker 시작 직후와 그 뒤 5초마다, 전역 advisory lock 으로 한 곳만 돈다. 갱신 시점에 만료 조건을 다시 확인하고 `error`(`worker_lost`)로 끝낸다. **자동 재실행하지 않는다.** worker 가 하나뿐이고 멈춰 있으면 정리는 다시 뜰 때까지 늦어진다.

### 4.2 취소·시간 초과·전체 중지
- `cancelRequestedAt` 은 **취소 접수**이지 확정이 아니다. 접수 뒤에도 완료 판정이 먼저 확정되면 그 결과가 남는다. API·화면은 "취소 요청됨"과 `cancelled` 를 구분한다.
- 취소 API 는 Run 행을 잠그고 처리해 `queued → running` 경합에서도 요청을 놓치지 않는다. `queued` 면 바로 `cancelled`. 중복 취소는 같은 결과를 돌려준다.
- 취소와 전체 시간 초과는 스텝 루프와 **독립된 중단 신호**로 브라우저를 닫는다.
- 전체 중지(`run.stopAll`)는 요청 확정 시점에 있던 대기·실행 중만 대상이다(이후 생성을 막는 기능은 아니다).

### 4.3 브라우저 프로세스
- **실행마다 독립된 브라우저 프로세스**를 띄운다. 한 실행의 취소가 다른 실행을 끝내지 않는다.
- 종료 확인: 실행이 끝나면 그 브라우저 프로세스 그룹이 사라진 것을 확인한다.
- worker 가 SIGKILL 로 죽으면 worker 의 정리 코드는 돌지 않는다. 컨테이너에서는 worker 가 PID 1 의 자식 관리자(예: `tini`) 아래에서 돌고, worker 가 죽으면 컨테이너가 끝나며 자식 프로세스도 끝난다. 로컬 실행을 위해 worker 는 **시작할 때 자기 소유의 남은 브라우저 프로세스를 정리**한다(실행별 사용자 데이터 디렉터리로 식별). worker PID 만 SIGKILL 하는 경우를 시험한다.
- SIGTERM: 새 점유를 멈추고 heartbeat 는 유지한다. 유예(기본 30초) 안에 끝나지 않은 실행은 브라우저 강제 종료를 확인한 뒤 `error`(`worker_shutdown`)로 조건부 확정한다. compose 의 `stop_grace_period` 는 이 유예보다 길게 둔다.

### 4.4 그룹 실행
- 그룹과 모든 자식(순번·snapshot 고정)을 **한 트랜잭션**으로 만든다. 그룹은 환경 하나를 쓰므로 같은 site 의 시나리오만 담는다.
- `continueOnFailure = false` 에서 자식이 `passed` 가 아닌 상태로 끝나면, 아직 점유되지 않은 자식은 `cancelled`(`group_stopped`), 실행 중인 자식에는 취소를 요청한다.
- 그룹은 모든 자식이 끝난 뒤에만 끝난다. 집계는 그룹 행을 잠근 뒤 자식 상태를 다시 읽어 계산하고, 섞였을 때 우선순위는 `error > timed_out > failed > cancelled > passed`.
- "실패만 다시"는 `failed`·`error`·`timed_out` 자식으로 새 그룹을 만든다. 이전 결과는 바꾸지 않는다.

## 5. runner (`packages/runner`)

- **DB·저장소를 모르는 순수 실행 엔진.** 입력은 실행 계획(스텝, baseUrl, 치환된 값과 **비밀 참조 위치**, 기기 설정, 제한 시간, 차단 규칙, 수집 옵션), 출력은 이벤트(`stepStarted`·`stepFinished`·`artifact`·`log`)와 최종 판정. 산출물은 `ArtifactSink`(스트림 쓰기 → 완료/실패/취소)로 넘긴다. 단계 4 데스크톱 앱이 같은 runner 를 쓴다. **실행 계획·이벤트·판정·ArtifactSink 스키마는 `packages/shared` 에 두고 얇은 흐름에서 고정한다.**
- Chromium 만. 끝나면 브라우저를 닫고 프로세스 종료를 확인한다.
- **네트워크 차단**: 모든 페이지·iframe·팝업·하위 요청·리다이렉트에 적용한다. 클라우드 메타데이터 주소(`169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal` 등)는 기본 차단하고, 주소는 정규화해 IPv4 대체 표기(10진·16진 등)와 IPv4-mapped IPv6 도 검사한다. **Service Worker 는 막는다**(가로채기를 우회할 수 있으므로). WebSocket 은 같은 규칙을 적용하거나 단계 3 에서는 막는다. `file:` 등 로컬 스킴은 허용하지 않는다. 내부망 대역 차단은 설정으로 켠다. **DNS 재바인딩은 막지 못하며, 완전한 SSRF 차단이라고 표현하지 않는다.**

## 6. 비밀 값과 산출물

- 비밀이 들어간 target·value·expected·actual·오류·콘솔 로그는 **저장하거나 이벤트로 보내기 전에** `maskSecrets` 로 가린다.
- **스크린샷**(실패 캡처 포함)은 비밀 변수로 입력한 입력란을 가린다(Playwright `mask`). 안전하게 가릴 수 없으면 가리지 않은 이미지 대신 "수집 안 함 + 사유"를 기록한다. 입력란 밖에 보이는 개인정보까지 자동으로 가린다고 약속하지 않는다(단계 7).
- 실패 스크린샷은 "항상"이 아니라 **수집을 시도하고, 못 하면 사유를 기록**한다(브라우저가 죽었을 때 등).
- **trace**: 비밀 변수를 쓰는 실행에서는 수집하지 않는다. 그 밖에는 실패 시 수집.
- **영상**: **기본 꺼짐.** 실행 요청에서 명시적으로 켠 경우에만 수집하고, 켤 때 "영상은 비밀·개인정보를 가리지 못해요" 안내를 보여 준다.
- 0절의 "비밀 원문이 남지 않는다"는 DB·이벤트·텍스트 로그·오류에 대한 보장이고, 영상·trace 는 위 규칙(기본 끔·비밀 실행 제외)으로 다룬다.

## 7. 저장소·실시간·API·권한 (`apps/web`)

- 파일 저장소는 `StorageDriver`(`put`·`get`·`delete`·`stat`). 단계 3 은 **로컬 볼륨**(web·worker 공유) 구현만, S3 호환은 나중에 같은 인터페이스로 붙인다. **책임자: worker 담당.**
- `storageKey` 는 서버가 만든다. 사용자 파일명·스크린샷 이름을 경로로 쓰지 않는다. 저장 루트 이탈과 symlink 탈출을 거부한다. 임시 파일에 쓴 뒤 원자적으로 옮기고 Artifact 를 등록한다. 등록에 실패한 파일과 비정상 종료로 남은 임시 파일 정리는 단계 3 에 포함한다.
- 내려받기 `GET /api/w/[slug]/runs/[id]/artifacts/[artifactId]`: workspace·run·artifact 소속을 함께 검증(다른 워크스페이스 404), 종류별 고정 `Content-Type`, `X-Content-Type-Options: nosniff`. HTML 같은 실행 가능한 첨부는 앱 출처에서 inline 으로 주지 않는다(`Content-Disposition: attachment`).
- **SSE** `GET /api/w/[slug]/runs/[id]/events`: 1초마다 DB 를 읽어 바뀐 것을 보낸다. 연결 때와 매 폴링마다 세션·활성 상태·`run.read` 를 확인하고, 권한이 사라지면 보내지 않고 닫는다. 연결이 끊기면 폴링을 멈추고, 종료 상태를 보낸 뒤 닫는다. 재연결하면 현재 상태 전체를 보내고 화면은 Run·StepResult ID 로 합친다. 사용자당 연결 수 상한, `Cache-Control: no-store`. 이벤트 브로커·LISTEN/NOTIFY 는 단계 3 에 쓰지 않는다.
- API(모두 `route()` 래퍼): 실행 생성·조회·목록·취소, 저장 전 시험 실행(본문의 스텝, `trigger: test`, `scenarioId` 없음, 결과 24시간 보관), 그룹 실행 생성·조회, 실패만 다시 실행, 워크스페이스 전체 중지, 첨부 업로드·목록·삭제.
- uploadFile 첨부(액션 명세 3.1 의 defE2End 확장): 편집기 업로드 버튼은 파일을 워크스페이스 첨부로 올리고 값에 `attachment:<이름>` 을 넣는다. 실행은 snapshot 에 고정한 버전을 worker 가 저장소에서 읽어 runner 의 `resolveAttachment` 로 넘긴다(그 뒤 새 버전을 올려도 이 실행은 고정 버전). 고정된 버전은 `queued`·`running` 실행이 있는 동안 삭제 409.
- 권한(`can()` 에 추가, 책임자: 얇은 흐름 담당): `run.read`(VIEWER 이상), `run.create`·`run.cancel`·`attachment.write`(EDITOR 이상), `run.stopAll`(ADMIN).

## 8. worker 이미지

- Chromium 과 의존 라이브러리를 이미지에 넣는다. 비루트 사용자, PID 1 은 자식 관리자(`tini` 등). **Chromium 샌드박스 켬**이 목표다. 기본 Docker 설정에서 샌드박스가 안 되면 필요한 설정(seccomp 프로필 등)을 compose 에 넣고, 그래도 안 되면 리드에게 알린다(조용히 `--no-sandbox` 로 가지 않는다). **책임자: worker 담당.**

## 9. 시험

- runner: 테스트 HTML 로 액션별 통과·실패, 재시도·`continue`, `assertResponse`·`dialog`·`switchPage` 시점 규칙, 변수·비밀 가림(스크린샷 mask 포함), 네트워크 차단(대체 표기·리다이렉트·iframe·Service Worker).
- worker·큐(실제 Postgres): 두 worker 점유 경쟁, 동시 생성의 상한, 늦은 쓰기 무시, 점유 만료 → `error`, 취소/완료 경합, 시간 초과, SIGTERM, **worker PID SIGKILL** 후 브라우저 프로세스 없음, 그룹 중단·집계, 중복 방지 키.
- web: 새 API 는 단계 2 라우트 목록 접근 시험에 자동으로 들어간다. 다른 워크스페이스의 실행·산출물·첨부 ID → 404. SSE 권한 소실 시 종료.

## 10. 진행 순서와 담당 경계

1. **얇은 전체 흐름**(1명): 2절 모델·마이그레이션, `can()` 권한 추가, shared 의 실행 계획·이벤트·판정·ArtifactSink 스키마, 생성·점유 서비스(3절 원자성 포함), 4.1 소유권 검사, 4.2 중단 신호, 4.3 실행별 프로세스 정리, runner 핵심 액션(`navigate`·`click`·`fill`·`assertText`·`screenshot`), 최소 비밀 가림과 메타데이터 차단, 로컬 저장소, 실행 생성·조회·취소 API, 최소 결과 화면. 0절의 성공·실패·취소·강제 종료·늦은 쓰기 시험까지.
2. **3갈래 병렬** (이 경계를 넘는 변경은 리드에게 먼저 알린다)
   - **runner 담당**: 실행 엔진과 1절 액션 전체, 5절 네트워크 차단, 6절 가림·trace·영상 규칙.
   - **worker 담당**: 큐·상태·그룹 서비스, 3절 상한, 4절 전체, 생성·취소·시험 실행·그룹·전체 중지 API, StorageDriver, 8절 이미지.
   - **web 담당**: 조회·목록·SSE·산출물 내려받기·첨부 API와 화면(ap-2·s-2·s-3·s-4), 실행 목록, 시나리오 화면의 시험 실행 버튼·실행 이력 막대, "지난 성공 이후 바뀐 점".
   - DB 마이그레이션·shared 계약 변경은 병렬 단계에서 **리드가 단일 책임자**로 받는다.
