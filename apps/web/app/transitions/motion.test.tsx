import { messages } from "@defe2end/i18n";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Dialog, Field, Input, Toasts } from "../../components/ui";
import { TestRunCard } from "../w/[slug]/scenarios/last-test-run";
import { nextChange, PopIn, SwapIn } from "./motion";

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages.en} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );

it("counts value changes; the first render doesn't animate", () => {
  const start = { value: "running", count: 0 };
  expect(nextChange(start, "running")).toBe(start);
  expect(nextChange(start, "passed")).toEqual({ value: "passed", count: 1 });
  expect(render(<SwapIn value="running">Running</SwapIn>)).toBe('<span class="t-text-swap">Running</span>');
  expect(render(<PopIn value={2}>Step 2/5</PopIn>)).toBe('<span class="t-digit-group">Step 2/5</span>');
});

it("puts the transition classes on dialogs, toasts, fields with errors and the test run card", () => {
  expect(render(<Dialog title="Run scenario" onClose={() => {}} />)).toContain('class="t-modal ');
  expect(render(<Toasts toasts={[{ id: 1, tone: "ok", text: "Saved" }]} onDismiss={() => {}} />)).toContain('class="t-toast ');
  expect(render(<Field label="Name" error="Required"><Input /></Field>)).toContain("t-input flex flex-col is-shaking");
  expect(render(<Field label="Name"><Input /></Field>)).not.toContain("is-shaking");
  expect(render(<TestRunCard slug="acme" runId="r1" summary={null} />)).toContain("t-resize");
});
