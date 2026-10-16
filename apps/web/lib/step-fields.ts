// Step editor field table (docs/action-spec.md section 3). Browser-safe, no React.
// Each action lists exactly the spec's editor fields, in order, after the common
// Action / Step name / Optional fields. Labels are message keys under `scenarios.stepFields.label`; per the spec
// the label doubles as help and fields have no placeholder.

import { STEP_ACTIONS, STEP_FIELDS, type StepAction, type StepField } from "@defe2end/shared";

export type FieldKey = StepField | "timeout";
export type FieldType = "text" | "number" | "coordinates" | "fileUrl";

export type FieldDef = {
  key: FieldKey;
  type: FieldType;
  /** Message key under `scenarios.stepFields.label`. */
  label: string;
  /** `true`, or a condition the spec states ("required when position is missing"). */
  required?: boolean | ((step: StepLike) => boolean);
  /** Hidden unless this holds (click: coordinates only without a selector). */
  visible?: (step: StepLike) => boolean;
};

export type StepLike = {
  action: string;
  selector?: string;
  position?: { x?: number; y?: number };
  [key: string]: unknown;
};

export type EditorAction = StepAction;
/** The editor's action list, in the spec's order (section 3). */
export const EDITOR_ACTIONS: readonly EditorAction[] = [
  "goto", "click", "fill", "select", "pressKey", "waitForSelector", "screenshot", "assertText", "assertVisible",
  "assertVisibleOrWarn", "assertUrl", "waitForUrl", "clickInIframe", "fillInIframe", "assertVisibleInIframe", "wait",
  "clickAndWaitPopup", "clickInPopup", "fillInPopup", "closePopup", "assertResponse", "assertPopupUrl",
  "assertVisibleInPopup", "hover", "clickFirstEnabled", "scroll", "clickAndAcceptDialog", "clickAndDismissDialog",
  "clickAndSubmitPrompt", "uploadFile", "assertExists", "assertCount", "assertJsonLd", "assertTitle",
];
/** New steps start as `goto` (spec section 3). */
export const DEFAULT_ACTION: EditorAction = "goto";

const blank = (v: unknown) => v === undefined || v === null || v === "";
const hasPosition = (s: StepLike) => !blank(s.position?.x) || !blank(s.position?.y);

/** Field defaults; `FIELD_OVERRIDES` changes label or rules per action (spec section 3 tables). */
const FIELD_DEFAULTS: Record<StepField, Omit<FieldDef, "key">> = {
  url: { type: "text", label: "url", required: true },
  selector: { type: "text", label: "selector", required: true },
  value: { type: "text", label: "value" },
  expected: { type: "text", label: "expected", required: true },
  position: { type: "coordinates", label: "position" },
  threshold: { type: "number", label: "threshold" },
  mask: { type: "text", label: "mask" },
};

const iframe: Partial<Record<StepField, Partial<FieldDef>>> = {
  selector: { label: "iframeSelector" },
  value: { label: "innerSelector", required: true },
};
const dialogMessage: Partial<FieldDef> = { label: "dialogMessage", required: false };

const FIELD_OVERRIDES: Partial<Record<StepAction, Partial<Record<StepField, Partial<FieldDef>>>>> = {
  click: {
    selector: { required: (s) => !hasPosition(s) },
    position: { required: (s) => blank(s.selector), visible: (s) => blank(s.selector) || hasPosition(s) },
  },
  select: { value: { required: true } },
  pressKey: { selector: { label: "pressKeySelector", required: false }, value: { label: "key", required: true } },
  scroll: { selector: { label: "scrollSelector", required: false }, value: { label: "scrollValue" } },
  uploadFile: { selector: { label: "fileInput" }, value: { type: "fileUrl", label: "fileUrl", required: true } },
  clickFirstEnabled: { expected: { label: "activeCss", required: false } },
  waitForUrl: { expected: { label: "urlPattern" } },
  assertVisibleOrWarn: { expected: { label: "warningMessage", required: false } },
  assertTitle: { expected: { label: "expectedTitle" } },
  assertCount: { expected: { label: "expectedCount" } },
  assertExists: { selector: { label: "existsSelector" } },
  assertJsonLd: { selector: { label: "ldSelector", required: false }, expected: { label: "jsonLdCondition" } },
  assertResponse: { expected: { label: "apiPattern" }, value: { label: "expectedStatus" } },
  clickAndWaitPopup: { selector: { label: "popupTrigger" } },
  clickInIframe: iframe,
  fillInIframe: { ...iframe, expected: { label: "textToEnter", required: false } },
  assertVisibleInIframe: iframe,
  clickAndAcceptDialog: { expected: dialogMessage },
  clickAndDismissDialog: { expected: dialogMessage },
  clickAndSubmitPrompt: { value: { label: "promptText", required: true }, expected: dialogMessage },
};

