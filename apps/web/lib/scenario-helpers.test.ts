import { scenarioExportSchema } from "@defe2end/shared";
import { describe, expect, it, vi } from "vitest";
import {
  buildExport,
  cleanStep,
  confirmLeave,
  copyName,
  importedScenarioSchema,
  importFileSchema,
  moveItem,
  newStepId,
  planImport,
  SCENARIO_NAME_MAX,
  SCENARIO_TRANSFER_MAX,
  scenarioNameSchema,
  type LeaveChoice,
} from "./scenario-helpers";

describe("copyName", () => {
  it("prefixes and keeps within the name limit", () => {
    expect(copyName("Checkout")).toBe("Copy of Checkout");
    expect(copyName("x".repeat(SCENARIO_NAME_MAX))).toHaveLength(SCENARIO_NAME_MAX);
  });
});

describe("moveItem", () => {
  it("moves up and down and ignores out-of-range moves", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 2)).toEqual(["a", "b"]);
  });
});

describe("cleanStep", () => {
  it("drops empty fields and keeps keys the action doesn't use", () => {
    expect(cleanStep({ id: "1", action: "click", selector: "a", value: "", url: "/x" } as never)).toEqual({ id: "1", action: "click", selector: "a", url: "/x" });
    expect(cleanStep({ id: "1", action: "wait", timeout: 500, optional: false })).toEqual({ id: "1", action: "wait", timeout: 500 });
  });
});

it("newStepId is unique", () => {
  expect(new Set(Array.from({ length: 50 }, newStepId)).size).toBe(50);
});

describe("buildExport / planImport", () => {
  const file = buildExport([
    { name: "Checkout", description: "", siteName: "Shop", tagNames: ["smoke", "checkout"], steps: [{ id: "s1", action: "goto", url: "/", value: "" }] },
  ]);

  it("builds a file the shared schema accepts", () => {
    expect(scenarioExportSchema.parse(file)).toEqual(file);
    expect(file.scenarios[0]).toEqual({
      name: "Checkout",
      description: "",
      site: "Shop",
      tags: ["checkout", "smoke"],
      steps: [{ id: "s1", action: "goto", url: "/" }],
    });
  });

  it("maps sites by name and reports invalid entries and missing sites", () => {
    const parsed = importFileSchema.parse({
      ...file,
      scenarios: [
        ...file.scenarios,
        { name: "Bad", site: "Shop", steps: [{ id: "1", action: "drag" }] },
        { name: "Elsewhere", site: "Blog", steps: [] },
        "not an object",
      ],
    });
    const plan = planImport(parsed.scenarios, new Map([["Shop", "site-1"]]));
    expect(plan.create.map((s) => [s.name, s.siteId])).toEqual([["Checkout", "site-1"]]);
    expect(plan.skipped.map((s) => [s.index, s.name, s.reason])).toEqual([
      [1, "Bad", "invalid"],
      [2, "Elsewhere", "site_not_found"],
      [3, null, "invalid"],
    ]);
    expect(plan.skipped[0]!.detail).toContain("steps.0.action");
  });

  it("rejects a file with the wrong header", () => {
    expect(importFileSchema.safeParse({ ...file, format: "other" }).success).toBe(false);
    expect(importFileSchema.safeParse({ ...file, stepFormatVersion: 2 }).success).toBe(false);
  });
});

describe("scenario names", () => {
  it("create/update and import share one rule: trimmed, whitespace-only rejected", () => {
    expect(scenarioNameSchema.parse("  Checkout  ")).toBe("Checkout");
    expect(scenarioNameSchema.safeParse("   ").success).toBe(false);
    const entry = { name: "   ", site: "Shop", steps: [] };
    expect(importedScenarioSchema.safeParse(entry).success).toBe(false);
    expect(importedScenarioSchema.parse({ ...entry, name: " Checkout ", tags: [" smoke "] })).toMatchObject({ name: "Checkout", tags: ["smoke"] });
    const plan = planImport([entry, { ...entry, tags: ["  "] , name: "ok" }], new Map([["Shop", "site-1"]]));
    expect(plan.skipped.map((s) => s.reason)).toEqual(["invalid", "invalid"]);
    expect(plan.skipped[0]!.detail).toContain("name");
  });
});

describe("transfer limit", () => {
  it("import file holds at most SCENARIO_TRANSFER_MAX scenarios", () => {
    const head = { format: "defe2end.scenario", formatVersion: 1, stepFormatVersion: 1 };
    expect(importFileSchema.safeParse({ ...head, scenarios: Array(SCENARIO_TRANSFER_MAX).fill({}) }).success).toBe(true);
    expect(importFileSchema.safeParse({ ...head, scenarios: Array(SCENARIO_TRANSFER_MAX + 1).fill({}) }).success).toBe(false);
  });
});

describe("confirmLeave (unsaved-changes guard)", () => {
  const setup = (choice: LeaveChoice, saved = true) => ({ ask: vi.fn(async () => choice), save: vi.fn(async () => saved) });

  it("goes ahead without asking when nothing is unsaved", async () => {
    const { ask, save } = setup("cancel");
    expect(await confirmLeave(false, ask, save)).toBe("kept");
    expect(ask).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("Cancel stays, Discard goes ahead without saving", async () => {
    const cancel = setup("cancel");
    expect(await confirmLeave(true, cancel.ask, cancel.save)).toBe(false);
    expect(cancel.save).not.toHaveBeenCalled();
    const discard = setup("discard");
    expect(await confirmLeave(true, discard.ask, discard.save)).toBe("discarded");
    expect(discard.save).not.toHaveBeenCalled();
  });

  it("Save and continue goes ahead only when the save succeeded", async () => {
    const ok = setup("save", true);
    expect(await confirmLeave(true, ok.ask, ok.save)).toBe("kept");
    expect(ok.save).toHaveBeenCalledOnce();
    const failed = setup("save", false);
    expect(await confirmLeave(true, failed.ask, failed.save)).toBe(false);
  });
});
