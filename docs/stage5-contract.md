# 단계 5 계약 — 자동화

> 2026-10-14. 단계 5 를 여러 사람이 나눠 만들 때 서로 맞춰야 하는 결정. 바꾸려면 이 문서부터 고친다. 같은 날 구현 전 검토(11건)를 반영했다.
> 상위 문서: [plan.md](plan.md) 2.1·2.3·5절, [stage3-contract.md](stage3-contract.md)(실행 생성·그룹·상한), [stage4-contract.md](stage4-contract.md), [variables-contract.md](variables-contract.md). 사용자에게 보이는 동작은 [automation-spec.md](automation-spec.md) 에 정리했고, 둘이 다르면 이 문서를 따른다.

## 0. 완료 기준 (plan 8절)

- 예약 중복·놓친 예약 정책: worker 가 여러 개여도 한 예약은 한 번만 돈다. 멈춰 있던 동안의 예약은 실행하지 않고 **전부** "놓침"으로 기록된다. 이전 실행이 남아 있으면 정책대로 건너뛰고 기록된다.
- Slack 실패 재시도: 5xx·429·네트워크 오류는 정해진 횟수까지 다시 보내고, 4xx 는 바로 포기해 웹훅을 "무효"로 표시한다. **시도마다** 기록된다.
- CI 에서 실행→판정: 봇 토큰으로 `/api/v1` 실행 생성(중복 방지 키) → 대기 → 종료 상태로 판정하는 시험이 통과한다. `passed` 만 통과.

## 1. 결정 (2026-10-14)

| 항목 | defE2End |
|---|---|
| 무인 실행의 값 | **스케줄·봇 토큰마다 전용 값과 전용 로그인 세션**(사용자 결정). 사람의 개인 값·세션은 쓰지 않는다. 없으면 명시 오류 |
| 실행 위치 | **서버만**(사용자 결정) |
| 시간대 | 스케줄마다 IANA 시간대, 워크스페이스 기본 시간대 |
| 겹침 | 기본 **건너뛰고 기록**(스케줄마다 "겹쳐도 실행" 선택) |
| 놓친 예약 | 실행하지 않고 **모든 놓친 시각을 기록**(구간 한 줄 + 횟수) |
| 중복 발화 | 스케줄 행 잠금 + (스케줄, 예정 시각) **DB 유일 키** |
| cron 검사 | 저장 때 검사·다음 5회 미리보기, 영영 안 도는 식 거부 |
| 웹훅 | 암호화(끝 4자만 표시), DB 대기열·점유·재시도, 시도별 기록 |
| 일일 리포트 창 | **직전 리포트 이후**의 고정 창 `[from, to)`(첫 리포트는 24시간) |
| 봇 토큰 | 웹에서 관리자가, 만료 필수(기본 90일·최대 365일) |
| CI API | 고정 형식 `/api/v1`, 토큰별 `Idempotency-Key`(24시간), 상한 있는 대기 |
| 무인 실행 재시도 | 단계 3 의 실행 전체 재시도 규칙 그대로 |

### 1.1 무인 실행의 값과 세션
- **스케줄 값**: 스케줄 대상 환경의 **개인 변수**마다 스케줄에 값을 넣는다(비밀이면 암호화·쓰기 전용). 공유 변수는 지금처럼 환경 값. 스케줄의 환경을 바꾸면 스케줄 값은 지워진다(확인 후).
- **봇 값**: 봇 토큰마다 개인 변수 값을 넣는다(토큰은 여러 환경에 쓸 수 있으므로 변수 단위).
- **전용 로그인 세션**: `useAuthSession` 환경이면 스케줄·봇 토큰도 그 환경의 세션을 따로 저장한다. 앱의 캡처 창으로 만든다(단계 4 5절과 같은 흐름, 저장 대상만 스케줄·토큰).
- 실행 생성·발화 때 참조하는 개인 변수의 스케줄(또는 봇) 값이 없거나 세션이 필요한데 없으면: 스케줄은 `refused(variable_missing|auth_session_missing)` 기록·알림, 봇은 `409`. 사람의 값·세션으로 넘어가지 않는다.
- 스케줄·봇 값과 세션을 고칠 수 있는 사람: 스케줄은 `schedule.write`(EDITOR 이상), 봇은 `botToken.write`(ADMIN). 비밀 값은 아무도 다시 볼 수 없다. 바꾼 사람·시각은 감사 기록에 남는다(값 없이).
- 신뢰 모델(plan 1절, 한 설치 = 한 조직): 시나리오 스텝은 편집 권한이 있는 누구나 고칠 수 있고, 스케줄·봇은 그 스텝을 자기 전용 값으로 돌린다. 스텝을 악의로 바꿔 값을 빼내는 것은 같은 조직 안의 신뢰로 다루며 막는다고 약속하지 않는다(문서에 밝힌다).

