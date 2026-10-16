// Recorder converter (stage 4 contract section 7, desktop spec chapter 5): raw events collected in the side
// browser's tabs → scenario steps and warnings. A pure function that knows nothing about Electron, so it is
// tested with event fixtures. The app's main process re-runs `convert` on every new event and sends the result
// to the web UI's recording panel; deleting a step there drops its `sourceEventIds` and converts again.
import { LOCALES } from "@defe2end/i18n";
import { stepSchema } from "@defe2end/shared";
import { z } from "zod";
import { convertEvents } from "./convert.js";

export { WARNING_CODES, PASSWORD_VALUE, type WarningCode } from "./convert.js";

/** Where an event happened. `tabId` is the app's id for the tab; popups opened by the start tab get their own. */
const eventBase = {
  /** Unique within a recording; `RecordingResult.sourceEventIds` refers to it. */
  id: z.string().min(1),
  tabId: z.string().min(1),
  /** Epoch milliseconds, from the main process clock. */
  at: z.number().int().min(0),
  /** Main-frame URL of the tab when the event happened. */
  pageUrl: z.string(),
  frame: z.strictObject({
    /** False for the top frame. */
    isSubframe: z.boolean(),
    /** URL of the frame the event came from (equals `pageUrl` in the top frame). */
    url: z.string(),
  }),
};

/** Selector candidates in priority order, already re-ranked by match count (desktop spec 5.2). Never holds a password. */
export const selectorCandidatesSchema = z.array(z.string().min(1));

/** The element an event targets, after climbing to the nearest actionable ancestor. */
export const elementInfoSchema = z.strictObject({
  selectors: selectorCandidatesSchema,
  tagName: z.string(),
  /** `type` attribute of input/button, if any. */
  type: z.string().optional(),
  role: z.string().optional(),
  /** Accessible name or text, whitespace-collapsed, at most 80 characters. */
  text: z.string().optional(),
  placeholder: z.string().optional(),
  /** Inside a `position: fixed/sticky` overlay with z-index ≥ 1000 ("conditional" click). */
  inOverlay: z.boolean().optional(),
});
export type ElementInfo = z.infer<typeof elementInfoSchema>;

export const rawEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...eventBase, type: z.literal("click"), target: elementInfoSchema }),
  /** On `change` or Enter only. `value` is `{{PASSWORD}}` for password fields; the real value never leaves the page. */
  z.strictObject({ ...eventBase, type: z.literal("input"), target: elementInfoSchema, value: z.string(), isPassword: z.boolean() }),
  /** `<select>` change; `label` of the selected option. */
  z.strictObject({ ...eventBase, type: z.literal("select"), target: elementInfoSchema, label: z.string() }),
  /** Enter in an input. `composing` = IME composition in progress (or keyCode 229); ignored by the converter. */
  z.strictObject({ ...eventBase, type: z.literal("key"), key: z.literal("Enter"), target: elementInfoSchema, composing: z.boolean() }),
  /** Main-frame navigation. `afterAction` = caused by the previous click/input/key (else treated as a redirect). */
  z.strictObject({ ...eventBase, type: z.literal("navigate"), url: z.string(), afterAction: z.boolean() }),
  /** A scroll stop (600 ms quiet), top frame only. */
  z.strictObject({ ...eventBase, type: z.literal("scroll"), y: z.number(), atTop: z.boolean(), atBottom: z.boolean() }),
  /** A check the user picked from the recording context menu. */
  z.strictObject({
    ...eventBase,
    type: z.literal("contextmenu"),
    check: z.enum(["assertVisible", "assertVisibleOrWarn", "assertText", "hover"]),
    target: elementInfoSchema,
    /** First 80 characters of the target's text (for `assertText`). */
    text: z.string().optional(),
  }),
  /** alert/confirm/prompt seen by the page wrapper. `accepted` false = dismissed. Prompt values are never recorded. */
  z.strictObject({ ...eventBase, type: z.literal("dialog"), kind: z.enum(["alert", "confirm", "prompt"]), accepted: z.boolean(), /** How long it stayed open: the main process dates the event at its opening (receive time − openMs). */ openMs: z.number().int().min(0).optional() }),
  /** A new window opened by `openerTabId`; `tabId` is the new window's id. */
  z.strictObject({ ...eventBase, type: z.literal("popupOpen"), openerTabId: z.string(), url: z.string() }),
  z.strictObject({ ...eventBase, type: z.literal("popupClose") }),
]);
export type RawEvent = z.infer<typeof rawEventSchema>;
export type RawEventType = RawEvent["type"];

export const recordingDeviceSchema = z.enum(["desktop", "mobile"]);
export type RecordingDevice = z.infer<typeof recordingDeviceSchema>;

export const convertOptionsSchema = z.strictObject({
  /** The tab recording started in; only it and the windows it opened are converted. */
  startTabId: z.string(),
  /** URL of the start tab when recording started. */
  startUrl: z.string(),
  device: recordingDeviceSchema,
  /** `connected.recorder.testAttributes`, in order (selector priority 4). */
  testAttributes: z.array(z.string()),
  /** Language of step names (`recorder.steps` messages); English by default. */
  locale: z.enum(LOCALES).optional(),
});
export type ConvertOptions = z.infer<typeof convertOptionsSchema>;

export const recordingWarningSchema = z.strictObject({
  /** Stable code for the web UI's message catalog. */
  code: z.string(),
  /** Events that caused it, if any. */
  eventIds: z.array(z.string()),
  /** How many events it covers (e.g. events from other tabs). */
  count: z.number().int().min(1).optional(),
});
export type RecordingWarning = z.infer<typeof recordingWarningSchema>;

export const recordingResultSchema = z
  .strictObject({
    /** Every step passes the shared step schema; the converter never emits one that doesn't. */
    steps: z.array(stepSchema),
    /** `sourceEventIds[i]`: raw events that produced `steps[i]` (merged or split steps share them). */
    sourceEventIds: z.array(z.array(z.string())),
    warnings: z.array(recordingWarningSchema),
    /** Origin of the start URL; steps use paths. */
    origin: z.string(),
    eventCount: z.number().int().min(0),
    device: recordingDeviceSchema,
  })
  .refine((r) => r.sourceEventIds.length === r.steps.length, { message: "sourceEventIds must have one entry per step", path: ["sourceEventIds"] });
export type RecordingResult = z.infer<typeof recordingResultSchema>;

/** Converts the whole event list again (desktop spec 5.6), scenario mode only (stage 4 contract section 7). */
export function convert(events: readonly RawEvent[], options: ConvertOptions): RecordingResult {
  return convertEvents(events, options);
}
