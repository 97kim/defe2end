# 설정

모든 설정은 환경 변수예요. 예시 compose 파일을 쓰면 `deploy/.env`에 적고, compose가 컨테이너로 넘겨요. 바꾼 뒤에는 `docker compose up -d`를 다시 실행하세요.

"서비스"는 그 변수를 읽는 컨테이너예요. 필수 변수는 기본값이 없고, 없으면 컨테이너가 시작하지 않아요.

영어판 표([../configuration.md](../configuration.md))는 시험(`packages/shared/src/env-docs.test.ts`)으로 코드와 대조해요. 이 표는 영어판과 같은 내용이에요.

## compose와 DB

| 변수 | 서비스 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `DEFE2END_VERSION` | compose | 예 | — | 실행할 이미지 버전(예: `1.0.0`). `web`, `worker`, `migrate`를 같은 릴리스로 고정해요. |
| `WEB_PORT` | compose | 아니요 | `3000` | 웹 화면과 API의 호스트 포트. |
| `POSTGRES_USER` | compose | 아니요 | `defe2end` | 함께 뜨는 Postgres의 DB 사용자. |
| `POSTGRES_PASSWORD` | compose | 예 | — | DB 비밀번호. |
| `POSTGRES_DB` | compose | 아니요 | `defe2end` | DB 이름. |
| `DATABASE_URL` | web, worker, migrate | 예 | compose가 만듦 | Postgres 연결 문자열. compose가 위 세 값으로 만들어요. 외부 Postgres를 쓰려면 직접 정하세요. |
| `STORAGE_DIR` | web, worker, migrate | 아니요 | `./data/storage`(compose: `/data/storage`) | 스크린샷·영상 같은 실행 파일 폴더. `web`, `worker`, `migrate`(백업·복원)가 함께 써야 해요. |

## 보안과 로그인

| 변수 | 서비스 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `DEFE2END_ENCRYPTION_KEY` | web, worker, migrate | 예 | — | 정확히 32바이트의 base64(`openssl rand -base64 32`). 비밀 변수를 암호화해요. 백업과 떨어진 곳에 보관하세요. DB를 처음 만들 때의 키와 다르면 web 서버가 시작하지 않아요. |
| `BETTER_AUTH_SECRET` | web | 예 | — | 세션 서명용 비밀 값, 32자 이상. |
| `BETTER_AUTH_URL` | web | 아니요 | `http://localhost:3000` | 사용자가 여는 주소(스킴·호스트·포트). 로그인 콜백, 설정·재설정 링크에 써요. https면 쿠키에 `Secure`가 붙어요. |
| `PUBLIC_URL` | web, worker | 아니요 | — | 화면 밖으로 나가는 링크의 공개 주소: Slack 메시지, 일일 리포트, `/api/v1` 응답의 `url`. 없으면 그 링크가 빠져요. 보통 `BETTER_AUTH_URL`과 같아요. |
| `OIDC_DISCOVERY_URL` | web | 아니요 | — | OpenID Connect discovery 주소(`…/.well-known/openid-configuration`). 이 값과 `OIDC_CLIENT_ID`가 있으면 OIDC 로그인이 켜져요. 리디렉션 URI: `<BETTER_AUTH_URL>/api/auth/oauth2/callback/oidc`. |
| `OIDC_CLIENT_ID` | web | 아니요 | — | OIDC 클라이언트 ID. |
| `OIDC_CLIENT_SECRET` | web | 아니요 | — | OIDC 클라이언트 비밀 값. |
| `OIDC_PROVIDER_NAME` | web | 아니요 | `OIDC` | 로그인 버튼에 보이는 이름. |
| `GITHUB_CLIENT_ID` | web | 아니요 | — | GitHub OAuth 앱 클라이언트 ID. GitHub 값 두 개가 다 있으면 GitHub 로그인이 켜져요. 콜백 URL: `<BETTER_AUTH_URL>/api/auth/callback/github`. |
| `GITHUB_CLIENT_SECRET` | web | 아니요 | — | GitHub OAuth 앱 클라이언트 비밀 값. |

## 데스크톱 앱

