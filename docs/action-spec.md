# 스텝 액션 명세

defE2End 의 스텝 형식·액션 동작·판정 명세다. 이 문서가 기준이다. `docs/stage3-contract.md` §1 의 액션 목록과 판정 의미는 이 문서로 **교체**한다(마지막 절). 스텝 형식은 공개 전이라 버전을 올리지 않고 그대로 바꾼다.

## 1. 스텝 형식

| 키 | 형 | 설명 |
|---|---|---|
| `id` | 문자열(1~64) | 시나리오 안에서 유일 |
| `action` | 아래 34개 중 하나 | 모르는 액션은 저장 거부 |
| `name` | 문자열(선택) | 표시용. 비면 `Step {번호}: {action}` |
| `selector` | 문자열(≤2000) | 대상 요소. iframe 액션에서는 iframe 경로 |
| `url` | 문자열 | `goto` 전용 |
| `value` | 문자열(≤10000) | 액션별 의미(3절) |
| `expected` | 문자열(≤10000) | 액션별 의미(3절) |
| `timeout` | 양의 정수 ms(≤600000) | 대기 한도. `wait` 에서는 대기 시간 |
| `optional` | 불리언 | 액션 실패를 `skipped` 로 기록하고 계속(2.9) |
| `position` | `{x, y}` 정수 px | `click` 전용 화면 좌표 |
| `threshold` | 숫자 0~100 | `screenshot` 전용 허용 변경률(%) |
| `mask` | 문자열 | `screenshot` 전용 추가 가림 셀렉터(쉼표·줄바꿈 구분) |

위 표에 없는 키는 저장 거부. **액션이 쓰지 않는 키(위 표에 있는 키)는 거부하지 않고 스텝에 그대로 저장한다** — 편집기에서 액션을 바꿨다 되돌려도 값이 남는다(예: fill 에 `hello` → click 으로 바꿔 저장 → 다시 fill 로 바꾸면 `hello`). 실행기와 검증은 액션이 쓰지 않는 키를 보지 않는다(형식 검사도 하지 않음). 저장·API·가져오기 모두 같은 검증(3절 "검증")을 쓴다.

## 2. 공통 의미

### 2.1 타임아웃
- `timeout` 이 없으면 30000ms. `wait` 만 1000ms.
- `optional` 이어도 기본값은 같다(30000ms).
- 한 액션이 여러 단계로 기다리면 단계마다 같은 한도를 쓴다(예: 대화상자 액션은 클릭에 한 번, 대화상자 대기에 한 번).

### 2.2 정착 대기
- **성공한** 스텝 뒤에만 500ms 기다린다. `wait` 는 제외. 경고·건너뜀·실패 스텝 뒤에는 없다.
- `screenshot` 은 이 대기 뒤에 찍는다.

### 2.3 셀렉터
두 문법을 쓴다.

**역할 문법** — `>>` 로 이은 조각이 **모두** 아래 형태일 때만 이 문법이다. 하나라도 아니면 문자열 전체를 Playwright 셀렉터로 본다.
- `역할(이름)`: 예 `link(Sign in)`, `button(Add to cart)`.
- 이름 없는 `역할`: HTML 태그 이름과 겹치지 않는 역할만(겹치는 것은 태그 셀렉터로 본다).
- 빈 괄호 `역할()`(예: `button()`)은 **이름 없음**과 같다: 역할만으로 찾고, 정확 일치 변형에서도 이름 있는 조각으로 치지 않는다. 단독 사용 제한도 받지 않는다(괄호가 있으므로 `button()` 은 허용). 괄호 안이 공백뿐이면(`button( )`) 이름이 있는 것으로 본다(부분 일치는 공백 포함 검색, 정확 일치는 빈 이름).
- 뒤 조각은 앞 조각이 찾은 요소 **안에서** 찾는다.
- 역할: alert, banner, button, cell, checkbox, columnheader, combobox, dialog, form, grid, gridcell, heading, img, link, list, listbox, listitem, main, navigation, option, radio, region, row, rowheader, searchbox, separator, slider, spinbutton, strong, tab, tablist, tabpanel, textbox, toolbar, tree, treeitem. 이 중 button, cell, dialog, form, img, link, list, main, option, strong 은 이름 없이 단독으로 쓸 수 없다.
- 이름은 기본적으로 접근성 이름의 부분 일치(대소문자 무시)다. **정확 일치**는 앞뒤 공백 제거·연속 공백 하나로 바꾼 뒤 대소문자 무시로 전체가 같은 것이다.
- **정확 일치 변형**은 체인 전체에 한 번에 적용한다: 이름 있는 **모든** 조각을 정확 일치로 바꾸고, 이름 없는 조각(위치 무관, 마지막 조각 포함 — 예 `region(Cart) >> checkbox`)은 역할만으로 찾는다. 이름 있는 조각이 하나도 없으면 정확 일치 변형은 없다. 조각별로 정확/부분을 섞지 않는다.

**Playwright 셀렉터** — CSS, `text=`, `role=`, `>>` 체인 등.

### 2.4 여러 요소가 맞을 때
요소 액션(아래 예외 제외)은 이 순서로 대상을 고른다.
1. 역할 문법에 이름이 있고, 액션 직전에 정확 일치 요소가 하나라도 있으면 정확 일치 쪽을 후보로 삼는다(숨겨져 있어도).
2. 후보에 대해 보통의 단일 대상 동작을 한다.
3. 여러 요소가 맞아 실패하면, 그 시점에 정확 일치가 있으면 그쪽을 풀로, 아니면 원래 후보를 풀로 삼아 **보이는 첫 요소**(없으면 첫 요소)로 같은 동작을 다시 한다. 실패로 치지 않고 로그만 남긴다.

예외(대체 없음, 여러 요소면 실패): iframe 액션 3종의 안쪽 요소. DOM 검증(`assertExists` 는 첫 요소, `assertCount` 는 전체 수, `assertJsonLd` 는 모든 블록, `assertTitle` 은 요소 없음)은 1·3 단계를 쓰지 않는다. `clickFirstEnabled` 는 자체 규칙.

