# 계정 복구 — 관리자 CLI

> defE2End 는 메일을 보내지 않아요. 비밀번호를 잊으면 인스턴스 관리자가 **사용자** 화면(`/admin/users`)에서 재설정 링크를 만들어 직접 전해요. 관리자 계정까지 잃었을 때는 서버 운영자가 아래 CLI 를 써요. 근거는 [stage2-contract.md](stage2-contract.md) 5절이에요.

## 명령

web 컨테이너 안에서 실행해요. `deploy/` 디렉터리에서:

```sh
# 기존 사용자의 비밀번호 재설정 링크(1시간, 한 번만)
docker compose exec web defe2end admin reset-link --email admin@example.com

# 인스턴스 관리자가 한 명도 없을 때만: 관리자를 만들고 비밀번호를 정할 링크를 출력
docker compose exec web defe2end admin create-admin --email admin@example.com
```

`defe2end` 는 이미지에 들어 있는 `node /app/apps/web/cli/defe2end.mjs` 의 바로가기예요. 같은 명령을 `docker compose exec web node apps/web/cli/defe2end.mjs admin reset-link --email …` 로 실행해도 돼요.

- 링크는 **stdout 에 한 줄**로만 나와요(`https://<BETTER_AUTH_URL>/reset#token=…`). 안내 문구와 오류는 stderr 로 나가요. 성공하면 종료 코드 0, 실패하면 1 이에요.
- 링크 주소의 앞부분은 `BETTER_AUTH_URL` 이에요. 바깥에서 접속하는 주소와 다르면 `.env` 의 값을 먼저 고쳐 주세요.
- 토큰은 URL 조각(`#token=`)에 있어서 서버 로그·Referer 로 가지 않아요. 터미널 기록·채팅에 붙여 넣은 링크는 쓰고 나면 지워 주세요.

## 동작

| | `reset-link` | `create-admin` |
|---|---|---|
| 조건 | 해당 이메일의 사용자가 있어야 해요(대소문자 무시) | 인스턴스 관리자가 0명일 때만. 있으면 거부하고 `reset-link` 를 안내해요 |
| 하는 일 | 그 사용자의 쓰지 않은 이전 재설정 링크를 모두 철회하고 새 링크를 만들어요 | 이메일로 관리자 계정을 만들어요(같은 이메일 사용자가 있으면 관리자로 올리고 비활성을 풀어요). 비밀번호는 없고, 출력된 링크로 정해요 |
| 감사 기록 | `user.reset_link.issue`(`actorId` 없음, `meta.via: "cli"`) | `user.create_admin` + `user.reset_link.issue` |

링크를 쓰면(웹·CLI 공통):

- 비밀번호가 바뀌고, 그 사용자의 **모든 세션이 삭제**돼요(다른 기기 포함).
- 링크는 한 번만 쓸 수 있어요. 만료(1시간)·사용·철회된 링크는 각각의 이유를 화면에 보여 주고 거부해요.
- 감사 기록 `user.password_reset` 이 남아요(폐기한 세션 수 포함, 비밀 값 없음).

비활성화된 사용자는 비밀번호를 바꿔도 로그인할 수 없어요. 관리자가 **사용자** 화면에서 다시 활성화해야 해요.
