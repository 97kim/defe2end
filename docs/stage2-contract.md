# 단계 2 계약 — 기반(계정·권한·설정·시나리오)

> 2026-10-11. 단계 2 를 여러 사람이 나눠 만들 때 서로 맞춰야 하는 결정. 바꾸려면 이 문서부터 고친다.
> 상위 문서: [plan.md](plan.md) 4절(보안)·8절(단계 2). 화면은 `design/export/` 의 A′ Ink 시안을 따른다.

## 0. 완료 기준

자동 시험으로 보장한다(실제 Postgres 에 붙는 통합 시험).

- 다른 워크스페이스의 자원은 **모든 API** 에서 404 로 거부된다(존재 여부를 흘리지 않는다).
- 보기 전용(viewer)은 모든 쓰기 API 에서 403 으로 거부된다.
- 초대·재설정 링크는 만료·재사용·철회 시 거부된다. 재설정을 쓰면 그 사용자의 기존 세션이 모두 폐기된다.
- 비밀 변수 값은 저장 후 어떤 응답·내보내기에도 원문으로 나오지 않는다.

## 1. 인증 — Better Auth

- **Better Auth**(안정판)를 쓴다. 계획의 Auth.js 는 Next.js 용 v5 가 아직 베타라 바꿨다.
- 방식: 이메일·비밀번호, 범용 OIDC(generic OAuth 플러그인, discovery URL), GitHub. OIDC·GitHub 는 환경 변수로 켠다.
- **계정 자동 연결 끔.** 같은 이메일이라는 이유로 로컬 계정과 OIDC·GitHub 계정을 합치지 않는다. 외부 계정 식별은 `issuer + subject` 이고, Better Auth 에서는 `Account.providerId = "oidc-" + sha256(issuer) 앞 16자` + `accountId = sub` 로 저장한다. issuer 를 바꾸면 기존 계정과 이어지지 않는다(의도된 동작).
- OIDC 는 id token 을 discovery 의 JWKS·issuer 로 검증하고, id token 에 `email`(확인된 이메일)이 있어야 로그인된다. 운영 문서에 적는다.
- 외부 로그인으로 새 사용자가 생기는 것은 서버 훅에서만 허용한다: 이메일이 확인됐고, 그 이메일로 유효한 초대가 있거나 도메인이 `selfSignupDomains` 에 있을 때.
- 세션은 DB 세션 + HttpOnly·SameSite=Lax·Secure(HTTPS 일 때) 쿠키. 로그인 시도 횟수 제한을 켠다. 공개 POST API(`/api/invite`·`/api/reset`)도 IP별 분당 20회로 제한한다. IP 는 프록시 헤더로 판단하므로 **리버스 프록시 뒤에 두는 것을 전제**로 하고, 헤더가 없으면 제한이 걸리지 않는다는 점을 운영 문서에 적는다.
- 가입: 기본은 **초대로만**. 도메인 제한 자동 가입은 OIDC·GitHub(이메일 확인된 경우)에만, 기본 꺼짐.
- Better Auth 는 **인증만** 맡는다. 워크스페이스·역할·초대·재설정 링크는 우리 테이블과 우리 코드다(조직 플러그인 쓰지 않음).

## 2. 설치와 첫 관리자

- web 이 처음 뜰 때 관리자가 없으면 **설치 토큰**을 만들어 stdout 에 한 번 출력하고 해시만 저장한다.
- `/setup` 은 설치 토큰이 있어야 열린다. 첫 관리자(인스턴스 관리자) 계정과 첫 워크스페이스를 만들고, 토큰을 폐기한다.
- 관리자가 생긴 뒤 `/setup` 은 404.

## 3. 데이터 모델 (Prisma, `packages/db`)

Better Auth 테이블(`User`, `Session`, `Account`, `Verification`) + 아래. 모든 워크스페이스 자원은 `workspaceId` 를 직접 갖는다(조인 없이 권한 검사).

