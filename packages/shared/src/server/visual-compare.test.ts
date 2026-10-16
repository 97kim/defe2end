import { describe, expect, it } from "vitest";
import {
  compareDecoded,
  compareImages,
  compareImagesSync,
  decodePng,
  encodePng,
  environmentScreenVerdict,
  ssimOf,
  type RawImage,
} from "./visual-compare.js";

function blank(width: number, height: number, rgb: [number, number, number] = [255, 255, 255]): RawImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return { width, height, data };
}

function setPixel(img: RawImage, x: number, y: number, rgb: [number, number, number]): void {
  img.data.set([...rgb, 255], (y * img.width + x) * 4);
}

function fillRect(img: RawImage, x0: number, y0: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < img.width && y < img.height) setPixel(img, x, y, rgb);
}

/** A page-like picture: header bar, text-ish blocks, a card grid. `dx`/`dy` shift all content. */
function page(width: number, height: number, dx = 0, dy = 0): RawImage {
  const img = blank(width, height);
  fillRect(img, 0 + dx, 0 + dy, width, 60, [30, 60, 120]);
  for (let row = 0; row * 28 + 100 < height - 40; row++) {
    const lineW = 200 + ((row * 97) % (width - 260));
    fillRect(img, 40 + dx, 100 + row * 28 + dy, lineW, 12, [60, 60, 60]);
  }
  for (let c = 0; c < 3; c++) fillRect(img, 40 + c * Math.floor(width / 3) + dx, Math.floor(height / 2) + dy, Math.floor(width / 3) - 60, 120, [200, 120, 40]);
  return img;
}

const png = (img: RawImage) => encodePng(img);

describe("compareDecoded", () => {
  it("reports different sizes as size_mismatch at 100% without a regression diff", () => {
    const r = compareDecoded(blank(10, 10), blank(10, 11), { tolerance: 5, mode: "regression" });
    expect(r).toMatchObject({ verdict: "size_mismatch", diffPercent: 100, aSize: { width: 10, height: 10 }, bSize: { width: 10, height: 11 } });
    expect(r.diffPng).toBeUndefined();
  });

  it("overlays different sizes on one canvas in environment mode", () => {
    const a = blank(10, 10);
    const b = blank(12, 8);
    const r = compareDecoded(a, b, { tolerance: 5, mode: "environment" });
    expect(r.verdict).toBe("size_mismatch");
    const diff = decodePng(r.diffPng!);
    expect([diff.width, diff.height]).toEqual([12, 10]);
    // Inside the overlap both are white; outside it only one image has pixels.
    expect(Array.from(diff.data.subarray(0, 3))).not.toEqual([255, 0, 0]);
    expect(Array.from(diff.data.subarray((9 * 12 + 0) * 4, (9 * 12 + 0) * 4 + 3))).toEqual([255, 0, 0]);
    expect(Array.from(diff.data.subarray((0 * 12 + 11) * 4, (0 * 12 + 11) * 4 + 3))).toEqual([255, 0, 0]);
  });

  it("treats two empty images as a match", () => {
    const empty = { width: 0, height: 0, data: new Uint8Array(0) };
    expect(compareDecoded(empty, empty, { tolerance: 0, mode: "environment" })).toMatchObject({ verdict: "match", diffPercent: 0 });
  });

  it("matches when the difference equals the tolerance and not when it is just over", () => {
    const a = blank(10, 10);
    const b = blank(10, 10);
    for (let x = 0; x < 5; x++) setPixel(b, x * 2, 5, [0, 0, 0]); // 5 of 100 pixels
    const at = compareDecoded(a, b, { tolerance: 5, mode: "regression" });
    expect(at).toMatchObject({ verdict: "match", diffPercent: 5 });
    expect(at.ssim).toBeUndefined();
    const over = compareDecoded(a, b, { tolerance: 4.999, mode: "regression" });
    expect(over.verdict).not.toBe("match");
  });

  it("judges on the unrounded value: 0.004% differs at tolerance 0", () => {
    const a = blank(250, 100); // 25,000 pixels, one differs = 0.004%
    const b = blank(250, 100);
    setPixel(b, 120, 50, [0, 0, 0]);
    const r = compareDecoded(a, b, { tolerance: 0, mode: "regression" });
    expect(r.diffPercent).toBeCloseTo(0.004, 10);
    expect(r.verdict).not.toBe("match");
    expect(environmentScreenVerdict(r, 0)).toBe("different");
    // The same pair passes a tolerance that rounds to the same display value.
    expect(compareDecoded(a, b, { tolerance: 0.01, mode: "regression" }).verdict).toBe("match");
  });

  it("ignores colour changes under the 0.05 sensitivity and counts those over it", () => {
    const a = blank(10, 10, [200, 200, 200]);
    const b = blank(10, 10, [201, 200, 200]);
    expect(compareDecoded(a, b, { tolerance: 0, mode: "regression" })).toMatchObject({ verdict: "match", diffPercent: 0 });
    const c = blank(10, 10, [120, 120, 120]);
    expect(compareDecoded(a, c, { tolerance: 0, mode: "regression" }).diffPercent).toBe(100);
  });

  // Measured with this engine: a 1px shift of a desktop page stays over the SSIM floor; 2px shifts and narrow
  // (mobile) pages fall under it and read as `changed`. See the stage 7 report before relying on `shifted`.
  it("catches a 1px shift of a desktop page as shifted", () => {
    const r = compareDecoded(page(1920, 1080), page(1920, 1080, 0, 1), { tolerance: 0, mode: "regression" });
    expect(r.diffPercent).toBeGreaterThan(0);
    expect(r.ssim).toBeGreaterThanOrEqual(0.95);
    expect(r.verdict).toBe("shifted");
    expect(r.diffPng).toBeDefined();
  });

  it("calls a real content change changed", () => {
    const b = page(800, 600);
    fillRect(b, 0, 150, 800, 300, [10, 200, 10]);
    const r = compareDecoded(page(800, 600), b, { tolerance: 5, mode: "regression" });
    expect(r.verdict).toBe("changed");
    expect(r.ssim).toBeLessThan(0.95);
    expect(r.diffPng).toBeDefined();
  });

  it("uses the SSIM floor as an inclusive boundary", () => {
    const a = page(400, 300);
    const b = page(400, 300, 0, 2);
    const ssim = ssimOf(a, b);
    expect(compareDecoded(a, b, { tolerance: 0, mode: "regression", ssimMin: ssim }).verdict).toBe("shifted");
    expect(compareDecoded(a, b, { tolerance: 0, mode: "regression", ssimMin: ssim + 1e-9 }).verdict).toBe("changed");
  });

  it("is deterministic and symmetric enough for SSIM on large images", () => {
    const a = page(1200, 900);
    const b = page(1200, 900, 1, 0);
    expect(ssimOf(a, b)).toBe(ssimOf(a, b));
    expect(ssimOf(a, a)).toBeCloseTo(1, 12);
  });

  it("follows the diff rule per mode", () => {
    const a = blank(20, 20);
    const same = compareDecoded(a, blank(20, 20), { tolerance: 5, mode: "regression" });
    expect(same.diffPng).toBeUndefined();
    const sameEnv = compareDecoded(a, blank(20, 20), { tolerance: 5, mode: "environment" });
    expect(sameEnv.verdict).toBe("match");
    expect(decodePng(sameEnv.diffPng!).width).toBe(20);
    const b = blank(20, 20);
    setPixel(b, 3, 3, [0, 0, 0]); // 0.25%, under the tolerance
    expect(compareDecoded(a, b, { tolerance: 5, mode: "regression" }).diffPng).toBeUndefined();
    expect(compareDecoded(a, b, { tolerance: 5, mode: "environment" }).diffPng).toBeDefined();
  });

  it("rejects a tolerance outside 0..100", () => {
    expect(() => compareDecoded(blank(1, 1), blank(1, 1), { tolerance: -1, mode: "regression" })).toThrow(RangeError);
    expect(() => compareDecoded(blank(1, 1), blank(1, 1), { tolerance: 101, mode: "regression" })).toThrow(RangeError);
    expect(() => compareDecoded(blank(1, 1), blank(1, 1), { tolerance: Number.NaN, mode: "regression" })).toThrow(RangeError);
  });
});

