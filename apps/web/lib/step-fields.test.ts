import { messages } from "@defe2end/i18n";
import { STEP_FIELDS, stepSchema } from "@defe2end/shared";
import { describe, expect, it } from "vitest";
import { ACTION_FIELDS, EDITOR_ACTIONS, fieldsFor, isRequired, issuesByField, NO_INPUT_NOTE, pruneStep } from "./step-fields";

const SPEC_KEYS = new Set(["url", "selector", "value", "expected", "timeout", "position", "threshold", "mask"]);

describe("step field table", () => {
  it("lists the spec's 34 actions once, in the spec's order with its Korean labels", () => {
    expect(EDITOR_ACTIONS).toHaveLength(34);
    expect(new Set(EDITOR_ACTIONS).size).toBe(34);
    expect(EDITOR_ACTIONS.slice(0, 6)).toEqual(["goto", "click", "fill", "select", "pressKey", "waitForSelector"]);
    expect(EDITOR_ACTIONS.slice(-4)).toEqual(["assertExists", "assertCount", "assertJsonLd", "assertTitle"]);
    expect(Object.keys(messages.ko.scenarios.actions)).toEqual([...EDITOR_ACTIONS]);
    const ko = messages.ko.scenarios.actions as Record<string, string>;
    expect([ko.goto, ko.assertVisibleOrWarn, ko.clickAndSubmitPrompt, ko.assertJsonLd]).toEqual(["페이지 이동", "요소 표시 확인(없으면 경고)", "클릭 후 prompt 입력", "구조화 데이터(ld+json) 확인"]);
    expect(Object.keys(ACTION_FIELDS).sort()).toEqual([...EDITOR_ACTIONS].sort());
  });

  it("uses only spec keys, each at most once per action", () => {
    for (const [action, fields] of Object.entries(ACTION_FIELDS)) {
      for (const f of fields) expect(SPEC_KEYS.has(f.key), `${action}.${f.key}`).toBe(true);
      expect(new Set(fields.map((f) => f.key)).size, action).toBe(fields.length);
    }
  });

  it("has a label and note string in every locale", () => {
    for (const locale of ["en", "ko"] as const) {
      const m = messages[locale].scenarios as any;
      for (const action of EDITOR_ACTIONS) {
        expect(m.actions[action], `${locale} actions.${action}`).toBeTruthy();
        for (const f of ACTION_FIELDS[action]) {
          expect(m.stepFields.label[f.label], `${locale} label.${f.label}`).toBeTruthy();
        }
      }
      for (const note of Object.values(NO_INPUT_NOTE)) expect(m.stepFields.note[note!]).toBeTruthy();
    }
  });

  it("matches spot checks from spec section 3", () => {
    const keys = (action: string) => ACTION_FIELDS[action as keyof typeof ACTION_FIELDS].map((f) => f.key);
    expect(keys("goto")).toEqual(["url"]);
    expect(keys("wait")).toEqual(["timeout"]);
    expect(keys("assertVisible")).toEqual(["selector"]);
    expect(keys("screenshot")).toEqual(["threshold", "mask"]);
    expect(keys("closePopup")).toEqual([]);
    expect(keys("fillInIframe")).toEqual(["selector", "value", "expected", "timeout"]);
    expect(keys("clickAndSubmitPrompt")).toEqual(["selector", "value", "expected", "timeout"]);
    expect(keys("assertResponse")).toEqual(["expected", "value", "timeout"]);
  });

  it("shows exactly the shared schema's keys, plus timeout where the spec's editor has it", () => {
    for (const action of EDITOR_ACTIONS) {
      expect(ACTION_FIELDS[action].map((f) => f.key).filter((k) => k !== "timeout"), action).toEqual([...STEP_FIELDS[action]]);
    }
  });

  it("every action's required fields are the ones the schema rejects when empty, and a filled step saves", () => {
    for (const action of EDITOR_ACTIONS) {
      const empty = { id: "s1", action };
      const required = fieldsFor(empty).filter((f) => isRequired(f, empty)).map((f) => f.key);
      const rejected = issuesByField(stepsIssues([empty])).get(0) ?? {};
      for (const key of required) {
        // click reports its selector-or-position rule on the selector.
        if (action === "click" && key === "position") continue;
        expect(rejected[key], `${action}.${key}`).toBeTruthy();
      }
      const filled: Record<string, unknown> = { id: "s1", action };
      for (const f of ACTION_FIELDS[action]) {
        if (f.key === "position") continue;
        filled[f.key] = sample(action, f.key);
      }
      const parsed = stepSchema.safeParse(pruneStep(filled as never));
      expect(parsed.success ? [] : parsed.error.issues.map((i) => `${String(i.path)} ${i.message}`), action).toEqual([]);
    }
  });

  it("click needs a selector or coordinates, and shows coordinates only without a selector", () => {
    const empty = { action: "click" };
    expect(fieldsFor(empty).map((f) => f.key)).toEqual(["selector", "position"]);
    expect(fieldsFor(empty).every((f) => isRequired(f, empty))).toBe(true);
    const withSelector = { action: "click", selector: "button(Buy)" };
    expect(fieldsFor(withSelector).map((f) => f.key)).toEqual(["selector"]);
    const withPosition = { action: "click", position: { x: 10, y: 20 } };
    const [selector] = fieldsFor(withPosition);
    expect(isRequired(selector!, withPosition)).toBe(false);
  });

  it("keeps keys the action doesn't use, drops empty values and editor-only keys when saving", () => {
    expect(pruneStep({ id: "a", action: "goto", url: "/", selector: "x", value: "", optional: false })).toEqual({ id: "a", action: "goto", url: "/", selector: "x" });
    expect(pruneStep({ id: "a", action: "goto", url: "/", draftKey: 1 } as never)).toEqual({ id: "a", action: "goto", url: "/" });
    expect(pruneStep({ id: "a", action: "click", position: { x: undefined, y: undefined }, selector: "b", optional: true })).toEqual({ id: "a", action: "click", selector: "b", optional: true });
  });

  it("fill → click → save → fill keeps the text (spec section 1)", () => {
    const fill = { id: "a", action: "fill", selector: "#q", value: "hello" };
    const asClick = stepSchema.parse(pruneStep({ ...fill, action: "click" }));
    expect(asClick).toEqual({ id: "a", action: "click", selector: "#q", value: "hello" });
    const back = stepSchema.parse(pruneStep({ ...asClick, action: "fill" }));
    expect(back).toEqual(fill);
  });

  it("groups schema issues by step and field", () => {
    const map = issuesByField([
      { path: [0, "url"], message: "URL is required" },
      { path: [0, "url"], message: "second" },
      { path: [2, "position", "x"], message: "bad x" },
      { path: [3], message: "step" },
    ]);
    expect(map.get(0)).toEqual({ url: "URL is required" });
    expect(map.get(2)).toEqual({ position: "bad x" });
    expect(map.get(3)).toEqual({ _step: "step" });
  });
});

