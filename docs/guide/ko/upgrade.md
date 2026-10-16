# 업그레이드

업그레이드는 `DEFE2END_VERSION`을 바꾸고 다시 띄우는 일이에요. `web`과 `worker`가 시작하기 전에 `migrate` 컨테이너가 DB 스키마를 갱신해요.

**`web`, `worker`, `migrate`는 같은 버전으로 돌리세요.** `web`과 `worker`는 시작할 때 DB의 마이그레이션 목록을 자기 이미지가 아는 목록과 비교하고, 다르면 시작하지 않아요. 예시 compose 파일은 `DEFE2END_VERSION` 하나로 셋을 고정해요. 다른 방법으로 이미지를 돌린다면 셋을 함께 바꾸세요.

1. 지금 버전과 목표 버전 사이 모든 버전의 릴리스 노트를 읽으세요. 건너뛸 수 없는 버전이나 따로 할 일이 있으면 거기에 적혀 있어요.
2. [백업](backup-restore.md)하고 `DEFE2END_ENCRYPTION_KEY`가 아직 있는지 확인하세요.
3. 새 compose 파일(새 릴리스 태그의 `deploy/` 폴더)을 받아 지금 파일과 비교하세요. 직접 고친 부분은 옮겨 주세요.
4. `.env`에 새 버전을 적으세요.
   ```sh
   DEFE2END_VERSION=1.0.1   # 정확한 버전만, X.Y나 latest는 없어요
   ```
5. 이미지를 받고 다시 띄우세요.
   ```sh
   docker compose pull
   docker compose up -d
   docker compose logs migrate
   ```
6. `migrate`가 종료 코드 0으로 끝났는지, 웹 화면이 동작하는지 확인하세요.

worker가 멈출 때 진행 중이던 실행은 `error`(`worker_shutdown`)로 끝나요. 업그레이드 뒤 다시 실행하세요.

## 되돌리기

스키마 마이그레이션은 앞으로만 가요. 이전 버전으로 돌아가려면 2단계에서 만든 백업을 이전 버전으로 띄운 빈 설치에 복원하세요.

## 데스크톱 앱

데스크톱 앱도 업데이트하세요([desktop-app.md](desktop-app.md#업데이트)). 앱은 주 버전이 같고, 앱의 부 버전이 서버의 부 버전보다 최대 하나 낮은 서버에서 동작해요(서버 1.4는 앱 1.3 이상의 1.x를 받아요). 더 오래된 앱에는 업데이트를 안내해요.
