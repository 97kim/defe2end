# 단계 2 기반 — 기능 팀 안내

> 2026-10-11. [stage2-contract.md](stage2-contract.md) 위에서 계정·설정·시나리오 팀이 나눠 작업할 때 쓰는 확장 지점. 결정 자체는 계약 문서가 기준이다.

## 1. API 라우트 추가

`apps/web/app/api/w/[slug]/<자원>/…/route.ts` 에 `route()` 로만 만든다. 세션 → actor → 워크스페이스(slug) → `can()` 은 래퍼가 하고, 핸들러는 권한이 확인된 `workspace` 를 받는다.

```ts
import { ApiError, readJson, route } from "../../../../../lib/api";
import { getDb } from "../../../../../lib/db";

export const dynamic = "force-dynamic";

export const PATCH = route<{ slug: string; id: string }>(
  { action: "config.write", resource: "site" },
  async ({ request, params, workspace, actor }) => {
    const body = await readJson(request, siteInputSchema); // zod 실패 → 400 invalid_request
    // URL·본문의 ID 는 반드시 workspaceId 로 함께 찾는다. 다른 워크스페이스 것이면 404.
    const site = await getDb().site.findFirst({ where: { id: params.id, workspaceId: workspace.id } });
    if (!site) throw ApiError.notFound();
    …
  },
);
```

- 동작(`Action`)은 `packages/shared/src/permissions.ts` 의 것만 쓴다: 읽기 `workspace.read`, 시나리오 쓰기 `scenario.write`, 사이트·환경·변수 쓰기 `config.write`, 멤버·초대·이름 변경·삭제 `workspace.admin`. 인스턴스 동작(`workspace.create`, `user.list`, `user.resetLink`, `user.disable`)은 `resource: "instance"` 로, `/api/w` 밖(예: `/api/admin/…`)에 둔다.
- GET 이 아닌 메서드에 `workspace.read` 를 쓰면 시험이 실패한다(보기 전용은 모든 쓰기에서 403).
- 오류는 `throw new ApiError(code, message)` → `{ error: { code, message } }`. 코드: `unauthenticated` 401, `forbidden` 403, `not_found` 404, `invalid_request` 400, `conflict` 409.
- 감사 기록은 `lib/audit.ts` 의 `audit()`(트랜잭션 클라이언트도 받음). `meta` 에 비밀 값 금지.
- 비밀 변수: 저장은 `lib/encryption.ts` 의 `encrypt()`, 로그·오류는 `maskSecrets()`(`@defe2end/shared`). 링크 토큰은 `generateLinkToken`·`hashLinkToken`·`verifyLinkToken`, 수명은 `LINK_TOKEN_TTL_MS`(`@defe2end/shared/server`).
- 세션 없이 열리는 라우트(초대 수락·재설정처럼 링크 토큰으로 지키는 것)는 `apps/web/test/access.int.test.ts` 의 `PUBLIC_ROUTES` 에 넣어야 시험이 통과한다. **보안 결정이므로 리드에게 알린다.**
- 토큰을 URL 조각으로 받는 페이지는 `/invite`·`/reset` 경로를 쓴다(`next.config.ts` 에 `Referrer-Policy: no-referrer` 가 이미 걸려 있다).
- 화면(서버 컴포넌트)은 `lib/page.ts` 의 `requireWorkspace(slug)`(멤버 아니면 404 페이지)와 `canInWorkspace(slug, action)`(거짓이면 `<AccessDenied kind="forbidden" />`)을 쓴다. 쓰기는 같은 API 를 부른다.
- 계정 생성은 `lib/users.ts` 의 `createPasswordUser()`(공개 가입은 꺼져 있다).

## 2. 문구(i18n)

`packages/i18n/src/messages/{en,ko}/<namespace>.json` 에서 **자기 팀 파일만** 고친다: 계정 `accounts`, 설정 `settings`, 시나리오 `scenarios`. 사용은 `useTranslations("scenarios")` / `getTranslations("scenarios")`. 영어가 기준이고 한국어는 같은 키를 가져야 한다(`messages.test.ts`). 한국어는 해요체, 조사는 붙여 쓴다. 공통 문구(`common`)가 더 필요하면 리드에게 요청한다.

## 3. 통합 시험

일회용 Postgres(tmpfs, `down` 하면 사라짐)에 붙는다.

```sh
docker compose -f deploy/docker-compose.test.yml up -d --wait
export TEST_DATABASE_URL=postgresql://defe2end:test@localhost:54329/defe2end_test
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 ./scripts/pnpm-locked.sh turbo run test   # 또는 apps/web 에서 npx vitest run
docker compose -f deploy/docker-compose.test.yml down -v                     # 다 쓰면
```

- 시험 시작 때 `prisma migrate deploy` 가 한 번 돈다. `TEST_DATABASE_URL` 이 없으면 로컬에서는 통합 시험을 건너뛰고, CI 에서는 실패한다.
- 파일 이름은 `*.int.test.ts`, `describe` 대신 `describeDb`, `beforeAll`/`beforeEach` 에서 `resetDatabase()`. 파일은 하나씩 순서대로 돈다.
- 도우미(`apps/web/test/helpers.ts`): `createUser`, `createWorkspace`, `addMember`, `workspaceWithRoles()`(ADMIN·EDITOR·VIEWER·다른 워크스페이스의 OUTSIDER), `sessionHeaders(userId)`(실제 서명된 세션 쿠키), `callRoute(handler, { method, params, body, headers })`.
- **라우트 목록 등록은 따로 하지 않는다.** `test/route-inventory.ts` 가 `app/api` 아래 모든 `route.ts` 를 디스크에서 모아, `access.int.test.ts` 가 모든 `/api/w/**` 라우트에 대해 로그아웃 401, 다른 워크스페이스 멤버·없는 slug 404, 권한 부족 역할(GET 아닌 메서드의 VIEWER 포함) 403 을 자동으로 확인한다. 기능 시험에는 정상 동작과 **다른 워크스페이스 자원 ID → 404** 를 직접 쓴다(예: `lib/api.int.test.ts`).

## 4. 리드에게 알리고 고칠 파일

공유 기반이라 세 팀이 동시에 기대고 있다. 바꿔야 하면 먼저 알린다.

- `docs/stage2-contract.md`
- `packages/db/prisma/schema.prisma` 와 마이그레이션 — 모델·필드 추가가 필요하면 리드가 모아서 한 마이그레이션으로 만든다
- `packages/shared/src/permissions.ts`(+ 표 시험), `steps.ts`, `mask.ts`, `src/server/*`
- `apps/web/lib/api.ts`, `actor.ts`, `auth.ts`, `startup.ts`, `page.ts`, `setup.ts`, `users.ts`
- `apps/web/test/access.int.test.ts`(`PUBLIC_ROUTES`), `route-inventory.ts`, `helpers.ts`, `db.ts`
- `apps/web/components/ui.tsx`·`sidebar.tsx`, `app/globals.css`(토큰), `app/layout.tsx`, `next.config.ts`
- `packages/i18n/src/index.ts`, `messages/*/common.json`
- `deploy/*`, `.github/workflows/ci.yml`