function stepsIssues(steps: unknown[]) {
  return steps.flatMap((step, index) => {
    const parsed = stepSchema.safeParse(step);
    return parsed.success ? [] : parsed.error.issues.map((i) => ({ path: [index, ...i.path], message: i.message }));
  });
}

function sample(action: string, key: string): unknown {
  if (key === "timeout") return 5000;
  if (key === "threshold") return 5;
  if (key === "url") return "/products";
  if (key === "selector") return action.endsWith("Iframe") ? "iframe#pay" : "button(Buy)";
  if (key === "value") return ({ uploadFile: "https://example.com/a.png", assertResponse: "201", pressKey: "Enter", scroll: "bottom" } as Record<string, string>)[action] ?? "text";
  if (key === "expected") return ({ assertCount: "2", assertJsonLd: "@type=Product", waitForUrl: "*/done", clickFirstEnabled: "color:#000000" } as Record<string, string>)[action] ?? "ok";
  return "x";
}

describe("editor texts render through next-intl", () => {
  it("every action's labels and notes format without errors, verbatim, in both locales", async () => {
    const { createTranslator } = await import("next-intl");
    for (const locale of ["en", "ko"] as const) {
      const errors: string[] = [];
      const t = createTranslator({ locale, messages: messages[locale] as never, namespace: "scenarios" as never, onError: (e) => void errors.push(e.message) }) as unknown as (key: string) => string;
      const sf = (messages[locale].scenarios as any).stepFields;
      const keys = [
        ...EDITOR_ACTIONS.map((a) => `actions.${a}`),
        ...Object.keys(sf).filter((k) => typeof sf[k] === "string").map((k) => `stepFields.${k}`),
        ...["label", "note"].flatMap((group) => Object.keys(sf[group]).map((k) => `stepFields.${group}.${k}`)),
      ];
      for (const key of keys) {
        const text = t(key);
        expect(text, `${locale}:${key}`).not.toContain("scenarios.");
        if (key.startsWith("stepFields.label.")) expect(text, `${locale}:${key}`).toBe(sf.label[key.slice("stepFields.label.".length)]);
      }
      expect(errors, locale).toEqual([]);
    }
  });
});

