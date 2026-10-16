# 백업과 복원

백업은 폴더 하나이고, 다음이 들어 있어요.

- 일관된 DB 덤프. `web`과 `worker`가 돌고 있어도 한 시점의 스냅샷으로 떠요.
- 덤프가 가리키는 `STORAGE_DIR`의 실행 파일들.
- `manifest.json`: 서버 버전, 마이그레이션 상태, 설치에 필요한 환경 변수 이름 목록(값은 없음).

**암호화 키는 백업에 들어가지 않아요.** `DEFE2END_ENCRYPTION_KEY`는 비밀번호 관리자 같은 곳에 따로 보관하세요. 같은 키가 없으면 복원한 설치에서 비밀 변수를 읽을 수 없어 다시 입력해야 해요.

백업을 만들고 보관하고 시험하는 것은 운영하는 분의 몫이에요.

## 백업

`migrate` 이미지의 `backup` 명령을 써요. `deploy/` 폴더에서 실행하세요.

```sh
mkdir -p backups
docker compose run --rm -v "$PWD/backups:/backup" migrate backup /backup/$(date +%Y%m%d-%H%M%S)
```

만들어진 폴더는 서버 밖으로 복사해 두세요. 덤프 뒤에 생긴 파일은 빠질 수 있지만, 덤프한 데이터가 가리키지 않는 파일이라 괜찮아요.

## 빈 설치에 복원

`restore`는 빈 DB와 빈 파일 저장소에만, 백업을 만든 것과 같은 버전으로만 동작해요. 조건이 맞지 않으면 거부하고, 강제 옵션은 없어요.

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
5. 로그인해서 시나리오·실행·스크린샷 몇 개를 확인하세요.

새 버전으로 옮기려면 먼저 이전 버전으로 복원한 뒤 [업그레이드](upgrade.md)하세요.

> 정확한 명령 형식은 1.0 전에 바뀔 수 있어요. 쓰는 버전에서 `docker compose run --rm migrate --help`로 확인하세요.