| 변수 | 서비스 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `DESKTOP_MIN_VERSION` | web | 아니요 | `0.0.0` | 서버가 받는 가장 오래된 앱 버전. 더 오래된 앱에는 업데이트를 안내해요. |
| `DESKTOP_DOWNLOAD_URL` | web | 아니요 | — | 너무 오래된 앱에 보여 줄 다운로드 페이지. |
| `DESKTOP_EXTRA_AUTH_ORIGINS` | web | 아니요 | — | 외부 로그인 중 앱 메인 창이 열 수 있는 origin을 쉼표로 구분해 더해요. OIDC·GitHub origin은 자동으로 들어가요. |

## 실행과 한도

| 변수 | 서비스 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `WORKER_ID` | worker | 아니요 | 호스트 이름 + pid | 실행 기록에 남는 worker 이름. |
| `HEARTBEAT_INTERVAL_MS` | worker | 아니요 | `10000` | worker가 heartbeat를 남기는 간격(최소 1000). |
| `RUN_LEASE_MS` | worker | 아니요 | `30000` | worker의 heartbeat가 이만큼 없으면 실행을 회수해요. heartbeat의 두 배 이상. |
| `POLL_INTERVAL_MS` | worker | 아니요 | `1000` | 대기 중인 실행을 찾는 간격(최소 50). |
| `CANCEL_POLL_INTERVAL_MS` | worker | 아니요 | `1000` | 취소 요청을 확인하는 간격(최소 50). |
| `CLAIM_LOCK_TIMEOUT_MS` | worker | 아니요 | `3000` | 한 번 가져갈 때 큐 잠금을 기다리는 최대 시간(최소 100). |
| `MAINTENANCE_INTERVAL_MS` | worker | 아니요 | `600000` | 임시 파일·고아 파일·만료된 시험 실행을 정리하는 간격(최소 1000). |
| `WORKER_CONCURRENCY` | worker | 아니요 | `2` | worker 하나가 동시에 돌리는 실행 수. |
| `MAX_CONCURRENT_RUNS` | worker | 아니요 | `4` | 모든 worker를 합친 동시 실행 수. |
| `WORKSPACE_CONCURRENCY` | worker | 아니요 | `4` | 워크스페이스당 동시 실행 수. |
| `RUN_TIMEOUT_MS` | web, worker | 아니요 | `900000` | 실행이 이만큼 지나면 멈춰요(최소 1000). `web`은 데스크톱 앱으로 보내는 실행에 써요. |
| `RUN_RETRY_ATTEMPTS` | web, worker | 아니요 | `2` | 재시도를 허용한 시나리오의 전체 실행 시도 횟수(첫 시도 포함). `1`이면 재시도 없음. |
| `MIN_FREE_DISK_MB` | web, worker | 아니요 | `1024` | 남은 디스크가 이보다 적으면 worker는 새 실행을 받지 않고 web 서버는 새 실행을 거부해요(`503 storage_low`). |
| `SHUTDOWN_GRACE_MS` | worker | 아니요 | `30000` | 종료할 때 진행 중인 실행에 주는 시간. compose의 `stop_grace_period`(45초)보다 짧게 두세요. |
| `BLOCK_PRIVATE_NETWORKS` | worker | 아니요 | `false` | `true`면 시나리오가 사설·루프백·링크 로컬 주소에 접근하지 못해요. |
| `CHROMIUM_SANDBOX` | worker | 아니요 | `true` | Chromium 샌드박스. user namespace를 줄 수 없는 호스트에서만 끄세요. |
| `ATTACHMENT_MAX_MB` | web | 아니요 | `20` | 파일 업로드 스텝에 쓰는 파일 하나의 최대 크기. |
| `ATTACHMENT_WORKSPACE_MAX_MB` | web | 아니요 | `500` | 워크스페이스당 업로드 파일 합계. |
| `SSE_MAX_CONNECTIONS_PER_USER` | web | 아니요 | `8` | 사용자 한 명이 열어 둘 수 있는 실시간 진행 연결 수. |

## 내부용

런타임이나 빌드가 정해요. 직접 정하지 마세요.

| 변수 | 서비스 | 필수 | 기본값 | 설명 |
|---|---|---|---|---|
| `NEXT_RUNTIME` | web | — | — | Next.js가 정해요. |
| `NEXT_DIST_DIR` | web | — | `.next` | 빌드 출력 폴더, 시험에서 써요. |

## 파일 저장소

실행 파일은 로컬 볼륨(예시 compose 파일의 `run-files`)의 `STORAGE_DIR`에 저장돼요. S3 호환 저장소는 1.0에서 쓸 수 없어요.
