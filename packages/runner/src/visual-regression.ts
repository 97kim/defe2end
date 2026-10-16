// Visual regression of a passed screenshot step (stage 7 contract section 4): the capture is judged against the
// baseline version pinned for the run. A missing baseline makes this capture the first one (`created`); other
// render conditions make it `incomparable`; an unreadable baseline or a failed comparison is `skipped`. None of
// them breaks the run.
import { renderConditionDiff, VISUAL_COMPARE, type RenderConditions, type StepOutcome, type VisualRuntime } from "@defe2end/shared";
import { compareImages } from "@defe2end/shared/server";

/** A baseline version the run is pinned to, as the runner needs it. */
export interface PinnedBaseline {
  versionId: string;
  width: number;
  height: number;
  render: RenderConditions;
}

/** How the caller (worker or desktop app) gives the runner its pinned baselines. */
export interface VisualRegressionOptions {
  runtime: VisualRuntime;
  /** The pinned version for a screenshot step, or `undefined` when the key had no baseline (→ `created`). */
  baselineFor(stepId: string): PinnedBaseline | undefined;
  /** The baseline image; a rejection makes the verdict `skipped`. */
  readBaseline(versionId: string): Promise<Uint8Array>;
  /** Font set label of the server image (`fontSetId`). */
  imageFonts?: string;
}

export type VisualFields = Pick<StepOutcome, "visualVerdict" | "visualDiffPercent" | "visualShiftDiffPercent" | "visualShift" | "visualBaselineVersionId" | "render">;

export interface VisualJudgement {
  fields: VisualFields;
  diffPng?: Uint8Array;
  /** Set for `changed` and `size_mismatch`: the step becomes a warning with this message. */
  warning?: string;
}

const APPROVE_HINT = "If the change is intended, approve it as the new baseline on the run details page.";

const CONDITION_NAMES: Record<keyof RenderConditions, string> = {
  browserVersion: "browser version",
  deviceScaleFactor: "device scale factor",
  viewport: "viewport",
  fontSet: "font set",
  maskingPolicyVersion: "masking policy",
};

/** Percent for messages only; the verdict uses the raw value. */
export function displayPercent(value: number): string {
  if (value === 0) return "0%";
  if (value < 0.01) return "<0.01%";
  return `${value.toFixed(2).replace(/\.?0+$/, "")}%`;
}

export async function judgeScreenshot(input: {
  png: Uint8Array;
  render: RenderConditions;
  pinned: PinnedBaseline | undefined;
  readBaseline(versionId: string): Promise<Uint8Array>;
  /** Step `threshold`, percent. */
  tolerance?: number;
}): Promise<VisualJudgement> {
  const { render, pinned } = input;
  if (!pinned) return { fields: { visualVerdict: "created", render } };
  const base = { visualBaselineVersionId: pinned.versionId, render };
  const differs = renderConditionDiff(pinned.render, render);
  if (differs.length > 0) {
    return { fields: { ...base, visualVerdict: "incomparable" } };
  }
  let baseline: Uint8Array;
  try {
    baseline = await input.readBaseline(pinned.versionId);
  } catch {
    return { fields: { ...base, visualVerdict: "skipped" } };
  }
  try {
    const result = await compareImages(baseline, input.png, { mode: "regression", tolerance: input.tolerance ?? VISUAL_COMPARE.defaultTolerancePercent });
    const fields: VisualFields = { ...base, visualVerdict: result.verdict, visualDiffPercent: result.diffPercent };
    if (result.shiftDiffPercent !== undefined) fields.visualShiftDiffPercent = result.shiftDiffPercent;
    if (result.shift) fields.visualShift = result.shift;
    const out: VisualJudgement = { fields };
    if (result.diffPng) out.diffPng = result.diffPng;
    if (result.verdict === "changed") {
      const shifted = result.shiftDiffPercent === undefined ? "" : ` (${displayPercent(result.shiftDiffPercent)} after the shift search)`;
      out.warning = `The screenshot differs from the baseline by ${displayPercent(result.diffPercent)}${shifted}. ${APPROVE_HINT}`;
    } else if (result.verdict === "size_mismatch") {
      out.warning = `The screenshot is ${result.bSize.width}×${result.bSize.height}, the baseline ${result.aSize.width}×${result.aSize.height}. ${APPROVE_HINT}`;
    }
    return out;
  } catch {
    return { fields: { ...base, visualVerdict: "skipped" } };
  }
}

/** The reason shown with `incomparable`: which render conditions differ. */
export function incomparableReason(baseline: RenderConditions, current: RenderConditions): string {
  return renderConditionDiff(baseline, current).map((k) => CONDITION_NAMES[k]).join(", ");
}