### 2.5 비교 규칙
- **와일드카드 비교**: 기대값에 `*` 가 없으면 실제 값이 기대값을 부분 문자열로 포함하면 참. 있으면 `*` 만 "임의 문자열", 나머지는 글자 그대로인 패턴의 부분 일치(앞뒤 고정 없음). 대소문자 구분.
- **텍스트 포함**: 정규화 없이 대소문자 구분 부분 포함.

### 2.6 변수
- `{{이름}}` 을 `url`·`selector`·`value`·`expected` 에서 실행 시작 때 한 번 치환한다. 결과를 다시 치환하지 않는다.
- 이름은 ASCII 영문자·숫자·밑줄 **한 글자 이상**이고 순서 제약이 없다(숫자로 시작해도 됨: `{{1USER}}`, `{{_}}`). 중괄호 안에 공백·하이픈·점 등이 있으면 변수가 아니며 글자 그대로 둔다. 이름은 대소문자를 구분한다.
- 이름이 변수 목록에 **자기 키로** 있을 때만 치환한다(값이 빈 문자열이어도 치환).
- **정의되지 않은 변수는 글자 그대로 남긴다**(실패 아님).
- 비밀 변수의 값은 결과·로그·스크린샷에서 가린다. 정의된 비밀 변수의 값이 비어 있으면 그 스텝은 `failed`(`missing_secret`).
- 저장 검증은 `{{` 가 들어 있는 값에서 형식 검사를 건너뛴다.
- **"필수"는 저장 때만의 규칙이다.** 실행기는 치환 결과가 빈 문자열이 됐다는 이유로 스텝을 거부하지 않고, 빈 값 그대로 액션 동작을 한다. 예: assertUrl·assertTitle·assertPopupUrl·assertText 의 빈 기대값은 "빈 문자열 포함"이라 통과, waitForUrl 의 빈 패턴은 어떤 URL 과도 맞아 즉시 통과, clickAndSubmitPrompt 의 빈 값은 빈 입력으로 확인, assertResponse 의 빈 패턴은 스텝 시작 뒤 첫 응답, 빈 상태값은 200, goto 의 빈 url 은 기본 주소로 이동, uploadFile 의 빈 값은 파일 0개 지정. 액션 자체 규칙으로 빈 값이 실패하는 경우(assertCount 정수 아님, assertJsonLd 문법 오류, pressKey 키 없음, select 맞는 option 없음)만 `failed`.

### 2.7 페이지·새 창·iframe
- 실행은 **처음 페이지** 하나로 시작한다. **현재 새 창** 참조는 하나뿐이고 처음엔 없다.
- `clickAndWaitPopup` 은 감시 구간(클릭과 동시에 시작, 타임아웃까지) 동안 브라우저 컨텍스트에 **처음 생긴 페이지**를 현재 새 창으로 삼는다. 여러 개가 열려도 오류가 아니며 첫 것만 쓴다. 누가 열었는지는 보지 않는다. 이전 새 창은 닫지 않고 참조만 바꾼다.
- 새 창 전용 액션(`clickInPopup`·`fillInPopup`·`assertVisibleInPopup`·`assertPopupUrl`)은 현재 새 창에서, `closePopup` 은 그것을 닫고 참조를 비운다. 새 창이 없으면 새 창 전용 액션은 `failed`("No popup page available. Use clickAndWaitPopup first.").
- `wait`·`screenshot` 은 **지금 앞에 보이는(마지막으로 활성화된) 페이지**를 쓴다. 그 밖의 모든 액션은 새 창이 열려 있어도 **처음 페이지**에서 동작한다.
- iframe 액션은 `selector` 를 `>>>` 로 나눠(빈 조각 무시) 바깥 iframe 부터 들어간 뒤 `value` 셀렉터(Playwright 문법)로 안쪽 요소를 찾는다. 상태는 없다.

### 2.8 대화상자
- **처음 페이지**에는 실행 내내 기본 처리기가 있어, 뜨는 대화상자를 자동으로 **확인**한다. 스텝은 실패하지 않는다.
- 새 창에는 처리기가 없어 대화상자가 자동으로 **취소**된다. 스텝은 실패하지 않는다.
- 대화상자 액션 3종(처음 페이지 전용) 실행 동안에는 기본 처리기를 떼고 그 스텝 전용 처리기를 한 번 건다. 끝나면(성공·실패 모두) 기본 처리기를 되돌린다.
- 순서: 전용 처리기 등록 → `selector` 클릭(타임아웃) → 대화상자 처리를 최대 타임아웃까지 기다림 → 안 뜨면 `failed`("dialog did not appear").
- 전용 처리기는 액션별 종류 검사·처리로 대화상자를 **먼저 닫은 뒤**, `expected` 가 있으면 메시지가 그것을 포함하는지(대소문자 구분) 본다. 종류 오류와 메시지 불일치가 함께 나면 종류 오류만 보고한다.

### 2.9 재시도·optional
- **스텝 재시도**: 일반 스텝은 최대 2번 시도한다. 실패하면 **1초** 쉬고 다시 한다. 페이지를 되돌리지 않으며, 다시 시도했으면 결과에 "retried" 를 남긴다. `optional` 스텝과 경고 결과는 재시도하지 않는다. 취소·시간 초과·점유 상실·인프라 오류는 재시도하지 않는다.
- **optional**: 재시도 없이 1번만 한다. **액션 실패**만 `skipped`("[optional] " + 사유)로 바꾸고 실행을 계속한다. 취소·시간 초과·점유 상실·안전 차단(네트워크 차단 등)은 바꾸지 않는다. 경고는 경고 그대로.

