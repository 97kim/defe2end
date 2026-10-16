import { describe, expect, it } from "vitest";
import { diffStructure, normalizeSnapshot, type StructureEntry } from "./structure-diff.js";

const snap = (...lines: string[]) => lines.join("\n");

const BASE = snap(
  "- banner:",
  '  - link "Home":',
  "    - /url: https://shop.example/",
  '- heading "Sale" [level=1]',
  "- list:",
  '  - listitem: "Shoes"',
  '  - listitem: "Bags"',
  '  - listitem: "Hats"',
  '- button "Buy"',
);

const kinds = (entries: StructureEntry[] | undefined) => (entries ?? []).filter((e) => e.kind !== "same").map((e) => `${e.kind}:${e.left ?? ""}:${e.right ?? ""}`);

describe("normalizeSnapshot", () => {
  it("unifies newlines and drops trailing spaces and blank lines", () => {
    expect(normalizeSnapshot("- a  \r\n- b\t\r- c\n\n")).toEqual(["- a", "- b", "- c"]);
  });

  it("replaces the own origin in link values only", () => {
    const lines = normalizeSnapshot(
      snap(
        "- /url: https://Shop.Example/a?b#c",
        "- /url: https://shop.example",
        '- /url: "https://shop.example?x=1"',
        "- /url: https://shop.example#top",
        "- /url: https://shop.example.evil.test/a",
        "- /url: https://shop.example:8443/a",
        "- /url: http://shop.example/a",
        "- /url: https://other.example/a",
        '- text: see https://shop.example/a',
        '- link "https://shop.example/a"',
      ),
      "https://shop.example/base/path?q=1",
    );
    expect(lines).toEqual([
      "- /url: {origin}/a?b#c",
      "- /url: {origin}",
      '- /url: "{origin}?x=1"',
      "- /url: {origin}#top",
      "- /url: https://shop.example.evil.test/a",
      "- /url: https://shop.example:8443/a",
      "- /url: http://shop.example/a",
      "- /url: https://other.example/a",
      "- text: see https://shop.example/a",
      '- link "https://shop.example/a"',
    ]);
  });

  it("leaves links alone without a usable base", () => {
    expect(normalizeSnapshot("- /url: https://a.example/", "not a url")).toEqual(["- /url: https://a.example/"]);
  });
});

