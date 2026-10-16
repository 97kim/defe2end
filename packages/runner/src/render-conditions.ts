// Rendering conditions recorded with every baseline and capture (stage 7 contract section 1). A capture whose
// conditions differ from its baseline's is `incomparable`, not a regression.
import { release } from "node:os";
import type { Page } from "playwright";

export type RunRuntime = "server" | "desktop-mac" | "desktop-windows";

export interface RenderConditions {
  browserVersion: string;
  deviceScaleFactor: number;
  viewport: { width: number; height: number };
  /** Which installed fonts the page could draw with; see `fontSetId`. */
  fontSet: string;
  maskPolicyVersion: number | string;
}

/** Where a run executes. The desktop app runs on macOS and Windows only. */
export function detectRuntime(opts: { desktop: boolean; platform?: NodeJS.Platform }): RunRuntime {
  if (!opts.desktop) return "server";
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") return "desktop-mac";
  if (platform === "win32") return "desktop-windows";
  throw new Error(`The desktop app doesn't run on ${platform}`);
}

/**
 * A stable name for the font set a run can use: the runtime plus the OS major release (macOS ships fonts
 * with major versions; Windows with its build). The server's fonts come from its container image, so
 * `server` relies on the image and an optional `imageFonts` label the deployment sets when it changes them.
 */
export function fontSetId(opts: { runtime: RunRuntime; platform?: NodeJS.Platform; osRelease?: string; imageFonts?: string }): string {
  const platform = opts.platform ?? process.platform;
  const rel = opts.osRelease ?? release();
  if (opts.runtime === "server") return `server/${platform}${opts.imageFonts ? `/${opts.imageFonts}` : ""}`;
  if (platform === "darwin") return `${opts.runtime}/darwin-${rel.split(".")[0]}`;
  if (platform === "win32") return `${opts.runtime}/windows-${rel.split(".").slice(0, 3).join(".")}`;
  return `${opts.runtime}/${platform}`;
}

/** Reads the conditions from the page about to be captured. */
export async function collectRenderConditions(
  page: Page,
  opts: { runtime: RunRuntime; maskPolicyVersion: number | string; browserVersion?: string; imageFonts?: string },
): Promise<RenderConditions> {
  const measured = await page.evaluate(() => ({ dpr: window.devicePixelRatio, width: window.innerWidth, height: window.innerHeight }));
  const size = page.viewportSize() ?? { width: measured.width, height: measured.height };
  const browserVersion = opts.browserVersion ?? page.context().browser()?.version() ?? "unknown";
  return {
    browserVersion,
    deviceScaleFactor: measured.dpr,
    viewport: { width: size.width, height: size.height },
    fontSet: fontSetId({ runtime: opts.runtime, ...(opts.imageFonts ? { imageFonts: opts.imageFonts } : {}) }),
    maskPolicyVersion: opts.maskPolicyVersion,
  };
}

/** Which conditions differ, in a fixed order, for the `incomparable` reason. Empty when they all match. */
export function renderConditionDiff(baseline: RenderConditions, current: RenderConditions): (keyof RenderConditions)[] {
  const out: (keyof RenderConditions)[] = [];
  if (baseline.browserVersion !== current.browserVersion) out.push("browserVersion");
  if (baseline.deviceScaleFactor !== current.deviceScaleFactor) out.push("deviceScaleFactor");
  if (baseline.viewport.width !== current.viewport.width || baseline.viewport.height !== current.viewport.height) out.push("viewport");
  if (baseline.fontSet !== current.fontSet) out.push("fontSet");
  if (baseline.maskPolicyVersion !== current.maskPolicyVersion) out.push("maskPolicyVersion");
  return out;
}
