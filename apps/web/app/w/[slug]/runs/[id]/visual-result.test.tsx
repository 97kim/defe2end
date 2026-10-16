import { messages } from "@defe2end/i18n";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import type { StepVisualView } from "../../../../../lib/run-read";
import { VisualApproveContext, VisualDetail, VisualWarningText } from "./visual-result";

const visual = (over: Partial<StepVisualView> = {}): StepVisualView => ({
  stepResultId: "sr1", verdict: "changed", diffPercent: 95.7412, shiftDiffPercent: 95.6901, shift: { x: 0, y: 1 },
  baseline: { version: 1, currentVersion: 1, url: "/b.png", width: 1280, height: 720 }, differs: [], approvable: true, ...over,
});
const render = (node: React.ReactNode, locale: "en" | "ko") =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages[locale]} timeZone="UTC">
      <VisualApproveContext.Provider value={{ slug: "acme", runId: "r1", canApprove: true }}>{node}</VisualApproveContext.Provider>
    </NextIntlClientProvider>,
  );

it("words the visual warning from the verdict and its values, in the reader's language", () => {
  expect(render(<VisualWarningText visual={visual()} />, "ko")).toBe("스크린샷이 기준과 95.74% 달라요(이동 보정 뒤 95.69%). 의도한 변경이면 새 기준으로 승인하세요.");
  expect(render(<VisualWarningText visual={visual({ shiftDiffPercent: null, shift: null })} />, "en")).toBe("The screenshot differs from the baseline by 95.74%. If the change is intended, approve it as the new baseline.");
  expect(render(<VisualWarningText visual={visual({ verdict: "size_mismatch", diffPercent: 100, shiftDiffPercent: null })} />, "ko")).toBe("스크린샷 크기가 기준(1280×720)과 달라요. 의도한 변경이면 새 기준으로 승인하세요.");
  expect(render(<VisualWarningText visual={visual({ verdict: "match" })} />, "ko")).toBe("");
});

it("shows whole captures side by side (fitted, not cropped) and the approve button", () => {
  const html = render(<VisualDetail visual={visual()} shot={{ id: "a", kind: "screenshot", stepIndex: 1, attempt: 1, name: "s", sizeBytes: 1, url: "/s.png" }} diff={undefined} />, "ko");
  expect(html).toContain('src="/b.png"');
  expect(html).toContain("object-contain");
  expect(html).not.toContain("object-cover");
  expect(html).toContain("새 기준으로 승인");
});