### 2.10 자동 스크롤
녹화·스크린샷에서 대상이 보이도록 요소 대상 스텝은 대상의 첫 요소를 화면 세로 가운데로 즉시 스크롤한다. 판정에 영향이 없고 실패는 무시한다.
- 대상 액션: click, fill, select, hover, pressKey, clickFirstEnabled, clickAndWaitPopup, 대화상자 3종, uploadFile, clickInPopup, fillInPopup, clickInIframe, fillInIframe, assertVisible, assertVisibleOrWarn, assertText, assertVisibleInIframe, assertVisibleInPopup, waitForSelector. 셀렉터가 없는 click·pressKey 는 제외.
- 액션 전에 한다. 요소 찾기 한도 2000ms(스텝 타임아웃이 짧으면 그 값), 스크롤 뒤 150ms 정착.
- `assertVisibleOrWarn` 과 `optional` 스텝은 지금 있을 때만(기다리지 않음, 한도 500ms).
- `waitForSelector` 는 대기가 성공한 뒤에 한다.
- assertVisible·assertVisibleOrWarn·assertText·assertVisibleInIframe·assertVisibleInPopup 은 사전 스크롤을 못 했으면 판정 통과 뒤 한 번 더(있을 때만) 한다.

### 2.11 값 입력 직전 가림
fill, pressKey, fillInPopup, fillInIframe, clickAndSubmitPrompt 는 값을 넣기 직전에 개인정보 가림을 한 번 더 적용한다(실패는 무시).

## 3. 액션

### 빈 selector (실행 때)
치환 결과 selector 가 빈 문자열이 되면 "selector 없음"으로 본다. 결과: click(좌표 없으면 통과), pressKey(현재 포커스에 키), scroll(value 규칙), assertJsonLd(기본 셀렉터)는 정상 동작. 그 밖에 selector 가 대상인 액션은 빈 셀렉터로 요소를 찾다가 `failed` 다(빈 셀렉터는 유효한 셀렉터가 아님). 자동 스크롤은 건너뛴다.

필드 한국어 라벨(편집기에 그대로 쓴다. 라벨이 도움말을 겸하며 따로 placeholder 는 없다):

| 액션 | 필드 → 한국어 라벨 |
|---|---|
| 기본(아래에 없는 경우) | url "URL" · selector "셀렉터" · value "값" · expected "기대값" · timeout "타임아웃 (ms)" · name "이름" |
| 모든 스텝 공통 | 액션 "액션" · 이름 "스텝 이름 (선택)"(placeholder "스텝 설명") · 체크박스 "선택적 실행 (실패해도 다음 스텝 진행)" |
| click 좌표 | "X 좌표"(placeholder "X") · "Y 좌표"(placeholder "Y") |
| iframe 3종 | selector "iframe 셀렉터" · value "내부 요소 셀렉터" · expected "입력값" · timeout "타임아웃 (ms)" |
| clickFirstEnabled | selector "셀렉터" · expected "활성 CSS 조건" · timeout "타임아웃 (ms)" |
| assertResponse | expected "API URL 패턴" · value "기대 상태코드 (기본 200)" · timeout "타임아웃 (ms)" |
| scroll | selector "셀렉터 (요소까지 스크롤, 입력 시 값보다 우선)" · value "값 (픽셀 / bottom / top, 기본 300)" |
| clickAndWaitPopup | selector "클릭할 셀렉터 (클릭과 동시에 새 창 대기)" · timeout "타임아웃 (ms)" |
| screenshot | name "이름" · threshold "허용 변경률 (%, 기본 5) — 기준 대비 이보다 크게 바뀌면 경고" · mask "추가 마스킹 셀렉터 (콤마/개행 구분, 선택)" |
| uploadFile | selector "파일 input 셀렉터" · value "파일 URL (직접 입력 또는 옆 버튼으로 업로드)" · 버튼 "업로드"(툴팁 "이미지 업로드")·"생성"(툴팁 "테스트 이미지 생성", 창 제목 "테스트 이미지 크기", placeholder "가로"/"세로", 도움말 "1~4096 사이의 정수. 검은 배경에 크기를 적은 PNG 를 만들어 업로드합니다.") |
| pressKey | selector "셀렉터 (선택) — 주면 이 요소에 포커스를 준 뒤 입력, 비우면 현재 포커스" · value "키 이름 (필수) — Enter, Escape, Tab, ArrowDown 등 Playwright 키 이름" |
| assertVisibleOrWarn | selector "셀렉터" · expected "경고 메시지 (없을 때 기록·알림에 표시, 선택)" · timeout "대기 시간 (ms, 기본 30000) — 이 시간 안에 없으면 경고" |
| assertExists | selector "셀렉터 (보이지 않아도 DOM 에 있으면 통과)" |
| assertCount | selector "셀렉터" · expected "기대 개수 (0 = 없어야 함)" |
| assertJsonLd | selector "ld+json 셀렉터 (비우면 기본)" · expected "조건식 (예: @type=Product)" |
| assertTitle | expected "기대 제목 (* 와일드카드)" |
| 필드 없음 | "이 액션은 입력값이 필요 없습니다." (closePopup 은 뒤에 " 현재 열린 새 창을 닫습니다.") |

나머지 액션(goto, click, fill, select, hover, wait, waitForSelector, waitForUrl, assertVisible, assertText, assertUrl, 새 창 액션, 대화상자 3종)은 기본 라벨을 쓴다. 예: 대화상자의 expected 는 "기대값", clickAndSubmitPrompt 의 value 는 "값". 영문 라벨은 이 문서 표의 라벨을 쓴다.

액션 라벨(편집기 목록에 그대로 쓴다):

| 액션 | 한국어 라벨 | 액션 | 한국어 라벨 |
|---|---|---|---|
| goto | 페이지 이동 | assertResponse | API 응답 확인 |
| click | 클릭 | assertPopupUrl | 새 창 URL 확인 |
| fill | 입력 | assertVisibleInPopup | 새 창 요소 확인 |
| select | 선택 | hover | 호버 |
| pressKey | 키 입력 | clickFirstEnabled | 첫 활성 요소 클릭 |
| waitForSelector | 요소 대기 | scroll | 스크롤 |
| screenshot | 스크린샷 | clickAndAcceptDialog | 클릭 후 dialog 확인 |
| assertText | 텍스트 확인 | clickAndDismissDialog | 클릭 후 dialog 취소 |
| assertVisible | 요소 표시 확인 | clickAndSubmitPrompt | 클릭 후 prompt 입력 |
| assertVisibleOrWarn | 요소 표시 확인(없으면 경고) | uploadFile | 파일 업로드 |
| assertUrl | URL 확인 | assertExists | 요소 존재 확인 |
| waitForUrl | URL 대기 | assertCount | 요소 개수 확인 |
| clickInIframe | iframe 내 클릭 | assertJsonLd | 구조화 데이터(ld+json) 확인 |
| fillInIframe | iframe 내 입력 | assertTitle | 페이지 제목 확인 |
| assertVisibleInIframe | iframe 내 요소 확인 | wait | 대기 |
| clickAndWaitPopup | 클릭 후 새 창 대기 | clickInPopup | 새 창에서 클릭 |
| fillInPopup | 새 창에서 입력 | closePopup | 새 창 닫기 |

