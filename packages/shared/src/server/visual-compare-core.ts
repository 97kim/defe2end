// Image comparison for visual regression and environment comparison (stage 7 contract section 3).
// Synchronous and CPU-bound: callers on a server or app thread use `compareImages` from ./visual-compare.js,
// which runs this in a worker thread. This file imports no local modules so the worker can load it directly.
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** Pixel colour sensitivity (0..1, smaller is stricter). Instance constant (contract section 1). */
export const VISUAL_PIXEL_SENSITIVITY = 0.05;
/** A difference that disappears when the current image is moved by up to this many pixels is a shift. Instance constant. */
export const VISUAL_SHIFT_RANGE = 2;
/** Default allowed difference in percent (step `threshold`, environment comparison tolerance). */
export const VISUAL_DEFAULT_TOLERANCE = 5;
/** Above this many pixels the shift search scores offsets on horizontal bands first, then confirms on the full image. */
const SHIFT_SAMPLE_ABOVE = 2_000_000;
const SHIFT_CONFIRM = 3;

export type VisualCompareVerdict = "match" | "shifted" | "changed" | "size_mismatch";
/** `regression`: diff only for `shifted`/`changed`. `environment`: diff for every valid pair. */
export type VisualCompareMode = "regression" | "environment";
export type EnvScreenVerdict = "same" | "different";

export interface ImageSize {
  width: number;
  height: number;
}

/** Decoded RGBA image, 4 bytes per pixel. */
export interface RawImage extends ImageSize {
  data: Uint8Array;
}

export interface VisualCompareOptions {
  /** Allowed difference in percent, 0..100. A difference equal to it still matches. */
  tolerance: number;
  mode: VisualCompareMode;
  /** Overrides for tests; production uses the instance constants. */
  pixelSensitivity?: number;
  shiftRange?: number;
}

/** Offset of the current image's content relative to the baseline: `y: 2` = moved 2px down. */
export interface ImageShift {
  x: number;
  y: number;
}

export interface VisualCompareResult {
  verdict: VisualCompareVerdict;
  /** Differing pixels / all pixels × 100, unrounded. 100 for `size_mismatch`. Round only for display. */
  diffPercent: number;
  /**
   * Set when the difference was over the tolerance and the sizes matched: the offset with the smallest
   * difference over the overlapping area, and that difference (unrounded). `shifted` when it is ≤ tolerance.
   */
  shift?: ImageShift;
  shiftDiffPercent?: number;
  /** PNG, per the mode's rule. */
  diffPng?: Uint8Array;
  /** `a` is the baseline (regression) or left side (environment); `b` the current capture or right side. */
  aSize: ImageSize;
  bSize: ImageSize;
}

const DIFF_COLOR: [number, number, number] = [255, 0, 0];

export function decodePng(png: Uint8Array): RawImage {
  const img = PNG.sync.read(Buffer.from(png.buffer, png.byteOffset, png.byteLength));
  return { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
}

export function encodePng(img: RawImage): Uint8Array {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return new Uint8Array(PNG.sync.write(png));
}

/** Compares two PNGs in the calling thread. Prefer `compareImages` outside tests. */
export function compareImagesSync(a: Uint8Array, b: Uint8Array, opts: VisualCompareOptions): VisualCompareResult {
  return compareDecoded(decodePng(a), decodePng(b), opts);
}

export function compareDecoded(a: RawImage, b: RawImage, opts: VisualCompareOptions): VisualCompareResult {
  const { tolerance, mode } = opts;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) throw new RangeError(`tolerance must be 0..100, got ${tolerance}`);
  const sensitivity = opts.pixelSensitivity ?? VISUAL_PIXEL_SENSITIVITY;
  const range = opts.shiftRange ?? VISUAL_SHIFT_RANGE;
  const aSize = { width: a.width, height: a.height };
  const bSize = { width: b.width, height: b.height };

  if (a.width !== b.width || a.height !== b.height) {
    const result: VisualCompareResult = { verdict: "size_mismatch", diffPercent: 100, aSize, bSize };
    if (mode === "environment" && a.width * a.height > 0 && b.width * b.height > 0) result.diffPng = overlayDiff(a, b, sensitivity);
    return result;
  }
  const pixels = a.width * a.height;
  if (pixels === 0) return { verdict: "match", diffPercent: 0, aSize, bSize };

  const wantDiff = mode === "environment";
  const out = new Uint8Array(pixels * 4);
  const differing = pixelmatch(a.data, b.data, out, a.width, a.height, { threshold: sensitivity, diffColor: DIFF_COLOR });
  const diffPercent = (differing / pixels) * 100;
  if (diffPercent <= tolerance) {
    return { verdict: "match", diffPercent, aSize, bSize, ...(wantDiff ? { diffPng: encodePng({ width: a.width, height: a.height, data: out }) } : {}) };
  }
  const best = searchShift(a, b, sensitivity, range);
  return {
    verdict: best && best.diffPercent <= tolerance ? "shifted" : "changed",
    diffPercent,
    ...(best ? { shift: { x: best.x, y: best.y }, shiftDiffPercent: best.diffPercent } : {}),
    aSize,
    bSize,
    diffPng: encodePng({ width: a.width, height: a.height, data: out }),
  };
}

