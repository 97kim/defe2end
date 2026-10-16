import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Toggle } from "./ui";

it("keeps the knob inside the track's 2px padding, on and off", () => {
  const on = renderToStaticMarkup(<Toggle checked onChange={() => {}} label="Secret" />);
  const off = renderToStaticMarkup(<Toggle checked={false} onChange={() => {}} label="Secret" />);
  expect(on).toContain('aria-checked="true"');
  expect(on).toMatch(/h-5 w-9 [^"]*p-\[2px\]/);
  expect(on).toContain("size-4");
  expect(on).toContain("translate-x-4");
  expect(off).toContain("translate-x-0");
  expect(off).toContain("bg-border-strong");
  expect(renderToStaticMarkup(<Toggle checked onChange={() => {}} label="x" disabled />)).toContain("cursor-not-allowed opacity-40");
});
