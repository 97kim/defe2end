// node --test scripts/stamp-version.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseTag, stampVersionsSource } from "./stamp-version.mjs";

test("parses release and rc tags", () => {
  assert.deepEqual(parseTag("v1.0.0"), { version: "1.0.0", minor: "1.0", prerelease: false });
  assert.deepEqual(parseTag("v1.2.3-rc.4"), { version: "1.2.3-rc.4", minor: "1.2", prerelease: true });
});

test("rejects anything else", () => {
  for (const tag of ["1.0.0", "v1.0", "v1.0.0-beta.1", "v1.0.0-rc", "refs/tags/v1.0.0", "", undefined]) {
    assert.throws(() => parseTag(tag), /not a release tag/);
  }
});

test("stamps the four product versions and keeps the step format", () => {
  const source = readFileSync(new URL("../packages/shared/src/version.ts", import.meta.url), "utf8");
  const out = stampVersionsSource(source, "1.2.3-rc.1");
  for (const key of ["server", "desktop", "runner", "mcp"]) assert.match(out, new RegExp(`${key}: "1\\.2\\.3-rc\\.1",`));
  assert.match(out, /stepFormat: 1,/);
});