| 모델 | 핵심 필드 |
|---|---|
| `User` (추가 필드) | `isInstanceAdmin`, `disabledAt` |
| `InstanceSetting` (1행) | `installTokenHash`, `installTokenUsedAt`, `encryptionKeyCheck`, `selfSignupDomains`(기본 빈 값) |
| `Workspace` | `name`, `slug`(고유), `createdAt` |
| `Membership` | `userId`, `workspaceId`, `role`(`ADMIN`·`EDITOR`·`VIEWER`), 고유(userId, workspaceId) |
| `Invite` | `workspaceId`, `email`, `role`, `tokenHash`, `expiresAt`, `usedAt`, `revokedAt`, `createdById` |
| `ResetLink` | `userId`, `tokenHash`, `expiresAt`, `usedAt`, `createdById` |
| `AuditLog` | `workspaceId?`, `actorId?`, `action`, `targetType`, `targetId`, `meta`(JSON, 비밀 값 금지), `createdAt` |
| `Site` | `workspaceId`, `name` |
| `Environment` | `workspaceId`, `siteId`, `name`, `baseUrl` |
| `Variable` | `workspaceId`, `environmentId`, `key`, `isSecret`, `value`(비밀 아님일 때), `valueEncrypted`(비밀일 때), 고유(environmentId, key) |
| `Scenario` | `workspaceId`, `siteId`, `name`, `description`, `steps`(JSON), `stepFormatVersion`, `createdById`, `updatedById`, `archivedAt` |
| `Tag`, `ScenarioTag` | `workspaceId`, `name` 고유(workspaceId, name) |

## 4. 권한 — `can(actor, action, resource)` (`packages/shared`)

- 순수 함수. 모든 진입점(API·페이지 데이터·파일·나중의 MCP·봇 토큰)이 이것 하나만 거친다. 라우트마다 따로 조건을 쓰지 않는다.
- `actor`: `{ userId, isInstanceAdmin, roles: Record<workspaceId, Role> }`. `resource`: `{ type, workspaceId }`(인스턴스 자원은 `workspaceId` 없음).
- 멤버가 아닌 워크스페이스 자원 → 판정 `not_found`(HTTP 404). 멤버지만 권한 부족 → `forbidden`(403).

| 동작 | VIEWER | EDITOR | ADMIN | 인스턴스 관리자 |
|---|---|---|---|---|
| 워크스페이스·사이트·환경·변수·시나리오 읽기 (비밀 값은 가림) | ✓ | ✓ | ✓ | 멤버일 때만 |
| 시나리오 생성·수정·복제·보관·태그·가져오기·내보내기 | | ✓ | ✓ | 멤버일 때만 |
| 사이트·환경·변수 쓰기 | | ✓ | ✓ | 멤버일 때만 |
| 멤버·역할 변경, 초대 발급·철회, 워크스페이스 이름 변경·삭제 | | | ✓ | 멤버일 때만 |
| 워크스페이스 생성(`POST /api/workspaces`), 재설정 링크 발급, 사용자 목록·비활성화 | | | | ✓ |

- 인스턴스 관리자도 워크스페이스 안의 일은 **멤버십 역할**로 판단한다(조용한 우회 없음).
- 마지막 **활성** ADMIN 을 내리거나 내보내거나 비활성화하는 요청은 거부(비활성 사용자는 세지 않는다).
- 멤버십이나 사용자 비활성 여부를 바꾸는 모든 작업(역할 변경·내보내기·비활성화·활성화·초대 생성·수락·워크스페이스 생성·삭제·설치·CLI create-admin)은 **하나의 전역 advisory lock**(`lib/accounts/admin-lock.ts`)을 트랜잭션 맨 앞에서 잡고, 잠금 뒤 상태와 **요청한 사람의 권한을 다시 읽어** 검증한다. 시험이 이 규칙을 빠뜨린 파일을 잡는다.
- 설치는 관리자·첫 워크스페이스·멤버십·설치 토큰 사용을 한 트랜잭션으로 처리한다.

## 5. 링크 토큰 (초대·재설정·설치)

