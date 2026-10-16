# 데스크톱 앱

데스크톱 앱은 내 PC에서 시나리오를 실행하고, 녹화·페이지 확인용 사이드 브라우저를 열고, AI 채팅과 로컬 MCP 서버를 담고 있어요. defE2End 서버에 연결해 써요.

지원: macOS(Apple Silicon·Intel), Windows x64.

## 다운로드

서버와 같은 버전의 GitHub Releases 페이지에서 설치 파일을 받으세요.

- macOS Apple Silicon: `defE2End-1.0.0-arm64.dmg`
- macOS Intel: `defE2End-1.0.0-x64.dmg`
- Windows x64: `defE2End-1.0.0-setup.exe`

릴리스마다 `SHA256SUMS`(모든 릴리스 파일의 체크섬), `IMAGE_DIGESTS.txt`(서버 이미지 세 개의 digest), 설치 파일과 이미지의 GitHub 출처 증명도 있어요.

## 파일 검증

설치 파일은 열기 전에 꼭 검증하세요. 체크섬을 확인하고, GitHub CLI(`gh`)가 있으면 출처 증명도 확인하세요.

### 체크섬

받은 파일의 해시를 `SHA256SUMS`의 해당 줄과 비교하세요. 정확히 같아야 해요.

macOS(터미널):

```sh
cd ~/Downloads
shasum -a 256 defE2End-1.0.0-arm64.dmg
grep defE2End-1.0.0-arm64.dmg SHA256SUMS
```

Windows(PowerShell):

```powershell
Get-FileHash "$env:USERPROFILE\Downloads\defE2End-1.0.0-setup.exe" -Algorithm SHA256
```

해시가 다르면 파일을 지우고 다시 받으세요. 해시가 맞지 않는 파일은 설치하지 마세요.

### 출처 증명

이 저장소의 릴리스 작업이 만든 파일인지 확인해요.

```sh
gh attestation verify defE2End-1.0.0-arm64.dmg --repo 97kim/defe2end
```

성공 메시지로 끝나야 해요. 서버 이미지도 `IMAGE_DIGESTS.txt`에 적힌 digest로 같은 방법으로 확인할 수 있어요.

```sh
gh attestation verify oci://ghcr.io/97kim/defe2end-web@sha256:… --repo 97kim/defe2end
```

버전 태그가 가리키는 digest는 `docker buildx imagetools inspect ghcr.io/97kim/defe2end-web:1.0.0`으로 볼 수 있고, 파일의 값과 같아야 해요.

## 설치와 처음 실행

앱은 **코드 서명이 되어 있지 않아요.** 처음 열 때 OS가 막을 수 있어요.

**아래 방법은 공식 GitHub Releases에서 받았고 위 검증이 성공한 파일에만 쓰세요.** 다른 곳에서 받았거나 검증에 실패한 파일에는 절대 쓰지 마세요. 이 방법은 이 앱 하나만 허용해요. OS 보안 기능을 끄지는 마세요.

**macOS**

1. `.dmg`를 열고 defE2End를 응용 프로그램 폴더로 옮기세요.
2. defE2End를 여세요. 개발자를 확인할 수 없다는 창이 뜨면 **완료**(또는 **확인**)를 누르세요.
3. **시스템 설정 > 개인정보 보호 및 보안**을 여세요. 아래쪽 defE2End 안내 옆의 **그래도 열기**를 누르고 확인하세요.

설치한 버전마다 한 번만 하면 돼요.

**Windows**

1. 설치 파일을 실행하세요.
2. Microsoft Defender SmartScreen이 "Windows의 PC 보호"를 띄우면 **추가 정보**를 누르고, 앱 이름이 받은 설치 파일과 같은지 확인한 뒤 **실행**을 누르세요.

**회사에서 관리하는 PC.** 회사 정책에 따라 서명 없는 앱이 아예 막히고 위 선택지가 나오지 않을 수 있어요. 이때는 IT 담당자에게 문의하고, 정책을 우회하려고 하지 마세요.

## 서버 연결

처음 실행하면 서버 주소(`BETTER_AUTH_URL`과 같은 주소)를 물어요. 웹과 같은 방법으로 로그인하세요. 나중에 바꾸려면 아래와 같은 메뉴의 **서버 주소 바꾸기…**를 쓰세요. 바꾸면 로그아웃돼요.

서버 관리자가 최소 앱 버전(`DESKTOP_MIN_VERSION`)을 정할 수 있어요. 그보다 오래된 앱은 연결 대신 업데이트 안내를 보여 줘요.

## 업데이트

앱은 스스로 업데이트하지 않아요. 시작하고 60초 뒤와 그 뒤 하루 한 번 GitHub의 공개 Releases API로 최신 정식 릴리스를 확인해서, 더 새 버전이 있으면 다운로드 페이지 링크와 함께 알려 줘요. 시험 릴리스(`-rc`)는 알리지 않아요.

- 요청에는 인증 정보, 서버 주소, 사용자 식별자가 실리지 않아요. 공개 API 요청이라 IP 주소는 GitHub에 전달돼요.
- 5초 안에 답이 없으면 끝내고, 실행을 막지 않고, 실패는 조용히 넘어가요.
- 끄려면 **defE2End** 메뉴(macOS)나 **파일** 메뉴(Windows)에서 **새 버전 알림 받기** 체크를 해제하세요. 첫 확인 전(시작 후 60초 안)에도 끌 수 있어요.

업데이트하려면 새 설치 파일을 받아 [검증](#파일-검증)하고 기존 앱 위에 설치하세요.

### 서버 호환

앱은 주 버전이 같고, 앱의 부 버전이 서버의 부 버전보다 최대 하나 낮은 서버에 연결돼요. 예를 들어 서버 1.4는 앱 1.3 이상의 1.x를 받아요. 그다음 실행을 앱으로 보낼 수 있는지는 앱이 알려 주는 기능 목록으로 정해요.

## 삭제

- macOS: 앱을 끝내고 응용 프로그램 폴더에서 휴지통으로 옮기세요.
- Windows: **설정 > 앱 > 설치된 앱 > defE2End > 제거**.