편집기 목록 순서: goto, click, fill, select, pressKey, waitForSelector, screenshot, assertText, assertVisible, assertVisibleOrWarn, assertUrl, waitForUrl, clickInIframe, fillInIframe, assertVisibleInIframe, wait, clickAndWaitPopup, clickInPopup, fillInPopup, closePopup, assertResponse, assertPopupUrl, assertVisibleInPopup, hover, clickFirstEnabled, scroll, clickAndAcceptDialog, clickAndDismissDialog, clickAndSubmitPrompt, uploadFile, assertExists, assertCount, assertJsonLd, assertTitle.

편집기는 모든 스텝에 **Action**(목록, 새 스텝 기본값 `goto`), **Step name (optional)**(텍스트), **Optional step — continue if it fails**(체크박스 = `optional`)를 둔다. 아래 필드가 그다음 순서대로 나온다. `timeout`·`threshold`·좌표는 숫자 칸(비우면 미지정), 나머지는 텍스트 칸이다. 필드가 없는 액션은 "This action has no inputs." 를 보여 준다. 액션을 바꿔도 다른 필드 값은 지우지 않고, 저장할 때도 그대로 저장한다(1절).

"검증"은 저장·API·가져오기에서 거부하는 조건이다. 실행 판정은 "동작"을 따른다.

### 3.1 이동·조작

**goto**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| url | URL | text | 예 | — | `http` 로 시작하지 않으면 환경 기본 주소 뒤에 그대로 붙는다 |

동작: 주소를 만든다(`http` 로 시작하면 그대로, 아니면 기본 주소 + `url` 을 글자 그대로 이어 붙임). DOMContentLoaded 까지 기다린다. 통과: 시간 안에 로드. **HTTP 상태는 보지 않는다.** 네트워크 차단에 걸리면 `failed`.

**click**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| selector | Selector | text | position 이 없으면 예 | — | |
| position.x / position.y | X / Y | number | selector 가 없으면 예 | — | selector 가 비었거나 position 이 있을 때만 보인다 |

실행 때 판단: selector 가 **빈 문자열이 아니면** 요소 클릭, 비었으면(없음 또는 치환 결과 `""`) position 이 있으면 좌표 클릭, 둘 다 없으면 **아무것도 하지 않고 통과**한다.
동작: selector 가 있으면 요소 클릭(보이고 활성·안정될 때까지 대기). 없으면 화면 좌표를 클릭(대기 없음). selector 가 있으면 position 은 무시.

**fill**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| selector | Selector | text | 예 | — | |
| value | Value | text | — | `""` | 비우면 입력란을 비운다. `{{변수}}` 사용 가능 |

동작: 내용을 지우고 value 를 입력.

**select**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| selector | Selector | text | 예 | | |
| value | Value | text | 예 | — | option 의 value 또는 label |

동작: **자동화 라이브러리의 표준 옵션 선택 동작(Playwright `selectOption`)을 그대로 쓴다.** 직접 구현하지 않는다. value 문자열 하나를 "value 또는 label" 조건 하나로 넘긴다(value 전용·label 전용·index 로 넘기지 않는다). 그 동작의 의미는 다음과 같다.
- 대상 재지정: 대상이 `<label>` 이거나 label 안의 요소면 연결된 컨트롤로 바꾼다. 그것이 `<select>` 가 아니면 `failed`.
- 행동 가능 조건: select 가 보이고 활성(비활성 속성·`aria-disabled`·비활성 fieldset 안 아님)일 때까지 기다린다. 선택할 option 도 활성이어야 한다(option 자신이나 감싼 optgroup 이 disabled 면 비활성).
- 일치: option 을 문서 순서로 보며 `option.value` 가 값과 정확히 같거나, `option.label` 이 값과 그대로 같거나, 둘 다 정규화(U+200B 폭 없는 공백·U+00AD 소프트 하이픈 제거 → 앞뒤 공백 제거 → 연속 공백 하나로) 뒤 같으면 맞는다. 단일 select 는 처음 맞는 option 하나. 대소문자 구분.
- 대기 중 재해석: 맞는 option 이 없거나 비활성이면 타임아웃까지 다시 시도하고, **시도마다 요소와 option 목록을 새로 찾는다**(위치를 기억하지 않음). 성공한 시도 시점의 목록에서 고른다.
- 고른 뒤 input·change 이벤트를 보낸다. 타임아웃이면 `failed`.

**pressKey**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| selector | Selector (optional) — focus this element first; empty = current focus | text | 아니오 | — | |
| value | Key (required) — Enter, Escape, Tab, ArrowDown, … | text | 예 | — | Playwright 키 이름·조합(`Control+a`) |

동작: selector 가 있으면 포커스 후 키를 누른다(타임아웃). 없으면 현재 포커스에 누른다.

**hover** — selector(Selector, 필수). 요소 위로 마우스를 올린다.

**scroll**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| selector | Selector (scroll to element; wins over value) | text | 아니오 | — | |
| value | Value (pixels / bottom / top, default 300) | text | 아니오 | 300 | |

동작 우선순위: (1) selector 가 있으면 그 요소가 보이게 최소 스크롤. (2) value 를 앞뒤 공백 제거·소문자로 바꿔 `bottom` 이면 맨 아래, `top` 이면 맨 위. (3) 아니면 value 를 숫자로 읽어 세로 상대 이동(음수는 위). 숫자가 아니거나 0·빈 값이면 300px. 가로 스크롤은 없다.

**wait**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| timeout | Timeout (ms) | number | 아니오 | 1000 | |

동작: 그만큼 기다린다. 활성 페이지 기준. 뒤에 정착 대기 없음.