- 32바이트 난수 base64url. DB 에는 SHA-256 해시만. 비교는 상수 시간.
- 만료: 초대 72시간, 재설정 1시간. **한 번만 사용**: `usedAt IS NULL AND expiresAt > now AND revokedAt IS NULL` 조건부 갱신이 1행일 때만 성공.
- **토큰은 URL 조각(`#token=…`)에 둔다.** 서버 로그·Referer 로 가지 않는다. 페이지가 읽어 POST 로 보낸다. 해당 페이지는 `Referrer-Policy: no-referrer`.
- 초대 수락: 로그인한 사용자의 이메일이 초대 이메일과 같아야 한다(대소문자 무시). 새 사용자면 수락 화면에서 계정을 만든다.
- 재설정 사용 시 그 사용자의 세션 전부 삭제 + 감사 기록.
- 긴급 복구: `defe2end admin reset-link --email <addr>`(web 컨테이너 안에서 실행) 가 재설정 링크를 stdout 에 출력. `defe2end admin create-admin` 은 관리자가 하나도 없을 때만.

## 6. 비밀 값 암호화·마스킹

- AES-256-GCM. 키는 `DEFE2END_ENCRYPTION_KEY`(base64 32바이트, `openssl rand -base64 32`). 암호문 형식 `v1:<iv>:<tag>:<data>`(키 교체 대비 버전).
- 시작할 때 `InstanceSetting.encryptionKeyCheck` 로 키가 맞는지 확인하고, 다르면 web 이 뜨지 않는다(잘못된 키로 덮어쓰기 방지).
- 비밀 변수는 **쓰기 전용**: 저장 후 API 는 `{ isSecret: true, value: null, hasValue: true }` 만 준다. 바꾸려면 새 값을 쓴다.
- `maskSecrets(text, secrets)`(`packages/shared`)를 로그·오류 메시지에 쓴다. 단계 3 runner 가 같은 함수를 쓴다.
- 내보내기는 비밀 값을 빼고, 가져올 때 비밀 변수는 "값 필요" 상태로 만든다.

## 7. 시나리오 스텝 형식 (`packages/shared`)

- `stepFormatVersion: 1`. 스텝: `{ id, action, target?, value?, options?: { timeoutMs?, retries?, onFailure?: "stop" | "continue" } }`.
- 단계 2 액션: `navigate`, `click`, `fill`, `select`, `wait`, `assertText`, `screenshot`. 최종 목록·판정 의미는 단계 3 에서 확정하고, 모르는 액션은 저장 단계에서 거부한다.
- 검증은 zod 스키마 하나를 서버·화면이 같이 쓴다.
- 내보내기 JSON: `{ format: "defe2end.scenario", formatVersion: 1, stepFormatVersion: 1, scenarios: [...] }`. 사이트·환경은 이름으로 참조, ID·비밀 값 없음.

## 8. API 와 화면 (`apps/web`)

- API 는 Next.js route handler `/api/w/[slug]/…` (JSON). 공통 래퍼가 세션 → actor → `can()` → 핸들러 순서로 돈다. 오류 형식 `{ error: { code, message } }`.
- 화면은 서버 컴포넌트 + 같은 API 로 쓰기. 스타일은 **Tailwind CSS v4** + 디자인 토큰을 CSS 변수로(`design/export/ds-1-foundations.png` 값). 글꼴 Geist·Geist Mono(next/font), 한국어 IBM Plex Sans KR.
- 다국어: **next-intl**, 문구는 `packages/i18n`(영어 기본, 한국어). 한국어 문구는 해요체, 조사는 붙여 쓴다.
- 단계 0 의 `/api/health` 는 **읽기 전용**으로 바꾼다(설치 시각은 첫 관리자 생성 때 기록).

## 9. 시험

- `can()` 은 동작 × 역할 × 멤버 여부 전부를 표로 시험한다.
- 통합 시험은 일회용 Postgres(로컬 compose 의 별도 DB 또는 testcontainers)에 붙어 0절 기준을 라우트 목록 전체에 대해 돈다. 라우트를 추가하면 시험 목록에도 들어가게(라우트 목록에서 자동 수집).
- CI 의 `check` 작업에 Postgres 서비스를 붙여 통합 시험까지 돈다.
