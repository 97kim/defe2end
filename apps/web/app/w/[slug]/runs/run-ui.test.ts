import { expect, it } from "vitest";
import { formatDuration } from "./run-ui";

it("shows ms under a second, then seconds with one decimal, then minutes", () => {
  expect([0, 40, 999.6, 1000, 48_240, 72_000, 3_780_000].map(formatDuration)).toEqual(["0ms", "40ms", "1.0s", "1.0s", "48.2s", "1m 12s", "1h 3m"]);
});
