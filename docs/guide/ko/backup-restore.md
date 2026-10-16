# 백업과 복원

백업은 폴더 하나이고, 다음이 들어 있어요.

- DB 덤프
- `STORAGE_DIR`의 실행 파일들
- `manifest.json`: 서버 버전, 마이그레이션 이름과 체크섬, 만든 시각, 설치에 필요한 환경 변수 이름 목록(값은 없음), 덤프와 파일마다의 SHA-256, 키 확인 값(암호화 키로 만든 HMAC이고 키 자체는 아니에요)

**암호화 키는 백업에 들어가지 않아요.** `DEFE2END_ENCRYPTION_KEY`는 비밀번호 관리자 같은 곳에 따로 보관하세요. 복원할 때 키 확인 값으로 맞는 키인지 검사해요.

백업을 만들고 보관하고 시험하는 것은 운영하는 분의 몫이에요.

## 백업

`web`과 `worker`를 멈춘 상태에서만 백업해요. 돌고 있으면 정리 작업이나 삭제가 덤프가 가리키는 파일을 지울 수 있어서, 둘이 DB에 연결되어 있으면 `backup`이 거부해요. `deploy/` 폴더에서 실행하세요.

```sh
docker compose stop web worker
mkdir -p backups
docker compose run --rm -v "$PWD/backups:/backup" migrate backup /backup/$(date +%Y%m%d-%H%M%S)
docker compose start web worker
```

만들어진 폴더는 서버 밖으로 복사해 두세요.

## 빈 설치에 복원

`restore`는 아무것도 바꾸기 전에 다음을 모두 검사해요.

- DB와 파일 저장소가 비어 있는지(강제 옵션은 없어요)
- 백업의 버전·마이그레이션 체크섬이 지금 쓰는 `migrate` 이미지와 같은지
- 덤프와 파일 해시가 `manifest.json`과 맞는지
- 키 확인 값이 `DEFE2END_ENCRYPTION_KEY`와 맞는지

순서는 다음과 같아요.

1. 새 호스트에서 [install.md](install.md) 1~2단계를 따라 하세요. `DEFE2END_VERSION`은 백업의 `manifest.json`에 적힌 버전으로, `DEFE2END_ENCRYPTION_KEY`는 **원래** 키로 정하세요.
2. DB만 띄우세요.
   ```sh
   docker compose up -d postgres
   ```
3. 복원하세요.
   ```sh
   docker compose run --rm -v "/path/to/backups:/backup" migrate restore /backup/20261016-120000
   ```
4. 전체를 띄우세요: `docker compose up -d`.
5. 로그인해서 시나리오·실행·스크린샷을 확인하세요.
6. 자동화를 다시 켜세요(아래 참고).

복원하는 동안 DB에 "복원 중" 표시가 남아요. 복원이 중간에 멈추면 `web`과 `worker`가 시작하지 않아요. DB와 저장소를 비우고 다시 복원하세요.

### 복원 뒤에는 자동화가 멈춰 있어요

원본이 이미 한 일을 되풀이하지 않도록, 복원한 설치는 자동화가 멈춘 상태로 시작해요. 스케줄이 돌지 않고, Slack 메시지를 보내지 않고, 대기 중인 실행도 시작하지 않아요. 백업 당시 진행 중이던 실행은 오류(복원으로 중단)로, 보내지 못한 알림은 취소로 정리돼요.

복원한 설치를 확인했고 원본이 더 이상 같은 스케줄을 돌리지 않으면 다시 켜세요.

```sh
docker compose run --rm migrate resume-automation
```

### 키를 잃었을 때

원래 키를 정말 잃었을 때만 새 키와 `--without-key`로 복원하세요.

```sh
docker compose run --rm -v "/path/to/backups:/backup" migrate restore --without-key /backup/20261016-120000
```

이때 비밀 변수, Slack 웹훅, 저장한 로그인 세션은 읽을 수 없는 상태로 표시돼요. 다시 입력하세요.

### 새 버전으로 옮길 때

먼저 백업과 같은 버전으로 복원한 뒤 [업그레이드](upgrade.md)하세요.

> 쓰는 버전의 정확한 옵션은 `docker compose run --rm migrate --help`로 확인하세요.