**uploadFile**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| selector | File input selector | text | 예 | — | 화면의 버튼이 아니라 `<input type=file>` 자체(숨겨져도 됨) |
| value | File URL (type it or use the upload button) | text + 업로드 버튼 | 예 | — | 공백·쉼표로 여러 개. 각 토큰이 `http(s)://` 또는 `attachment:<이름>`(워크스페이스 첨부) |

편집기: value 옆에 버튼 두 개. 둘 다 결과로 value 를 **덮어쓴다**(이어 붙이지 않음).
- **Upload**: 이미지 파일(여러 개)을 고르게 한다. 고른 순서대로 하나씩 올리고, 결과 토큰들을 `, ` 로 이어 value 에 넣는다. 실패하면 오류 알림, value 는 그대로.
- **Generate**: 작은 창에 **Width**·**Height**(숫자, 기본 750·900, 각각 1~4096 정수가 아니면 생성 버튼 비활성, Enter 로도 생성)를 받는다. 검은 배경 가운데에 흰 굵은 글씨로 `가로×세로` 를 적은 PNG(글자 크기 = 짧은 변의 12% 반올림, 최소 12px)를 만들어 `test-{가로}x{세로}.png` 이름으로 올리고 그 토큰을 value 에 넣는다. 도움말: "Integer from 1 to 4096. Creates and uploads a PNG with the size written on a black background."

업로드 버튼 저장 방식: 파일을 워크스페이스 첨부로 올리고 `attachment:<이름>` 을 넣는다(이름의 공백·쉼표·`%` 는 퍼센트 인코딩). 첨부 토큰은 파일 이름 칩으로 보이고, URL 직접 입력도 그대로 된다.

**`attachment:<이름>`**: 워크스페이스 첨부를 가리킨다. 이름 규칙은 첨부 이름 규칙(1~200자, 제어 문자·슬래시 없음, 앞뒤 공백 없음). 첨부 버전을 실행 요청 때 고정하므로 이 토큰에는 `{{변수}}` 를 쓸 수 없다(값에 다른 `{{` 가 있어도 저장 거부). 실행 요청 시 이름마다 그 워크스페이스의 최신 버전을 snapshot 에 고정하고(없으면 400), 실행은 그 버전 파일을 쓴다(파일 이름·형식은 첨부의 이름·Content-Type). URL 과 섞어 쓸 수 있고 순서대로 지정된다. 고정되지 않은 첨부 토큰은 `failed`(`invalid_step`).

동작: (1) URL 목록을 만든다(첨부 토큰은 위 규칙대로 저장소에서 읽고, 아래 다운로드 규칙은 URL 토큰에만 적용). (2) 각 URL 을 실행기가 내려받는다(타임아웃, **네트워크 차단·리다이렉트 검사·크기 상한 적용**). 2xx 가 아니면 `failed`("could not download file (HTTP n): URL"). (3) 파일 이름은 URL 경로 마지막 조각(퍼센트 디코딩). 형식은 응답 Content-Type(매개변수 제거), 없거나 `application/octet-stream` 이면 확장자로(png, jpg/jpeg, gif, webp, svg, pdf), 그래도 없으면 octet-stream. 이름이 비면 `upload.<확장자>` 또는 `upload`. (4) input 에 전부 한 번에 지정한다. 클릭하지 않고 보임을 기다리지 않는다. 대상 input 은 2.4 규칙으로 고른다: 셀렉터가 input 하나에만 맞으면 그것(숨겨져도), 여러 개에 맞으면 **보이는 첫 input**, 보이는 게 없으면 첫 input. 토큰이 하나도 없으면(값이 변수 치환으로 비었을 때) 빈 목록을 지정하고 통과한다.

**clickFirstEnabled**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| selector | Selector | text | 예 | — | |
| expected | Active CSS condition | text | 아니오 | — | `속성:값` 을 세로줄로 나열. 예 `background-color:#000000` |
| timeout | Timeout (ms) | number | 아니오 | 30000 | 자동 스크롤에만 쓰인다 |

동작: (1) 셀렉터를 **역할 문법 없이 Playwright 셀렉터로만** 해석해(`button(Go)` 는 셀렉터 오류로 `failed`), **지금** 맞는 요소들을 순서대로 본다(기다리지 않음, 2.4 규칙 없음). (2) 안 보이거나 `disabled` 속성이 있으면 건너뛴다. (3) expected 가 빈 문자열이 아니면 활성 조건을 본다. 세로줄로 나눈 조각(빈 조각 포함)마다:
   - 첫 `:` 앞을 속성 이름, 뒤를 값으로 하고 각각 앞뒤 공백을 지운다. `:` 가 없으면 속성 이름은 빈 문자열, 값은 조각 전체(공백 제거).
   - 값이 `#` 로 시작하고 정확히 7글자면 뒤 6글자를 두 글자씩 16진수로 읽어 `rgb(r, g, b)`(쉼표 뒤 공백 하나)로 바꾼다. 16진수가 아니면 그 자리는 `NaN` 이 된다. 그 밖의 값은 그대로.
   - 요소의 계산된 스타일에서 그 속성 값을 문자열로 읽는다(모르는 속성·빈 이름이면 빈 문자열). 그 문자열이 값을 **부분 문자열로 포함**하면 참(대소문자 구분).
   - 따라서 빈 조각(예: `color:blue|` 의 뒤쪽)이나 `color:` 처럼 값이 빈 조각은 **항상 참**이고, `:` 없는 조각(예: `blue`)은 값이 비지 않는 한 항상 거짓이다.
   조각 중 하나라도 참이면 활성, 아니면 건너뛴다. (4) 남은 요소를 2000ms 한도로 클릭하고, 실패하면 다음 요소로. (5) 하나도 못 누르면 `failed`("No enabled element found for …").

### 3.2 대기·검증

**waitForSelector** — selector(Selector, 필수), timeout(Timeout (ms)). 요소가 보일 때까지 기다린다.

**waitForUrl**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| expected | URL pattern | text | 예 | — | `*` 와일드카드. 중괄호 짝이 맞아야 함 |
| timeout | Timeout (ms) | number | 아니오 | 30000 | |