## 2. 데이터 모델 (`packages/db`, 새 마이그레이션 — 리드)

| 모델 | 핵심 필드 |
|---|---|
| `Workspace` 추가 | `timezone`(IANA, 기본 `UTC`) |
| `Schedule` | `workspaceId`, `name`, `environmentId`, 대상 `scenarioIds`(배열) 또는 `tagId?`(발화 때 그 태그의 보관 안 된 시나리오 전부) — 둘 중 하나, `mode`, `continueOnFailure`, `cron`(5칸), `timezone`, `enabled`, `overlap`(`skip`·`allow`), `nextRunAt?`(DB 시각), `version`(설정을 바꿀 때마다 +1), `createdById`, `updatedById`, 시각들 |
| `ScheduleVariableValue` | `scheduleId`, `variableId`, `value?`, `valueEncrypted?`. 고유(scheduleId, variableId) |
| `ScheduleFire` | `scheduleId`, `scheduledFor`, `status`(`started`·`skipped_overlap`·`missed`·`refused`·`error`), `missedUntil?`·`missedCount?`(놓침 구간), `groupRunId?`, `reasonCode?`, `scheduleVersion`, `createdAt`. **고유(scheduleId, scheduledFor)** |
| `BotToken` | `workspaceId`, `name`, `tokenHash`(고유), `prefix`(앞 8자), `scopes`, `expiresAt`, `revokedAt?`, `lastUsedAt?`, `createdById`, `createdAt` |
| `BotVariableValue` | `botTokenId`, `variableId`, `value?`, `valueEncrypted?`. 고유(botTokenId, variableId) |
| `AuthSession` 변경 | 주인을 `userId?`·`scheduleId?`·`botTokenId?` **중 정확히 하나**로(DB 검사 제약). 고유(environmentId, 주인) — 기존 사람 세션 규칙은 그대로 |
| `ApiIdempotency` | `botTokenId`, `key`, `requestHash`, `runId?`·`groupRunId?`(처음 만든 대상), `createdAt`. 고유(botTokenId, key). 24시간 지난 행은 정리 작업이 지우고, 지워진 뒤 같은 키는 새 요청 |
| `SlackWebhook` | `workspaceId`, `name`, `urlEncrypted`, `urlHint`, `notifyOn`(`failures`·`all`·`changes`), `sources`(`schedule`·`api`·`manual` 복수), `dailyReport`, `reportTime`, `reportTimezone`, `invalidAt?`, `createdById` |
| `ReportWindow` | `webhookId`, `from`, `to`, `deliveryId`. **고유(webhookId, to)** — 같은 창을 두 번 만들지 않는다 |
| `NotificationDelivery` | `webhookId`, `kind`(`run`·`group`·`scheduleFire`·`report`·`test`), `runId?`·`groupRunId?`·`scheduleFireId?`, `payload`(비밀 없음), `status`(`pending`·`sending`·`sent`·`failed`·`dead`), `attempts`, `nextAttemptAt`, `claimToken?`, `leaseExpiresAt?`, `createdAt`, `sentAt?` |
| `NotificationAttempt` | `deliveryId`, `attempt`, `startedAt`, `durationMs`, `statusCode?`, `errorCode?`(값·URL 없이) |
| `Run`·`GroupRun` 추가 | `scheduleId?`·`botTokenId?`(출처, 삭제 시 null). 무인 실행은 `requestedById = null` |

- 웹훅 URL·토큰 원문·비밀 값은 어떤 응답·로그·감사 기록·알림 본문에도 나오지 않는다(토큰 원문은 만들 때 한 번).
- **전용 값의 수명**: 변수 계약 1절의 삭제 규칙(범위 바꿈·비밀 표시 바꿈)은 `ScheduleVariableValue`·`BotVariableValue` 에도 똑같이 적용한다(개인→공유면 전용 값 삭제, 비밀 표시 바꿈이면 삭제). 변수·스케줄·토큰이 지워지면 함께 지운다.

## 3. 공용 생성 함수와 종료 알림 (리드 선행)

