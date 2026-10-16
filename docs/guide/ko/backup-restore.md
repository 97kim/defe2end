# 백업과 복원

`migrate` 이미지에는 `backup`, `restore [--without-key]`, `resume-automation` 세 명령이 있어요. `docker-compose.yml`이 있는 `deploy/` 폴더에서 실행하세요. 백업을 만들고 보관하고 시험하는 것은 운영하는 분의 몫이에요.

`--no-deps`는 꼭 붙이세요. 없으면 Compose가 `migrate`가 기대는 서비스를 띄우면서 멈춰 둔 `web`이나 `worker`가 다시 켜져요.

## 백업에 들어가는 것

백업은 폴더 하나이고, 다음이 들어 있어요.

- `db.dump`: DB
- `files/`: `STORAGE_DIR`의 실행 파일들
- `manifest.json`: 서버 버전, 마이그레이션과 체크섬, 만든 시각, 덤프와 파일마다의 SHA-256, 설치에 필요한 환경 변수 이름 목록(값은 없음), 키 확인 값(암호화 키로 만든 HMAC이고 키 자체는 아니에요)

**암호화 키는 백업에 들어가지 않아요.** `DEFE2END_ENCRYPTION_KEY`는 비밀번호 관리자 같은 곳에 따로 보관하세요. 원래 키가 없으면 복원한 서버가 시작하지 않고 저장한 비밀 값도 읽을 수 없어요.

## 백업

`web`과 `worker`를 멈춘 상태에서만 백업해요. 돌고 있으면 정리 작업이나 삭제가 덤프가 가리키는 파일을 지울 수 있어서, 둘이 DB에 연결되어 있으면 `backup`이 거부해요.

```sh
docker compose stop web worker
mkdir -p backups/2026-10-16 && chmod 777 backups/2026-10-16   # 이미지는 uid 1000으로 돌아요
docker compose run --rm --no-deps -T -v "$PWD/backups/2026-10-16:/backup" migrate backup /backup
docker compose start web worker
```

대상 폴더는 비어 있어야 해요. 다 만든 폴더는 서버 밖으로 복사해 두세요.

## 빈 설치에 복원

`restore`는 아무것도 바꾸기 전에 모두 검사하고, 다음 경우에는 거부해요.

- DB나 파일 저장소가 비어 있지 않을 때(강제 옵션은 없어요)
- 백업을 다른 버전으로 만들었을 때(그 버전으로 복원한 뒤 [업그레이드](upgrade.md)하세요)
- 덤프나 파일이 체크섬과 맞지 않을 때
- 키 확인 값이 `DEFE2END_ENCRYPTION_KEY`와 맞지 않을 때

순서는 다음과 같아요.

1. 새 호스트에서 [install.md](install.md) 1~2단계를 따라 하세요. `DEFE2END_VERSION`은 백업 `manifest.json`의 `version`으로, `DEFE2END_ENCRYPTION_KEY`는 **원래** 키로 정하세요.
2. 새 볼륨에서 DB만 띄우세요. `migrate`나 `web`을 먼저 띄우지 마세요.
   ```sh
   docker compose up -d postgres
   ```
3. 복원하세요(폴더는 읽기 전용이어도 돼요).
   ```sh
   docker compose run --rm --no-deps -T -v "$PWD/backups/2026-10-16:/backup:ro" migrate restore /backup
   ```
4. 전체를 띄우세요.
   ```sh
   docker compose up -d
   ```
5. 로그인해서 시나리오·실행·스크린샷을 확인하세요.
6. 자동화를 다시 켜세요(아래 참고).

복원이 중간에 멈추면 반쯤 복원된 상태로 돌지 않도록 `web`과 `worker`가 시작하지 않아요. 볼륨을 지우고 2단계부터 다시 하세요.

### 복원 뒤에는 자동화가 멈춰 있어요

원본이 이미 한 일을 되풀이하지 않도록, 복원한 설치는 자동화가 멈춘 상태로 시작해요. 스케줄, Slack 알림, 대기 중인 실행이 기다려요. 백업 당시 진행 중이던 실행은 `error`(`restore_interrupted`)로 끝나요.

복원한 설치를 확인했고 원본이 더 이상 같은 스케줄을 돌리지 않으면 다시 켜세요.

```sh
docker compose run --rm --no-deps -T migrate resume-automation
```

### 키를 잃었을 때

원래 키를 정말 잃었을 때만, 새 `DEFE2END_ENCRYPTION_KEY`를 정하고 `--without-key`로 복원하세요.

```sh
docker compose run --rm --no-deps -T -v "$PWD/backups/2026-10-16:/backup:ro" migrate restore --without-key /backup
```

비밀 값과 저장한 로그인 세션은 지워져요. 비밀 값을 다시 입력하세요.

사용법은 `docker compose run --rm --no-deps migrate --help`로 볼 수 있어요.