동작: 처음 페이지 URL 이 맞을 때까지 기다린다. 판정 시점은 내비게이션 **커밋**이다(로드 완료를 기다리지 않음). 지금 이미 맞으면 바로 통과.
- `*` 가 있으면 와일드카드 비교(2.5).
- 없으면 부분 포함이고 `?`·`.`·`[`·`(` 등은 글자 그대로다. 단 `{a,b}` 는 대안 묶음(a 또는 b, 묶음 밖 쉼표는 글자), 역슬래시는 다음 글자를 글자 그대로 만들고 자신은 사라진다. 짝이 안 맞거나 중첩된 중괄호는 `failed`. 대소문자 구분.

**assertVisible** — selector(Selector, 필수). 편집기에 timeout 칸 없음(API 로는 지정 가능). 요소가 보일 때까지 기다린다.

**assertVisibleOrWarn**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| selector | Selector | text | 예 | | |
| expected | Warning message (shown in results and notifications, optional) | text | 아니오 | "Element not found (warning): {selector}" | |
| timeout | Wait time (ms, default 30000) — warn if not visible by then | number | 아니오 | 30000 | |

동작: 요소가 보일 때까지 기다린다. 보이면 `passed`. 기다림이 어떤 이유로든 실패하면(치환 결과 selector 가 빈 문자열이라 찾지 못한 경우 포함) `warning`(메시지 = expected 또는 기본 문구), 재시도 없이 실행 계속.

**assertText**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| selector | Selector | text | 예 | | |
| expected | Expected | text | 예(빈 값 거부) | — | 변수가 실행 때 `""` 로 풀리는 것은 허용 |

동작: 요소가 붙을 때까지(보임 불필요) 기다려 **textContent 를 한 번** 읽는다. 텍스트 포함(2.5)이면 통과. 다시 읽으며 기다리지 않는다. 빈 기대값은 항상 통과. 실패 문구에 기대값·셀렉터·실제 텍스트.

**assertUrl** — expected(Expected, 필수). 처음 페이지의 **지금** URL 을 한 번 보고 와일드카드 비교. 기다리지 않는다.

**assertTitle** — expected(Expected title (* wildcard), 필수). 250ms 마다 문서 제목을 와일드카드 비교, 타임아웃까지 안 맞으면 `failed`.

**assertCount**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| selector | Selector | text | 예 | | |
| expected | Expected count (0 = must not exist) | text | 예 | — | 0 이상 정수 |

동작: 250ms 마다 맞는 요소 수(보임 무관)를 센다. 한 번이라도 같으면 통과. 실행 때 정수가 아니면 바로 `failed`.

**assertExists** — selector(Selector (passes if in the DOM, even when hidden), 필수). 첫 요소가 DOM 에 붙을 때까지 기다린다(meta, link, script 등).

**assertJsonLd**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| selector | ld+json selector (empty = default) | text | 아니오 | `application/ld+json` 타입 script | |
| expected | Condition (e.g. @type=Product) | text | 예 | — | 문법 검사 |

조건식(한 스텝 하나). 식 전체의 앞뒤 공백만 지운다. **연산자 주변 공백은 지우지 않는다**: `@type = Product` 는 키 `@type `(끝 공백 포함)과 값 ` Product`(앞 공백 포함)로 읽혀 맞지 않는다. 값은 첫 `=` 뒤 전부(다른 `=` 포함)이고, 값에 따옴표를 쓰면 따옴표도 값의 일부다:
- `경로` 존재 / `경로=값` 문자열 동일 / `경로*=값` 포함. 연산자는 첫 `=` 로 가르고 바로 앞이 `*` 면 포함.
- 경로는 `.` 로 나눈 조각. 조각은 이름(`.` `[` `]` 를 뺀 문자, `@` 허용, 비면 안 됨) + 대괄호 0개 이상. 대괄호 안은 0 이상 정수 또는 `*`.
- 문법 오류(빈 식, 빈 조각, 대괄호로 시작, 잘못된 인덱스, 연산자 앞 경로 없음, 연산자 뒤 값 없음)는 저장 거부, 실행 때는 기다리지 않고 `failed`.

동작: 250ms 마다 맞는 블록의 텍스트를 JSON 으로 읽는다. 파싱 실패 블록은 기록하고 뺀다. 배열은 원소로 펼치고, `@graph` 배열이 있는 객체는 자신과 `@graph` 원소들을 후보로 삼는다(재귀). 경로: 이름은 객체 키, `[N]` 은 배열에만, `[*]` 는 배열이면 모든 원소이고 아니면 그 값 하나. 후보·경로 결과 중 하나라도 맞으면 참.
- 존재: null·없음·`""`·빈 배열·빈 객체가 아니면 참(0·false 는 참).
- 동일·포함: 경로 끝 값이 배열이면 원소 중 하나라도(한 단계만, 중첩 배열·객체 원소는 거짓). 비교할 수 있는 값은 문자열·숫자·불리언뿐이다: 문자열은 그대로, 숫자는 JavaScript 기본 숫자→문자열 변환(가장 짧게 되돌릴 수 있는 자릿수. 절댓값이 1e21 이상이거나 1e-6 미만이면 지수 표기이고 지수에 부호를 항상 붙인다: `1e21` → `1e+21`, `0.0000001` → `1e-7`, 그 밖에는 소수 표기: `1.50` → `1.5`, `1.0` → `1`, `-0` → `0`). 그래서 `{"big":1e21}` 에 `big=1e+21` 은 맞고 `big=1e21` 은 맞지 않는다. 불리언은 `true`/`false` 로 바꿔 대소문자 구분 비교한다. **null 은 어떤 비교에서도 거짓**이다(`name=null` 은 `{"name":null}` 에 맞지 않음). 객체는 거짓.

블록이 하나 이상이고 참이면 통과. 타임아웃이면 `failed`: 블록이 없으면 "no ld+json (selector)", 있으면 조건·블록 수·발견된 `@type` 목록·파싱 실패 목록.