- **실행 생성**: 단계 3 의 하나뿐인 생성 함수를 **호출자가 준 트랜잭션 안에서** 돌 수 있게 나누고, 입력에 출처(`trigger`: `manual`·`test`·`schedule`·`api`, `scheduleId?`·`botTokenId?`)와 값 주체(사람 `userId` | 스케줄 | 봇)를 받는다. 그룹도 같은 출처를 기록한다(지금 `manual` 고정인 것을 고친다). 변수·세션 검사는 값 주체 기준(1.1절).
- **종료 알림**: 실행·그룹이 종료 상태로 바뀌는 **모든 경로**(worker 판정, 점유 만료 정리, 취소, 그룹 집계 `settleGroup`, 데스크톱 완료·대조)가 같은 트랜잭션에서 부르는 `enqueueFinishNotifications(tx, …)` 하나를 둔다. 리드가 넣고 종료 경로마다 연결한다(종료됐는데 배달 판단이 안 된 실행이 없어야 한다).

## 4. 스케줄 발화 (`apps/worker` — 스케줄러 담당)

- worker 의 리더 하나(전역 advisory lock — 리더 교체 순간에도 아래 유일 키·행 잠금이 중복을 막는다)가 **15초**마다 `enabled` 이고 `nextRunAt <= now()` 인 스케줄 id 를 고르고, 스케줄마다 **한 트랜잭션**에서:
  1. 스케줄 행을 `FOR UPDATE` 로 잠그고 `enabled`·`nextRunAt` 을 **다시 읽는다**(그사이 꺼졌거나 바뀌었으면 그만). 편집 API 도 같은 행을 잠그고 `version` 을 올린다 — 발화와 편집이 직렬화된다.
  2. 놓침: `nextRunAt` 이 **2분** 넘게 지났으면, 지금까지의 모든 예정 시각을 실행 없이 `missed` 한 줄(`scheduledFor` = 첫 시각, `missedUntil` = 마지막, `missedCount`)로 기록한다.
  3. 아니면 `ScheduleFire(scheduledFor = nextRunAt, scheduleVersion)` 를 넣는다 — 유일 키 충돌이면 그만. 2분 유예 안이라도 `nextRunAt` 과 지금 사이에 지나간 **다른 예정 시각**이 있으면 그것들은 `missed` 구간 한 줄로 기록한다(가장 이른 것만 실행).
  4. `overlap = skip` 이고 이 스케줄의 `queued`·`running` 실행이 있으면 `skipped_overlap`(행 잠금 아래라 다른 예정 시각과도 직렬).
  5. 아니면 3절 생성 함수(같은 트랜잭션)로 그룹 실행: `trigger = schedule`, 값 주체 = 스케줄, `location = server`. 대상 0개면 `refused(no_scenarios)`. 생성 오류(`variable_missing`·`auth_session_missing`·상한)는 `refused(<code>)`.
  6. `refused`·`error`·`missed` 는 같은 트랜잭션에서 `scheduleFire` 알림 배달을 만든다(웹훅의 `sources` 에 `schedule` 이 있을 때).
  7. 다음 `nextRunAt` 을 **지금 이후** 첫 시각으로 계산해 같은 트랜잭션에 저장.
- 시간대: 서머타임으로 없는 시각은 건너뛰고, 두 번 오는 시각은 한 번만. cron 라이브러리는 리드가 고르고 저장·미리보기·발화가 같은 함수를 쓴다.

## 5. Slack 알림 (`apps/worker` — 알림 담당)