/**
 * Environment comparison verdict for one screenshot (contract section 3). With tolerance 0 any measured
 * difference is `different`, including a `shifted` result.
 */
export function environmentScreenVerdict(result: Pick<VisualCompareResult, "verdict" | "diffPercent">, tolerance: number): EnvScreenVerdict {
  switch (result.verdict) {
    case "match":
      return tolerance === 0 && result.diffPercent > 0 ? "different" : "same";
    case "shifted":
      return tolerance === 0 ? "different" : "same";
    default:
      return "different";
  }
}

/** Both images on one canvas (the larger of each side); area covered by only one image is marked as different. */
function overlayDiff(a: RawImage, b: RawImage, sensitivity: number): Uint8Array {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const pa = pad(a, width, height);
  const pb = pad(b, width, height);
  const out = new Uint8Array(width * height * 4);
  pixelmatch(pa, pb, out, width, height, { threshold: sensitivity, diffColor: DIFF_COLOR });
  const overlapW = Math.min(a.width, b.width);
  const overlapH = Math.min(a.height, b.height);
  for (let y = 0; y < height; y++) {
    for (let x = y < overlapH ? overlapW : 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[i] = DIFF_COLOR[0];
      out[i + 1] = DIFF_COLOR[1];
      out[i + 2] = DIFF_COLOR[2];
      out[i + 3] = 255;
    }
  }
  return encodePng({ width, height, data: out });
}

function pad(img: RawImage, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < img.height; y++) out.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), y * width * 4);
  return out;
}

interface ShiftCandidate extends ImageShift {
  diffPercent: number;
}

/**
 * Smallest difference over the overlap when `b` is read at an offset of up to `range` px in each direction
 * (the unshifted position excluded). Large images score every offset on sampled bands and confirm the best
 * few on the full overlap, so the verdict always rests on full-resolution numbers.
 */
function searchShift(a: RawImage, b: RawImage, sensitivity: number, range: number): ShiftCandidate | undefined {
  const offsets: ImageShift[] = [];
  for (let y = -range; y <= range; y++) for (let x = -range; x <= range; x++) if ((x || y) && Math.abs(x) < a.width && Math.abs(y) < a.height) offsets.push({ x, y });
  if (offsets.length === 0) return undefined;
  let confirm = offsets;
  if (a.width * a.height > SHIFT_SAMPLE_ABOVE) {
    const scored = offsets.map((o) => ({ ...o, score: offsetDiff(a, b, o, sensitivity, 8) }));
    scored.sort((p, q) => p.score - q.score || order(p) - order(q));
    confirm = scored.slice(0, SHIFT_CONFIRM);
  }
  let best: ShiftCandidate | undefined;
  for (const o of confirm) {
    const diffPercent = offsetDiff(a, b, o, sensitivity, 1);
    if (!best || diffPercent < best.diffPercent || (diffPercent === best.diffPercent && order(o) < order(best))) best = { x: o.x, y: o.y, diffPercent };
  }
  return best;
}

/** Tie-break: the smaller move wins, then a fixed scan order. */
function order(o: ImageShift): number {
  return (Math.abs(o.x) + Math.abs(o.y)) * 1_000 + (o.y + 50) * 100 + (o.x + 50);
}

const BAND_ROWS = 32;

/**
 * Difference percentage between `a(x, y)` and `b(x + dx, y + dy)` over their overlap. `sample` > 1 compares
 * only one band of 32 rows in every `sample` bands (candidate scoring).
 */
function offsetDiff(a: RawImage, b: RawImage, o: ImageShift, sensitivity: number, sample: number): number {
  const w = a.width - Math.abs(o.x);
  const h = a.height - Math.abs(o.y);
  const ax = Math.max(0, -o.x);
  const ay = Math.max(0, -o.y);
  const bx = Math.max(0, o.x);
  const by = Math.max(0, o.y);
  const rows: number[] = [];
  for (let y = 0; y < h; y++) if (sample === 1 || Math.floor(y / BAND_ROWS) % sample === 0) rows.push(y);
  const ca = new Uint8Array(w * rows.length * 4);
  const cb = new Uint8Array(w * rows.length * 4);
  rows.forEach((y, r) => {
    const sa = ((ay + y) * a.width + ax) * 4;
    const sb = ((by + y) * b.width + bx) * 4;
    ca.set(a.data.subarray(sa, sa + w * 4), r * w * 4);
    cb.set(b.data.subarray(sb, sb + w * 4), r * w * 4);
  });
  const differing = pixelmatch(ca, cb, null, w, rows.length, { threshold: sensitivity });
  return (differing / (w * rows.length)) * 100;
}