// Transcribed from docs/action-spec.md section 3: [en, ko] label per field. The label doubles as help and
// fields have no placeholder, so labels are all the editor shows for a field.
const D = { url: ["URL", "URL"], selector: ["Selector", "셀렉터"], value: ["Value", "값"], expected: ["Expected", "기대값"], timeout: ["Timeout (ms)", "타임아웃 (ms)"] } as const;
const IFRAME = { selector: ["iframe selector", "iframe 셀렉터"], value: ["Inner element selector", "내부 요소 셀렉터"], timeout: D.timeout } as const;
const DIALOG = { selector: D.selector, expected: ["Expected message (contains, optional)", "기대값"], timeout: D.timeout } as const;
const SPEC_LABELS: Record<string, Record<string, readonly [string, string]>> = {
  goto: { url: D.url },
  click: { selector: D.selector, position: ["X / Y", "X / Y"] },
  fill: { selector: D.selector, value: D.value },
  select: { selector: D.selector, value: D.value },
  pressKey: {
    selector: ["Selector (optional) — focus this element first; empty = current focus", "셀렉터 (선택) — 주면 이 요소에 포커스를 준 뒤 입력, 비우면 현재 포커스"],
    value: ["Key (required) — Enter, Escape, Tab, ArrowDown, …", "키 이름 (필수) — Enter, Escape, Tab, ArrowDown 등 Playwright 키 이름"],
  },
  hover: { selector: D.selector },
  scroll: {
    selector: ["Selector (scroll to element; wins over value)", "셀렉터 (요소까지 스크롤, 입력 시 값보다 우선)"],
    value: ["Value (pixels / bottom / top, default 300)", "값 (픽셀 / bottom / top, 기본 300)"],
  },
  wait: { timeout: D.timeout },
  uploadFile: {
    selector: ["File input selector", "파일 input 셀렉터"],
    value: ["File URL (type it or use the upload button)", "파일 URL (직접 입력 또는 옆 버튼으로 업로드)"],
  },
  clickFirstEnabled: { selector: D.selector, expected: ["Active CSS condition", "활성 CSS 조건"], timeout: D.timeout },
  waitForSelector: { selector: D.selector, timeout: D.timeout },
  waitForUrl: { expected: ["URL pattern", "기대값"], timeout: D.timeout },
  assertVisible: { selector: D.selector },
  assertVisibleOrWarn: {
    selector: D.selector,
    expected: ["Warning message (shown in results and notifications, optional)", "경고 메시지 (없을 때 기록·알림에 표시, 선택)"],
    timeout: ["Wait time (ms, default 30000) — warn if not visible by then", "대기 시간 (ms, 기본 30000) — 이 시간 안에 없으면 경고"],
  },
  assertText: { selector: D.selector, expected: D.expected },
  assertUrl: { expected: D.expected },
  assertTitle: { expected: ["Expected title (* wildcard)", "기대 제목 (* 와일드카드)"] },
  assertCount: { selector: D.selector, expected: ["Expected count (0 = must not exist)", "기대 개수 (0 = 없어야 함)"] },
  assertExists: { selector: ["Selector (passes if in the DOM, even when hidden)", "셀렉터 (보이지 않아도 DOM 에 있으면 통과)"] },
  assertJsonLd: { selector: ["ld+json selector (empty = default)", "ld+json 셀렉터 (비우면 기본)"], expected: ["Condition (e.g. @type=Product)", "조건식 (예: @type=Product)"] },
  assertResponse: { expected: ["API URL pattern", "API URL 패턴"], value: ["Expected status (default 200)", "기대 상태코드 (기본 200)"], timeout: D.timeout },
  screenshot: {
    threshold: ["Allowed change (%, default 5) — warn when it changes more than this from the baseline", "허용 변경률 (%, 기본 5) — 기준 대비 이보다 크게 바뀌면 경고"],
    mask: ["Extra mask selectors (comma/newline separated, optional)", "추가 마스킹 셀렉터 (콤마/개행 구분, 선택)"],
  },
  clickAndWaitPopup: { selector: ["Selector to click (waits for a new window at the same time)", "클릭할 셀렉터 (클릭과 동시에 새 창 대기)"], timeout: D.timeout },
  clickInPopup: { selector: D.selector, timeout: D.timeout },
  fillInPopup: { selector: D.selector, value: D.value, timeout: D.timeout },
  assertVisibleInPopup: { selector: D.selector, timeout: D.timeout },
  assertPopupUrl: { expected: D.expected },
  closePopup: {},
  clickInIframe: IFRAME,
  fillInIframe: { selector: IFRAME.selector, value: IFRAME.value, expected: ["Text to enter", "입력값"], timeout: D.timeout },
  assertVisibleInIframe: IFRAME,
  clickAndAcceptDialog: DIALOG,
  clickAndDismissDialog: DIALOG,
  clickAndSubmitPrompt: { selector: D.selector, value: ["Prompt text", "값"], expected: DIALOG.expected, timeout: D.timeout },
};