**assertResponse**
| 키 | 라벨 | 형 | 필수 | 기본 | 검증·도움말 |
|---|---|---|---|---|---|
| expected | API URL pattern | text | 예 | — | 부분 문자열 |
| value | Expected status (default 200) | text | 아니오 | 200 | 저장 시 100~599 정수(변수 제외) |
| timeout | Timeout (ms) | number | 아니오 | 30000 | |

동작: **처음 페이지**(그 안의 iframe 포함)에서 **이 스텝이 시작된 뒤** 받은 응답 중 URL 이 expected 를 포함하는 **첫 응답**을 기다린다(메서드 무관). 기대 상태: value 가 빈 문자열이거나 없으면 200. 아니면 문자열 전체를 JavaScript 숫자 변환으로 읽는다 — 앞뒤 공백 무시, 소수·지수(`200.0`, `2e2`), 16진 `0x`·8진 `0o`·2진 `0b` 접두(`0xC8`) 허용 → 모두 200. 공백뿐인 값은 0(항상 불일치), 숫자가 아니면 NaN(항상 불일치). 상태가 기대값과 **정확히** 같으면 통과, 다르면 `failed`. 타임아웃까지 없으면 `failed`. 이 스텝 전에 받은 응답, 새 창 등 다른 페이지의 응답은 보지 않는다.

**screenshot**
| name | Name | text | 아니오 | — | 스텝 이름과 같은 값 |
|---|---|---|---|---|---|
| threshold | Allowed change (%, default 5) — warn when it changes more than this from the baseline | number | 아니오 | 5 | 0~100 |
| mask | Extra mask selectors (comma/newline separated, optional) | text | 아니오 | — | |

동작: 정착 대기 뒤 **활성 페이지의 뷰포트**를 찍는다. 개인정보 가림과 mask 셀렉터 영역을 가린다. 통과.
기준 비교(단계 7, 지금은 하지 않음): 기준이 없으면 이번 화면이 기준. 크기가 다르면 `warning`. 다른 픽셀 비율이 threshold 이하면 일치. 넘으면 구조 유사도가 0.95 이상이면 작은 밀림(경고 아님), 미만이면 `warning`. 그때까지 threshold 는 저장만 한다.

### 3.3 새 창

| 액션 | 필드(키 — 라벨, 필수) | 동작 |
|---|---|---|
| clickAndWaitPopup | selector — Selector to click (waits for a new window at the same time), 예 · timeout | 새 페이지 감시를 시작하면서 클릭(2.7). 열린 페이지의 DOMContentLoaded 를 기다려 현재 새 창으로 삼는다. 시간 안에 안 열리면 `failed` |
| clickInPopup | selector — Selector, 예 · timeout | 현재 새 창에서 click(좌표 없음) |
| fillInPopup | selector — Selector, 예 · value — Value · timeout | 현재 새 창에서 fill |
| assertVisibleInPopup | selector — Selector, 예 · timeout | 현재 새 창에서 assertVisible |
| assertPopupUrl | expected — Expected, 예 | 현재 새 창의 지금 URL 을 와일드카드 비교. 기다리지 않음 |
| closePopup | 없음("Closes the current new window.") | 현재 새 창을 닫는다. 없으면 아무것도 안 하고 통과 |

### 3.4 iframe

| 액션 | 필드 | 동작 |
|---|---|---|
| clickInIframe | selector — iframe selector, 예 · value — Inner element selector, 예 · timeout | iframe 경로 안 요소 클릭 |
| fillInIframe | selector · value(위와 같음) · expected — Text to enter(필드는 있어야 함, 빈 값 허용) · timeout | 안쪽 요소에 expected 입력 |
| assertVisibleInIframe | selector · value · timeout | 안쪽 요소가 보일 때까지 기다림 |

검증: selector 에 `iframe` 글자가 있어야 한다(대소문자 무시). 실행 때 iframe 경로가 비면(치환 결과 `""`, 또는 `>>>` 조각이 모두 빈 경우) 프레임을 찾지 않고 타임아웃까지 기다린 뒤 `failed` 다(페이지의 iframe 수·내용과 무관).

### 3.5 대화상자

| 액션 | 필드 | 처리기 | `failed` 조건 |
|---|---|---|---|
| clickAndAcceptDialog | selector — Selector, 예 · expected — Expected message (contains, optional) · timeout | 종류 상관없이 확인(prompt 는 빈 입력) | 안 뜸, 메시지 불일치 |
| clickAndDismissDialog | 위와 같음 | alert 면 확인으로 닫고 실패("alert can't be dismissed; use clickAndAcceptDialog"). 그 외는 취소 | 안 뜸, alert, 메시지 불일치 |
| clickAndSubmitPrompt | selector, 예 · value — Prompt text, 예(빈 값 거부) · expected · timeout | prompt 가 아니면 취소로 닫고 실패. prompt 면 value 를 넣고 확인 | 안 뜸, prompt 아님, 메시지 불일치 |

## 4. 결과와 실행 판정

### 4.1 스텝 상태
| 상태 | 언제 | 실행 계속 | 기록 |
|---|---|---|---|
| `passed` | 성공 | 예 | 소요 시간, retried, screenshot 스텝의 스크린샷 |
| `warning` | assertVisibleOrWarn 대상 없음. (단계 7) 화면 변경 | 예 | 경고 문구, 소요 시간 |
| `skipped` | optional 스텝의 액션 실패, 또는 실패·중단 뒤 실행하지 않은 스텝 | 예 / — | "[optional] " + 사유 |
| `failed` | 그 밖의 액션 실패(재시도 뒤) | 아니오 | 사유 + 그 스텝 동안의 브라우저 로그(4xx/5xx·JS 오류), 실패 화면 스크린샷(가림 적용, 스텝 mask 미적용) |
| `error` | 인프라 오류 | 아니오 | |
| `cancelled` / `timed_out` | 실행 중단 시 그 스텝 | 아니오 | |

### 4.2 실행 판정
- `failed` 스텝이 하나라도 있으면 `failed`. 인프라 오류는 `error`. 취소·전체 시간 초과는 원인대로 `cancelled`·`timed_out`(브라우저를 닫아 생긴 예외로 덮지 않음).
- 그 밖에는 `passed`. `warning`·`skipped` 가 있어도 `passed` 다.
- 실행에 **경고 수**를 둔다. 결과 화면·알림에 경고 스텝 목록(이름 — 문구)을 보인다.
- CI 는 `passed` 만 통과로 본다. 별도 옵션(`failOnWarning`)을 켜면 경고가 하나라도 있는 `passed` 도 실패로 본다.