- 조건: 실행 출처가 웹훅 `sources` 에 있고, `notifyOn` 이 `all`, `failures`(통과가 아님 — 경고 있는 `passed` 포함), `changes`(같은 시나리오·환경의 직전 종료 실행과 상태가 다름). 그룹은 **한 통**(요약 + 실패 목록 최대 10개), 그룹 자식은 따로 보내지 않는다. 시험 실행·사람이 취소한 실행은 보내지 않는다.
- 보내기(리더 하나, 5초 주기): 배달을 **점유**(`sending`, 새 `claimToken`, `leaseExpiresAt = now() + 30초`)한 뒤 보내고, 결과는 자기 `claimToken` 이고 점유가 유효할 때만 기록한다(늦은 갱신 무시). 점유와 함께 `attempts` 를 올리고 `NotificationAttempt` 시작 줄을 **보내기 전에 같은 트랜잭션으로 커밋**한다(죽어도 시도로 센다). 점유가 만료된 `sending` 은 남은 시도가 있으면 `pending`(다음 간격 뒤), 없으면 `failed`.
- **외부 전송은 최소 한 번**이다: Slack 이 받은 직후 기록 전에 죽으면 다시 보낼 수 있다(중복 가능을 문서에 밝힌다).
- 시도 규칙: 요청 제한 시간 **10초**. **총 4회 시도**(첫 시도 + 재시도 3회, 간격 5초·30초·120초). 5xx·네트워크·제한 시간 → 다음 시도, 다 쓰면 `failed`. 429 → `Retry-After`(최대 10분)를 따르되 같은 횟수 안. 4xx(429 제외) → 바로 `dead`, 웹훅 `invalidAt`. **시도마다** `NotificationAttempt` 한 줄.
- 메시지: 상태 단어, 대상 이름, 환경, 출처(스케줄 이름·봇 이름·사람), 소요 시간, 실패 스텝 번호·이름·사유(가린 값), 결과 링크(`PUBLIC_URL` 없으면 링크 없음). 언어는 워크스페이스 설정(기본 영어). 스케줄 발화 실패(`refused` 등)는 사유 코드와 고칠 곳 링크.
- 테스트 전송: 그 웹훅으로만, 대기열 없이 바로 보내고 결과를 화면에 보여 준다(시도 기록은 남긴다).

## 6. 일일 리포트

- 리더가 리포트를 켠 웹훅마다 `reportTime`·`reportTimezone` 시각이 지났는지 보고, **웹훅 행을 잠근 한 트랜잭션**에서 직전 창과 이번 예정 시각을 다시 계산해 `ReportWindow(from = 직전 창의 to 또는 24시간 전, to = 이번 예정 시각)` 과 `report` 배달을 함께 만든다. 고유(webhookId, to) 라 두 번 만들지 않는다.
- 집계는 고정 창 `[from, to)`: 실행 수·통과율·상태별 수, 새로 실패한 시나리오, 연속 실패(2회 이상), 놓친·건너뛴·거절된 예약 수, 대시보드 링크. 시험 실행 제외. 0건이면 "실행 없음" 한 줄(켜진 스케줄이 있으면 그 사실을 강조).

## 7. 봇 토큰과 `/api/v1` (`apps/web` — API 담당)

- 관리자(ADMIN)가 웹에서 만든다: 이름, 범위(`runs:create`·`runs:read`·`runs:cancel`), 만료(기본 90일, 최대 365일), 봇 값·세션(1.1절). 원문 `d2e_<랜덤>` 은 만들 때 한 번, SHA-256 만 저장. 목록은 이름·앞 8자·범위·만료·마지막 사용·만든 사람. 폐기 즉시 무효.
- 봇 실행은 **봇 값·세션**으로 돌고 `requestedById = null`, `botTokenId` 기록. 실행 위치는 서버만(`location` 이 있으면 `server` 만).
- 엔드포인트(헤더 `Authorization: Bearer d2e_…`, 형식은 `packages/shared/src/api-v1.ts` 에 고정):
  - `POST /api/v1/runs` `{ environmentId, scenarioId } | { environmentId, scenarioIds, mode?, continueOnFailure? } | { environmentId, tag, mode?, continueOnFailure? }`, 헤더 `Idempotency-Key`(필수, 1~128자). **같은 토큰·같은 키**: 같은 본문이면 처음 만든 실행을 돌려준다(태그 요청도 처음 고른 대상 그대로), 다른 본문이면 `409 idempotency_conflict`. `ApiIdempotency` 행은 실행 생성과 **같은 트랜잭션**에 넣는다(동시에 같은 키가 오면 하나만 성공하고 나머지는 그 결과를 읽는다). 정리 작업은 `createdAt` 이 24시간 지난 행만, 그 키로 생성 중인 트랜잭션과 겹치지 않게 행 잠금으로 지운다. 다른 토큰의 같은 키는 서로 무관하다.
  - `GET /api/v1/runs/{id}?wait=<초>`: 최대 60초. 서버는 1초마다 DB 를 읽고, 매번 토큰(폐기·만료)과 워크스페이스를 다시 확인한다. 클라이언트가 끊으면 바로 멈춘다. 동시 대기는 토큰당 5·전체 100(web 프로세스가 여럿이면 프로세스마다 나눈 값 — 1.0 은 web 1개 기준), 넘으면 `429 too_many_waits`.
  - `POST /api/v1/runs/{id}/cancel`.
  - 응답 `{ id, kind, status, startedAt, finishedAt, warningCount, url, children? }`, 오류 `{ error: { code, message } }`. **CI 는 `passed` 만 통과**(`failOnWarning` 은 기존 그대로).
