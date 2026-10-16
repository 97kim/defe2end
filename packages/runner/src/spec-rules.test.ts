// Cross-cutting rules of docs/action-spec.md: uploadFile download limits, settle wait (2.2), auto-scroll
// (2.10) and masking right before value input (2.11).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Step } from "@defe2end/shared";
import { describe, expect, it } from "vitest";
import { downloadFile } from "./download.js";
import { execute, makePlan, SECRET, useFixtures } from "./test-support.js";

const fixtures = useFixtures();
const open: Step = { id: "open", action: "goto", url: "/actions.html" };
const via = (to: string) => `${fixtures.url}/redirect?to=${encodeURIComponent(to)}`;
const download = (url: string, blockPrivateNetworks = false, maxBytes?: number) =>
  downloadFile(url, { network: { blockPrivateNetworks }, timeoutMs: 5_000, signal: new AbortController().signal, ...(maxBytes === undefined ? {} : { maxBytes }) });
const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (err: { code?: string }) => err.code);

describe("uploadFile download", () => {
  it("refuses metadata and private targets before fetching", async () => {
    expect(await codeOf(download("http://169.254.169.254/latest/meta-data/x.png"))).toBe("blocked_request");
    expect(await codeOf(download("http://0xa9fea9fe/x.png"))).toBe("blocked_request");
    expect(await codeOf(download(`${fixtures.url}/style.css`, true))).toBe("blocked_request");
    expect(await codeOf(download("http://10.0.0.1/x.png", true))).toBe("blocked_request");
    expect(await codeOf(download(`${fixtures.url}/style.css`))).toBe("ok");
  });

  it("checks every redirect hop", async () => {
    expect(await codeOf(download(via("http://169.254.169.254/latest/meta-data/x.png")))).toBe("blocked_request");
    expect(await codeOf(download(via("http://[::ffff:a9fe:a9fe]/x.png")))).toBe("blocked_request");
    expect(await codeOf(download(via(`${fixtures.url}/style.css`)))).toBe("ok");
  });

  it("stops at the size limit, declared or streamed", async () => {
    expect(await codeOf(download(`${fixtures.url}/style.css`, false, 10))).toBe("download_failed");
    // No Content-Length: the limit applies while reading.
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(Buffer.alloc(64));
      res.end(Buffer.alloc(64));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/big.png`;
      await expect(download(url, false, 100)).rejects.toThrow("could not download file (larger than 100 bytes)");
      expect(await codeOf(download(url, false, 1_000))).toBe("ok");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("fails the step on a blocked redirect even when optional", async () => {
    const { results } = await execute(
      makePlan(fixtures.url, [open, { id: "u", action: "uploadFile", selector: "#file", value: via("http://169.254.169.254/x.png"), optional: true }]),
    );
    expect(results[1]).toMatchObject({ status: "failed", errorCode: "blocked_request", attempts: 1 });
  });
});

describe("uploadFile attachment tokens (defE2End extension)", () => {
  const files: Record<string, { name: string; mimeType: string; buffer: Buffer }> = {
    "my photo.png": { name: "my photo.png", mimeType: "image/png", buffer: Buffer.from("12345") },
  };
  const resolveAttachment = async (name: string) => files[name];

  it("puts the attachment into the file input, mixed with downloaded URLs", async () => {
    const { results } = await execute(
      makePlan(fixtures.url, [
        { id: "open", action: "goto", url: "/parity.html" },
        { id: "u", action: "uploadFile", selector: "#file", value: `attachment:my%20photo.png, ${fixtures.url}/style.css` },
        { id: "t", action: "assertTitle", expected: "my photo.png:image/png,style.css:text/css", timeout: 2000 },
      ]),
      { resolveAttachment },
    );
    expect(results.map((r) => [r.status, r.errorMessage])).toEqual([["passed", undefined], ["passed", undefined], ["passed", undefined]]);
  });

  it("fails the step when the attachment wasn't pinned", async () => {
    const { results } = await execute(makePlan(fixtures.url, [open, { id: "u", action: "uploadFile", selector: "#file", value: "attachment:other.png" }]), { resolveAttachment });
    expect(results[1]).toMatchObject({ status: "failed", errorCode: "invalid_step" });
    expect(results[1]!.errorMessage).toContain('"other.png"');
  });
});

describe("settle wait (spec 2.2)", () => {
  it("follows successful non-wait steps only", async () => {
    const { results } = await execute(
      makePlan(fixtures.url, [
        open,
        { id: "ok", action: "click", selector: "#counter" },
        { id: "wait", action: "wait", timeout: 10 },
        { id: "warn", action: "assertVisibleOrWarn", selector: "#missing", timeout: 200 },
        { id: "skip", action: "click", selector: "#missing", timeout: 200, optional: true },
      ]),
    );
    const ms = Object.fromEntries(results.map((r) => [r.stepId, r.durationMs]));
    expect(results.map((r) => r.status)).toEqual(["passed", "passed", "passed", "warning", "skipped"]);
    expect(ms.ok).toBeGreaterThanOrEqual(500);
    expect(ms.wait).toBeLessThan(400);
    // Warning and skipped: the 200 ms wait, no 500 ms settle and no 2000 ms auto-scroll wait.
    expect(ms.warn).toBeLessThan(650);
    expect(ms.skip).toBeLessThan(650);
  });
});

describe("auto-scroll (spec 2.10)", () => {
  it("scrolls the target of an element step into view, but not for steps outside the list", async () => {
    const scrolled = '#scroll-y:not(:text-is("0"))';
    const { results } = await execute(
      makePlan(fixtures.url, [
        open,
        { id: "exists", action: "assertExists", selector: "#bottom" },
        { id: "still", action: "assertCount", selector: scrolled, expected: "0" },
        { id: "visible", action: "assertVisible", selector: "#bottom" },
        { id: "moved", action: "assertCount", selector: scrolled, expected: "1" },
      ]),
    );
    expect(results.map((r) => [r.stepId, r.status])).toEqual([
      ["open", "passed"],
      ["exists", "passed"],
      ["still", "passed"],
      ["visible", "passed"],
      ["moved", "passed"],
    ]);
  });
});

describe("masking before value input (spec 2.11)", () => {
  it("marks the field for masking before a secret is typed, and nothing without a secret", async () => {
    const { results } = await execute(
      makePlan(
        fixtures.url,
        [
          open,
          { id: "plain", action: "fill", selector: "#name", value: "plain" },
          { id: "none", action: "assertCount", selector: "[data-defe2end-secret]", expected: "0" },
          { id: "fill", action: "fill", selector: "#secret-field", value: "{{TOKEN}}" },
          { id: "marked", action: "assertExists", selector: "#secret-field[data-defe2end-secret]", timeout: 300 },
          { id: "press", action: "pressKey", selector: "#keys", value: "{{KEY}}" },
          { id: "marked2", action: "assertExists", selector: "#keys[data-defe2end-secret]", timeout: 300 },
        ],
        { variables: { TOKEN: { value: SECRET, secret: true }, KEY: { value: "Q", secret: true } } },
      ),
    );
    expect(results.filter((r) => r.status !== "passed").map((r) => [r.stepId, r.errorMessage])).toEqual([]);
  });
});