### 4.3 실행 전체 재시도
- 시도가 `failed` 로 끝나면 처음부터 다시 돈다. 기본 **1회 추가**(최대 2회 시도).
- `error`·작업자 상실·`cancelled`·`timed_out` 뒤에는 다시 돌지 않는다.
- **총 시도 횟수**는 인스턴스 설정(환경 변수 `RUN_RETRY_ATTEMPTS`)이다. 첫 시도를 포함한 횟수이고 기본 2. 1 이면 다시 돌지 않는다. 0·음수·숫자가 아닌 값·비어 있음은 기본 2. 양의 소수는 올림한 횟수다(시도 번호가 그 값보다 작은 동안 다시 돈다).
- 시나리오별 설정으로 끌 수 있다(끄면 인스턴스 설정과 상관없이 1회).
- 모든 시도는 **같은 Run** 안에 남긴다. 스텝 결과와 산출물에 시도 번호를 붙인다. 실행 판정은 마지막 시도의 판정이다.
- 마지막 시도가 `passed` 이고 앞 시도가 있었으면 화면에 "passed after retry" 를 보인다.
- 스텝 재시도와 곱해져, 계속 실패하는 스텝은 최대 4번 실행된다.

## 5. 이전 단계 3 계약 대비 바꿀 것

1. 액션 목록 교체: `navigate`·`press`·`upload`·`assertHidden`·`assertAttribute`·`dialog`·`switchPage` 를 없애고 3절의 34개로 바꾼다. 스텝 키도 `target`·`value`·`options` 에서 1절 키로 바꾼다. 버전은 올리지 않는다.
2. 여러 요소가 맞을 때 `ambiguous_target` 실패 → 2.4 대체 규칙(iframe·DOM 검증만 실패 유지). 역할 문법 `역할(이름)` 과 정확 일치 우선을 추가한다.
3. 기본 타임아웃 15000 → 30000(`wait` 는 1000). 상한 600000 은 유지.
4. `retries`·`onFailure` 옵션 삭제. 스텝 재시도 1회 고정(1초 대기)과 `optional` 로 바꾼다. `optional` 은 실행 판정을 바꾸지 않는다.
5. 성공 스텝 뒤 500ms 정착 대기 추가.
6. 스텝 상태 `warning` 추가, 실행 경고 수, CI `failOnWarning` 옵션.
7. 실행 전체 재시도(4.3) 추가.
8. 변수: 정의되지 않은 변수는 실패(`unknown_variable`) 대신 글자 그대로. 치환 범위에 `url`·`expected` 추가.
9. assertText: innerText·공백 정규화·대소문자 무시·폴링·`match`/`caseSensitive` 옵션을 없애고 textContent 한 번 읽기·대소문자 구분 포함으로.
10. assertUrl: 폴링·`match` 모드를 없애고 즉시 한 번 와일드카드 비교로. 기다림은 새 `waitForUrl` 이 맡는다.
11. goto: load → DOMContentLoaded, 4xx/5xx 실패와 `allowHttpError` 삭제.
12. assertResponse: `triggerStepId`·`method`·`status` 옵션과 글롭 매칭, 기본 2xx 를 없앤다. 스텝 시작 후 첫 응답, 부분 포함, 기본 200 정확 일치로.
13. 대화상자: 예약형 `dialog` 대신 클릭+처리+메시지 검증 3종. 예약 없이 뜬 대화상자는 실패 대신 처음 페이지는 자동 확인, 새 창은 자동 취소.
14. 새 창: `switchPage`(현재 페이지 교체, 여러 개면 실패) 대신 2.7 모델과 새 창 액션 6종.
15. iframe: `options.frame` 대신 iframe 액션 3종, `>>>` 중첩.
16. scroll: `x,y` → selector / bottom / top / 세로 픽셀(기본 300).
17. wait: 선택자 대기는 `waitForSelector` 로, wait 는 `timeout` ms(기본 1000). 60000 상한 삭제(타임아웃 상한 600000 만 적용).
18. upload → uploadFile: http(s) URL 목록(여러 파일). 다운로드에는 네트워크 차단·리다이렉트 검사·크기 상한을 적용한다. `attachment:<이름>` 토큰(워크스페이스 첨부, 요청 시 버전 고정)도 받고, 편집기 업로드 버튼은 이 토큰을 넣는다.
19. click 좌표(`position`) 추가.
20. screenshot: 요소 촬영·전체 페이지 → 활성 페이지 뷰포트, `threshold`·`mask` 필드 추가(비교는 단계 7).
21. 새 액션: waitForUrl, assertVisibleOrWarn, assertTitle, assertExists, assertJsonLd, clickFirstEnabled.
22. 자동 스크롤(2.10)과 입력 직전 가림(2.11) 추가.
23. 역할 체인의 정확 일치 변형(2.3), select 의 option 대기·문서 순서 첫 일치(3.1), clickFirstEnabled 의 비역할 셀렉터·조각 규칙(3.1), assertJsonLd 의 공백·null·숫자 문자열화 규칙(3.2), assertResponse 의 처음 페이지 한정(3.2)을 정한다.
24. 변수 이름 규칙(숫자 시작 허용)과 "필수는 저장 때만" 규칙(2.6). 실행 중 빈 값 거부를 없앤다.
25. 저장: 액션이 쓰지 않는 키를 거부하거나 버리지 않고 보존한다(1절). 형식 검사도 하지 않는다.
26. 실행 전체 재시도 총 횟수는 인스턴스 설정(기본 2, 4.3) + 시나리오별 끄기.
27. 편집기: 액션 한국어 라벨·목록 순서(3절), uploadFile 의 Upload·Generate 버튼.
28. 그대로 유지: 네트워크 차단, 비밀 값 가림, 실행 점유·취소·시간 초과, `missing_secret`, 저장 시 검증.
