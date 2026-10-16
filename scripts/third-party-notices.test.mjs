// node --test scripts/third-party-notices.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildNotices, mergedSbom, parseExtra } from "./third-party-notices.mjs";

function tree() {
  const root = mkdtempSync(join(tmpdir(), "notices-"));
  for (const [dir, file, body] of [
    ["app/node_modules/a", "LICENSE", "MIT text\nCopyright A"],
    ["app/node_modules/b", "LICENSE.md", "MIT text\nCopyright A"],
    ["usr/share/doc/libx", "copyright", "LGPL text"],
    ["bundle", "LICENSE", "bundled text"],
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, file), body);
    writeFileSync(join(root, dir, "package.json"), "{}");
  }
  return root;
}

const npm = (name, path, id) => ({ name, version: "1.0.0", purl: `pkg:npm/${name}@1.0.0`, licenses: [{ license: { id } }], properties: [{ name: "syft:location:0:path", value: path }] });

test("collects texts verbatim, once per distinct text, and lists source offers", () => {
  const root = tree();
  const sbom = {
    bomFormat: "CycloneDX",
    components: [
      npm("a", "/app/node_modules/a/package.json", "MIT"),
      npm("b", "/app/node_modules/b/package.json", "MIT"),
      { type: "operating-system", name: "debian", version: "12" },
      { name: "libx", version: "2", purl: "pkg:deb/debian/libx@2", licenses: [{ license: { id: "LGPL-2.1-only" } }], properties: [{ name: "syft:metadata:source", value: "libx-src" }, { name: "syft:metadata:sourceVersion", value: "2-1" }] },
      npm("c", "/app/node_modules/c/package.json", "ISC"),
    ],
  };
  const extras = [parseExtra(`bundled@3=BSD-3-Clause=${join(root, "bundle")}=https://example.org/bundled`)];
  const r = buildNotices({ sbom, root, extras, title: "test" });
  assert.equal(r.text.match(/MIT text\nCopyright A/g).length, 1);
  assert.match(r.text, /LGPL text/);
  assert.match(r.text, /bundled text/);
  assert.match(r.text, /== Source code\n[\s\S]*libx 2 {2}\[LGPL-2\.1-only\]\n {4}debian 12 source package libx-src 2-1 — https:\/\/sources\.debian\.org\/src\/libx-src\/2-1\//);
  assert.match(r.text, /bundled 3 {2}\[BSD-3-Clause\]\n {4}https:\/\/example\.org\/bundled \(version 3\)/);
  assert.doesNotMatch(r.text, /on request|three years/);
  assert.deepEqual(r.missing.map((c) => c.name), ["c"]);
  const excepted = buildNotices({ sbom, root, extras, exceptions: [{ name: "c", version: "1.", reason: "reviewed: license in the package README only" }] });
  assert.deepEqual(excepted.missing, []);
  assert.equal(buildNotices({ sbom, root, extras, exceptions: [{ name: "c", reason: "" }] }).missing.length, 1);
  const merged = mergedSbom(sbom, r.components);
  assert.equal(merged.components.length, 6);
  assert.ok(merged.components.every((c) => !("_licensePath" in c)));
});

test("parses extras, scoped names included", () => {
  assert.deepEqual(parseExtra("@s/x@1.2=MIT=/p=https://s"), { name: "@s/x", version: "1.2", license: "MIT", path: "/p", source: "https://s" });
  assert.throws(() => parseExtra("x=MIT=/p"), /bad --extra/);
});
