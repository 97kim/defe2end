import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { endpointUrl, WRITE_ENDPOINTS } from "./run-endpoints";

const API = fileURLToPath(new URL("../app/api/w/[slug]/", import.meta.url));

it("each flag matches whether its route exists, so a merged endpoint switches its button on", () => {
  for (const [name, e] of Object.entries(WRITE_ENDPOINTS)) {
    const file = `${API}${e.route}/route.ts`;
    const exists = existsSync(file) && new RegExp(`export const ${e.method}\\b`).test(readFileSync(file, "utf8"));
    expect(exists, `${name}: set available to ${exists} in lib/run-endpoints.ts`).toBe(e.available);
  }
});

it("fills route params", () => {
  expect(endpointUrl("acme", "rerunFailed", { groupId: "g 1" })).toBe("/api/w/acme/groups/g%201/rerun-failed");
});
