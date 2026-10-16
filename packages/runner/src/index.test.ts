import { expect, it } from "vitest";
import { VERSIONS } from "@defe2end/shared";
import { RUNNER_VERSION } from "./index.js";

it("reports the shared runner version", () => {
  expect(RUNNER_VERSION).toBe(VERSIONS.runner);
});