- `lastUsedAt` 은 1분에 한 번 이하로 갱신. 토큰은 자기 워크스페이스 자원만(그 밖은 404).
- 문서 `docs/ci.md`: curl·GitHub Actions 예시(생성 → 대기 → 판정).

## 8. 대시보드 (`apps/web` — API 담당)

- `/w/[slug]/dashboard`: 기간 7·30·90일, 사이트·환경 필터, 날짜 경계는 워크스페이스 시간대.
- 카드: 통과율(취소 제외), 실행 수, 평균 소요 시간, 지금 실패 중 수, 놓친·건너뛴·거절된 예약 수.
- 지금 실패 중: 시나리오×환경의 마지막 실행이 통과가 아닌 것을 **신규**(직전 통과)·**연속**(2회 이상)·**간헐**(최근 5회 안에 통과와 섞임)으로, 같은 실패 스텝·사유가 3개 이상이면 묶음.
- 일별 통과율 추이, 실패 많은 시나리오 상위 10개(기간 안 3회 이상). 시험 실행 제외, A′ Ink 상태색만.

## 9. 권한 (`can()` — 리드)

- `schedule.write`(EDITOR 이상: 만들기·고치기·켜기/끄기·지우기·스케줄 값·세션), `notification.write`(ADMIN), `botToken.write`(ADMIN: 토큰·봇 값·세션). 읽기는 `workspace.read`(비밀 값은 `hasValue` 만).

## 10. 시험

- 스케줄러(실제 Postgres): worker 둘 동시에 한 예약 한 실행, 발화 중 편집·끄기(행 잠금으로 옛 설정 발화 없음), 놓침 구간 기록(여러 시각), 겹침 건너뜀/허용(다른 예정 시각 간), 스케줄 값·세션만 사용(사람 값이 있어도 스케줄 값 없으면 `refused(variable_missing)`), 태그 0개, 서머타임 경계, cron 검사·미리보기, 발화와 실행 생성이 한 트랜잭션(실패 시 둘 다 없음).
- 알림: 조건별, 그룹 한 통, 모든 종료 경로에서 배달 판단(만료·취소·그룹·데스크톱 포함), 점유·늦은 갱신 무시, 재시도 횟수·429·4xx dead, 시도 기록, 웹훅 원문 비노출, 테스트 전송.
- 리포트: 고정 창·0건·같은 창 두 번 안 만듦(동시 두 리더).
- API: 범위·만료·폐기·다른 워크스페이스 404, 봇 값·세션만 사용, 중복 방지 키(같음·다름·다른 토큰·24시간 뒤·태그 대상 고정), `wait`(상한·끊김·대기 중 폐기), 판정, 서버 위치 강제. CI 스크립트로 생성→판정 한 번.
- 대시보드: 분류·묶음·기간 경계는 순수 함수로 시험.

## 11. 진행 순서와 담당 경계

1. **리드**: 2절 마이그레이션, `can()`, 3절 공용 생성 함수(트랜잭션·출처·값 주체)와 `enqueueFinishNotifications` 의 모든 종료 경로 연결, `packages/shared` 의 `api-v1.ts`·알림 본문 타입·cron 함수(라이브러리 선택), 단계 4 프로토콜의 캡처 대상 확장(`capture-auth-state`·등록 본문에 스케줄·봇 대상, 앱 기능 플래그 `auth-session-target` — 이 기능이 없는 앱에는 스케줄·봇 캡처를 보내지 않고 409 `app_update_required`, 등록 때 대상별 권한(`schedule.write`·`botToken.write`)을 다시 검사)과 **앱 쪽 구현**(대상을 그대로 돌려보내기), 변수 해석 함수의 값 주체 확장, 그리고 **worker 점유 결과에 값 주체(사람·스케줄·봇)를 실어** 실행 직전 변수·세션 조회가 같은 주체를 쓰게(지금 worker 는 `requestedById` 로만 세션을 찾는다).
2. **3갈래 병렬**(각 25분 상한)
   - **스케줄러 담당**: 4절 발화, 스케줄 API·화면(목록·편집·미리보기·발화 기록·스케줄 값·세션 만들기).
   - **알림 담당**: 5·6절(배달 점유·보내기·시도 기록·리포트), 웹훅 API·화면(테스트 전송·무효 표시·시도 기록).
   - **API 담당**: 7절 봇 토큰 화면(값·세션 포함)·`/api/v1`·`docs/ci.md`, 8절 대시보드.