/** Actions whose editor shows a timeout field (spec section 3), with the label where it differs. */
const TIMEOUT_FIELD: Partial<Record<StepAction, Partial<FieldDef>>> = {
  wait: {},
  clickFirstEnabled: {},
  waitForSelector: {},
  waitForUrl: {},
  assertVisibleOrWarn: { label: "warnTimeout" },
  assertResponse: {},
  clickAndWaitPopup: {},
  clickInPopup: {},
  fillInPopup: {},
  assertVisibleInPopup: {},
  clickInIframe: {},
  fillInIframe: {},
  assertVisibleInIframe: {},
  clickAndAcceptDialog: {},
  clickAndDismissDialog: {},
  clickAndSubmitPrompt: {},
};

/** Each action's editor fields: the shared schema's keys (`STEP_FIELDS`, in order), then the timeout where shown. */
export const ACTION_FIELDS = Object.fromEntries(
  STEP_ACTIONS.map((action) => {
    const fields: FieldDef[] = STEP_FIELDS[action].map((key) => ({ key, ...FIELD_DEFAULTS[key], ...FIELD_OVERRIDES[action]?.[key] }));
    const timeout = TIMEOUT_FIELD[action];
    if (timeout) fields.push({ key: "timeout", type: "number", label: "timeout", ...timeout });
    return [action, fields];
  }),
) as Record<EditorAction, FieldDef[]>;

/** Message key shown instead of fields for actions without inputs. */
export const NO_INPUT_NOTE: Partial<Record<EditorAction, string>> = { closePopup: "closePopup" };


export function fieldsFor(step: StepLike): FieldDef[] {
  return (ACTION_FIELDS[step.action as EditorAction] ?? []).filter((f) => !f.visible || f.visible(step));
}

export function isRequired(field: FieldDef, step: StepLike): boolean {
  return typeof field.required === "function" ? field.required(step) : field.required === true;
}

/** Every key the step format knows: saving keeps them all, even those the action doesn't use (spec section 1). */
const STEP_KEYS = new Set<string>(["id", "action", "name", "optional", "timeout", "url", "selector", "value", "expected", "position", "threshold", "mask"]);

/**
 * Drops empty values (and editor-only keys) so the saved step matches the schema's shape. Values of keys the
 * current action doesn't use are kept: switching fill → click → fill keeps the text (spec section 1).
 */
export function pruneStep<T extends StepLike>(step: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step)) {
    if (!STEP_KEYS.has(k)) continue;
    // fillInIframe needs `expected` present even when empty (spec 3.4).
    if (blank(v) && !(k === "expected" && step.action === "fillInIframe" && v === "")) continue;
    if (k === "optional" && v === false) continue;
    if (k === "position") {
      const p = v as { x?: number; y?: number };
      if (blank(p.x) && blank(p.y)) continue;
    }
    out[k] = v;
  }
  return out as T;
}

type Issue = { path: readonly PropertyKey[]; message: string };

/**
 * Groups schema issues of a step list by step index and field key. `position.x` folds into `position`;
 * issues on the step itself land under `_step`.
 */
export function issuesByField(issues: readonly Issue[]): Map<number, Record<string, string>> {
  const out = new Map<number, Record<string, string>>();
  for (const issue of issues) {
    const [index, key] = issue.path;
    if (typeof index !== "number") continue;
    const field = typeof key === "string" ? key : "_step";
    const forStep = out.get(index) ?? {};
    forStep[field] ??= issue.message;
    out.set(index, forStep);
  }
  return out;
}