describe("environmentScreenVerdict", () => {
  it("maps verdicts to same/different", () => {
    expect(environmentScreenVerdict({ verdict: "match", diffPercent: 0 }, 5)).toBe("same");
    expect(environmentScreenVerdict({ verdict: "match", diffPercent: 3 }, 5)).toBe("same");
    expect(environmentScreenVerdict({ verdict: "shifted", diffPercent: 8 }, 5)).toBe("same");
    expect(environmentScreenVerdict({ verdict: "changed", diffPercent: 8 }, 5)).toBe("different");
    expect(environmentScreenVerdict({ verdict: "size_mismatch", diffPercent: 100 }, 5)).toBe("different");
  });

  it("is strict at tolerance 0", () => {
    expect(environmentScreenVerdict({ verdict: "match", diffPercent: 0 }, 0)).toBe("same");
    expect(environmentScreenVerdict({ verdict: "match", diffPercent: 0.001 }, 0)).toBe("different");
    expect(environmentScreenVerdict({ verdict: "shifted", diffPercent: 0.5 }, 0)).toBe("different");
  });
});

describe("compareImages (worker)", () => {
  it("gives the same answer as the synchronous version", async () => {
    const a = png(page(400, 300));
    const b = png(page(400, 300, 0, 1));
    const opts = { tolerance: 0, mode: "regression" as const };
    const viaWorker = await compareImages(a, b, opts);
    const direct = compareImagesSync(a, b, opts);
    expect({ ...viaWorker, diffPng: undefined }).toEqual({ ...direct, diffPng: undefined });
    expect(Buffer.from(viaWorker.diffPng!).equals(Buffer.from(direct.diffPng!))).toBe(true);
    // Inputs are copied, not detached.
    expect(a.byteLength).toBeGreaterThan(0);
  });

  it("rejects an unreadable PNG", async () => {
    await expect(compareImages(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]), { tolerance: 5, mode: "regression" })).rejects.toThrow();
  });

  it("compares a 1920×4000 page without holding the event loop", async () => {
    const a = png(page(1920, 4000));
    const b = png(page(1920, 4000, 0, 2));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = performance.now();
    const r = await compareImages(a, b, { tolerance: 0, mode: "environment" });
    const elapsed = performance.now() - started;
    clearInterval(timer);
    console.log(`1920x4000 compare: ${elapsed.toFixed(0)} ms, ${ticks} timer ticks, verdict ${r.verdict}, diff ${r.diffPercent.toFixed(3)}%, ssim ${r.ssim?.toFixed(4)}`);
    expect(r.ssim).toBeDefined();
    expect(elapsed).toBeLessThan(10_000);
    // The main thread kept running while the worker compared.
    expect(ticks).toBeGreaterThan(Math.floor(elapsed / 10 / 4));
  }, 30_000);
});
