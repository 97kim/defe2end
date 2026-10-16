import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { neighbors } from "./[id]/scenario-detail-view";
import { RecentRuns } from "./scenarios-view";

it("previous / next follow the list's last order; unknown scenarios get neither", () => {
  const order = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
  expect(neighbors(order, "b")).toEqual({ previous: { id: "a", name: "A" }, next: { id: "c", name: "C" } });
  expect(neighbors(order, "a")).toEqual({ previous: null, next: { id: "b", name: "B" } });
  expect(neighbors(order, "z")).toEqual({ previous: null, next: null });
});

it("the mini history shows 10 slots, newest right, each run labelled", () => {
  const html = renderToStaticMarkup(
    <RecentRuns runs={[{ id: "r1", status: "passed", queuedAt: "" }, { id: "r2", status: "failed", queuedAt: "" }]} label={(s) => s.toUpperCase()} />,
  );
  expect(html.match(/<span/g)!.length - 1).toBe(10);
  expect(html).toContain('aria-label="PASSED, FAILED"');
  expect(html.indexOf('title="PASSED"')).toBeLessThan(html.indexOf('title="FAILED"'));
});
