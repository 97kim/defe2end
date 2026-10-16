import { expect, it } from "vitest";
import { VERSIONS } from "@defe2end/shared";
import { MCP_VERSION } from "./version.js";

it("reports the shared mcp version", () => {
  expect(MCP_VERSION).toBe(VERSIONS.mcp);
});