describe("diffStructure", () => {
  it("is same after normalisation, with each side's own origin", () => {
    const right = BASE.replace("https://shop.example/", "https://stage.shop.example/").replace(/\n/g, "  \r\n");
    expect(diffStructure(BASE, right, { leftOrigin: "https://shop.example", rightOrigin: "https://stage.shop.example/x" })).toEqual({ verdict: "same" });
    // Without origins the link differs.
    expect(diffStructure(BASE, right).verdict).toBe("different");
  });

  it("counts a reorder as moved and different", () => {
    const right = snap(
      "- banner:",
      '  - link "Home":',
      "    - /url: https://shop.example/",
      '- heading "Sale" [level=1]',
      "- list:",
      '  - listitem: "Hats"',
      '  - listitem: "Shoes"',
      '  - listitem: "Bags"',
      '- button "Buy"',
    );
    const r = diffStructure(BASE, right);
    expect(r.verdict).toBe("different");
    expect(r.counts).toEqual({ moved: 1, leftOnly: 0, rightOnly: 0, changed: 0 });
    expect(kinds(r.entries)).toEqual(["moved:8:6", "moved:8:6"]);
    expect(r.entries!.filter((e) => e.kind === "moved").map((e) => e.at).sort()).toEqual(["left", "right"]);
  });

  it("reports lines on one side only", () => {
    const right = BASE.replace('- button "Buy"', '- button "Buy"\n- link "Help":\n  - /url: /help');
    const r = diffStructure(BASE, right);
    expect(r.counts).toEqual({ moved: 0, leftOnly: 0, rightOnly: 2, changed: 0 });
    expect(kinds(r.entries)).toEqual(["right_only::10", "right_only::11"]);
    const removed = diffStructure(right, BASE);
    expect(removed.counts).toEqual({ moved: 0, leftOnly: 2, rightOnly: 0, changed: 0 });
  });

  it("reports a name or value change in place as changed", () => {
    const right = BASE.replace('- heading "Sale" [level=1]', '- heading "Big sale" [level=1]').replace('"Bags"', '"Wallets"');
    const r = diffStructure(BASE, right);
    expect(r.counts).toEqual({ moved: 0, leftOnly: 0, rightOnly: 0, changed: 2 });
    const changed = r.entries!.filter((e) => e.kind === "changed");
    expect(changed).toEqual([
      { kind: "changed", left: 4, right: 4, leftText: '- heading "Sale" [level=1]', rightText: '- heading "Big sale" [level=1]' },
      { kind: "changed", left: 7, right: 7, leftText: '  - listitem: "Bags"', rightText: '  - listitem: "Wallets"' },
    ]);
  });

  it("does not pair different roles or depths as a change", () => {
    const right = BASE.replace('- button "Buy"', '- link "Buy"');
    expect(diffStructure(BASE, right).counts).toEqual({ moved: 0, leftOnly: 1, rightOnly: 1, changed: 0 });
    const deeper = BASE.replace('- button "Buy"', '  - button "Buy now"');
    expect(diffStructure(BASE, deeper).counts).toEqual({ moved: 0, leftOnly: 1, rightOnly: 1, changed: 0 });
  });

  it("separates moves, one-sided lines and changes in one diff", () => {
    const right = snap(
      '- heading "Sale" [level=1]',
      "- banner:",
      '  - link "Home":',
      "    - /url: https://shop.example/",
      "- list:",
      '  - listitem: "Shoes"',
      '  - listitem: "Caps"',
      '  - listitem: "Hats"',
      '- button "Buy"',
      '- contentinfo',
    );
    const r = diffStructure(BASE, right);
    expect(r.verdict).toBe("different");
    expect(r.counts).toEqual({ moved: 1, leftOnly: 0, rightOnly: 1, changed: 1 });
    // Every line of both sides is accounted for once (moved lines once per side).
    const leftLines = r.entries!.filter((e) => e.left !== undefined && (e.kind !== "moved" || e.at === "left")).map((e) => e.left);
    const rightLines = r.entries!.filter((e) => e.right !== undefined && (e.kind !== "moved" || e.at === "right")).map((e) => e.right);
    expect(leftLines).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect([...rightLines].sort((x, y) => x! - y!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("is incomparable over the size limits", () => {
    expect(diffStructure("- a\n".repeat(10), "- a", { limits: { maxLines: 5 } })).toEqual({ verdict: "incomparable", reason: "too_many_lines" });
    expect(diffStructure("x".repeat(300 * 1024), "- a")).toEqual({ verdict: "incomparable", reason: "too_large" });
    // Multi-byte characters count as UTF-8 bytes.
    expect(diffStructure("가".repeat(100 * 1024), "- a")).toEqual({ verdict: "incomparable", reason: "too_large" });
    expect(diffStructure(Array.from({ length: 5_001 }, (_, i) => `- item ${i}`).join("\n"), "- a")).toMatchObject({ reason: "too_many_lines" });
  });

  it("answers different without a diff past the edit or time limits", () => {
    const left = Array.from({ length: 50 }, (_, i) => `- a ${i}`).join("\n");
    const right = Array.from({ length: 50 }, (_, i) => `- b ${i}`).join("\n");
    expect(diffStructure(left, right, { limits: { maxEditLines: 20 } })).toEqual({ verdict: "different", reason: "too_many_edits" });
    let t = 0;
    expect(diffStructure(left, right, { now: () => (t += 1_000) })).toEqual({ verdict: "different", reason: "diff_timeout" });
    // 2,000 edits is still diffed within the default limits.
    const big = Array.from({ length: 1_000 }, (_, i) => `- listitem "x ${i}"`).join("\n");
    const bigOther = Array.from({ length: 1_000 }, (_, i) => `- listitem "y ${i}"`).join("\n");
    const r = diffStructure(big, bigOther);
    expect(r.counts).toMatchObject({ changed: 1_000 });
  });

  it("diffs 5,000-line snapshots with scattered edits quickly", () => {
    const left = Array.from({ length: 5_000 }, (_, i) => `${"  ".repeat(i % 4)}- listitem "row ${i}"`);
    const right = left.map((line, i) => (i % 10 === 0 ? line.replace("row", "line") : line));
    const started = performance.now();
    const r = diffStructure(left.join("\n"), right.join("\n"));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(r.counts).toEqual({ moved: 0, leftOnly: 0, rightOnly: 0, changed: 500 });
  });
});