describe("editor strings match the spec verbatim", () => {
  const sf = (locale: "en" | "ko") => (messages[locale].scenarios as any).stepFields;

  it("labels every action's fields with the spec's English and Korean label", () => {
    expect(Object.keys(SPEC_LABELS).sort()).toEqual([...EDITOR_ACTIONS].sort());
    for (const action of EDITOR_ACTIONS) {
      for (const [i, locale] of (["en", "ko"] as const).entries()) {
        const shown = Object.fromEntries(ACTION_FIELDS[action].map((f) => [f.key, sf(locale).label[f.label]]));
        const spec = Object.fromEntries(Object.entries(SPEC_LABELS[action]!).map(([k, v]) => [k, v[i]]));
        expect(shown, `${locale} ${action}`).toEqual(spec);
      }
    }
  });

  it("has no field help or placeholder besides the spec's", () => {
    for (const locale of ["en", "ko"] as const) expect(sf(locale).help, locale).toBeUndefined();
    for (const fields of Object.values(ACTION_FIELDS)) for (const f of fields) expect(Object.keys(f).sort()).not.toContain("placeholder");
  });

  it("uses the spec's common, coordinate, upload and note strings", () => {
    const pick = (locale: "en" | "ko") => {
      const m = sf(locale);
      return [m.label.name, m.label.optional, (messages[locale].scenarios as any).editor.action, m.label.positionX, m.label.positionY, m.upload, m.uploadTitle, m.generate, m.generateTooltip, m.generateTitle, m.width, m.height, m.generateHelp, m.note.noInputs, m.note.closePopup];
    };
    expect(pick("ko")).toEqual([
      "스텝 이름 (선택)", "선택적 실행 (실패해도 다음 스텝 진행)", "액션", "X 좌표", "Y 좌표", "업로드", "이미지 업로드", "생성", "테스트 이미지 생성", "테스트 이미지 크기", "가로", "세로",
      "1~4096 사이의 정수. 검은 배경에 크기를 적은 PNG 를 만들어 업로드합니다.", "이 액션은 입력값이 필요 없습니다.", "현재 열린 새 창을 닫습니다.",
    ]);
    expect(sf("ko").label.namePlaceholder).toBe("스텝 설명");
    const en = pick("en");
    expect([en[0], en[1], en[2], en[5], en[7], en[10], en[11], en[12], en[13], en[14]]).toEqual([
      "Step name (optional)", "Optional step — continue if it fails", "Action", "Upload", "Generate", "Width", "Height",
      "Integer from 1 to 4096. Creates and uploads a PNG with the size written on a black background.", "This action has no inputs.", "Closes the current new window.",
    ]);
  });
});
