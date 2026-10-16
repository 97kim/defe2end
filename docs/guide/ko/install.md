# 설치

defE2End는 Postgres 옆에 컨테이너 세 개로 돌아요. `web`(화면·API), `worker`(Chromium으로 시나리오 실행), `migrate`(한 번 돌고 끝나는 스키마 갱신)예요. 내 서버에서 Docker Compose로 띄워요.

## 필요한 것

- Docker Engine과 Docker Compose v2.3 이상이 있는 Linux 호스트(amd64·arm64). CPU·메모리·디스크는 [requirements.md](requirements.md)를 보세요.
- 비밀 값을 만들 `openssl`(32바이트 난수를 base64로 출력하는 도구면 돼요).
- 사용자가 접속할 수 있는 주소. 잠깐 써 보는 게 아니라면 앞에 HTTPS를 두세요(아래 참고).

## 1. compose 파일 받기

GitHub Releases에서 버전(`X.Y.Z`)을 고르세요. 이미지는 정확한 버전 태그(`X.Y.Z`, 시험 릴리스는 `X.Y.Z-rc.N`)로만 올라가고 `X.Y`나 `latest` 태그는 없어요. `DEFE2END_VERSION` 하나로 세 이미지를 같은 버전에 고정해요.

```sh
git clone --depth 1 --branch v1.0.0 https://github.com/97kim/defe2end.git
cd defe2end/deploy
```

`deploy/`의 `docker-compose.yml`, `chromium-seccomp.json`, `.env.example` 세 파일만 있으면 돼요. 이 파일만 다른 폴더로 옮겨 써도 괜찮아요.

## 2. `.env` 만들기

```sh
cp .env.example .env
openssl rand -base64 32   # BETTER_AUTH_SECRET에 넣기
openssl rand -base64 32   # DEFE2END_ENCRYPTION_KEY에 넣기
```

`.env`에서 다음을 고치세요.

- `DEFE2END_VERSION`: 고른 버전(예: `1.0.0`).
- `BETTER_AUTH_SECRET`, `DEFE2END_ENCRYPTION_KEY`: 방금 만든 두 값. 서로 다른 값을 쓰세요.
- `POSTGRES_PASSWORD`: 길고 무작위인 비밀번호.
- `BETTER_AUTH_URL`: 사용자가 여는 주소(예: `https://e2e.example.com`).

**`DEFE2END_ENCRYPTION_KEY`는 백업과 떨어진 안전한 곳에 보관하세요.** 이 키가 없으면 비밀 변수를 읽을 수 없고, DB를 처음 만들 때와 다른 키로는 web 서버가 시작하지 않아요. 모든 설정은 [configuration.md](configuration.md)에 있어요.

## 3. 시작

```sh
docker compose up -d
docker compose ps
```

`migrate`가 한 번 돌고 끝나면 `web`과 `worker`가 시작돼요.

## 4. 첫 관리자 만들기

관리자가 없으면 web 서버가 시작할 때마다 일회용 설정 링크를 출력해요.

```sh
docker compose logs web | grep setup
```

`<BETTER_AUTH_URL>/setup#token=…`을 열어 관리자 계정을 만드세요. 설정을 마칠 때까지 다시 시작할 때마다 새 토큰이 나와요.

나중에 관리자 계정을 잃으면 [계정 복구](../../admin-recovery.md)를 보세요.

## 5. HTTPS

defE2End는 TLS를 직접 처리하지 않아요. `web`(포트 `WEB_PORT`, 기본 3000) 앞에 리버스 프록시를 두고 `BETTER_AUTH_URL`(과 `PUBLIC_URL`)을 `https://` 주소로 바꾸세요. 주소가 https면 세션 쿠키에 `Secure`가 붙어요.

같은 호스트에서 Caddy를 쓰는 예시예요.

```
e2e.example.com {
    reverse_proxy localhost:3000
}
```

실행 진행 상황은 server-sent events로 오니까 프록시가 응답을 버퍼링하지 않게 해 주세요.

## 다음

- [데스크톱 앱](desktop-app.md): 내 PC에서 실행·녹화·AI 채팅
- [백업과 복원](backup-restore.md), [업그레이드](upgrade.md)
