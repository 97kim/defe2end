// Image comparison for visual regression and environment comparison (stage 7 contract section 3).
// Synchronous and CPU-bound: callers on a server or app thread use `compareImages` from ./visual-compare.js,
// which runs this in a worker thread. This file imports no local modules so the worker can load it directly.
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** Pixel colour sensitivity (0..1, smaller is stricter). Instance constant (contract section 1). */
export const VISUAL_PIXEL_SENSITIVITY = 0.05;
/** SSIM at or above this means a small shift rather than a change. Instance constant (contract section 1). */
export const VISUAL_SSIM_MIN = 0.95;
/** Default allowed difference in percent (step `threshold`, environment comparison tolerance). */
export const VISUAL_DEFAULT_TOLERANCE = 5;
/** SSIM is computed on a grayscale copy scaled down so its short side is this many pixels. */
export const VISUAL_SSIM_SHORT_SIDE = 256;

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
  ssimMin?: number;
}

export interface VisualCompareResult {
  verdict: VisualCompareVerdict;
  /** Differing pixels / all pixels × 100, unrounded. 100 for `size_mismatch`. Round only for display. */
  diffPercent: number;
  /** Set when the difference was over the tolerance and the sizes matched. */
  ssim?: number;
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
  const ssimMin = opts.ssimMin ?? VISUAL_SSIM_MIN;
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
  const ssim = ssimOf(a, b);
  return {
    verdict: ssim >= ssimMin ? "shifted" : "changed",
    diffPercent,
    ssim,
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

/** Luminance, alpha composited over white. */
function grayscale(img: RawImage): Float64Array {
  const out = new Float64Array(img.width * img.height);
  const d = img.data;
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    const alpha = d[i + 3]! / 255;
    const lum = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
    out[p] = lum * alpha + 255 * (1 - alpha);
  }
  return out;
}

/** Box-filter downscale with integer source spans, so the result doesn't depend on floating point order. */
function downscale(src: Float64Array, w: number, h: number, nw: number, nh: number): Float64Array {
  const rows = new Float64Array(nw * h);
  for (let x = 0; x < nw; x++) {
    const x0 = Math.floor((x * w) / nw);
    const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / nw));
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let sx = x0; sx < x1; sx++) sum += src[y * w + sx]!;
      rows[y * nw + x] = sum / (x1 - x0);
    }
  }
  const out = new Float64Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor((y * h) / nh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / nh));
    for (let x = 0; x < nw; x++) {
      let sum = 0;
      for (let sy = y0; sy < y1; sy++) sum += rows[sy * nw + x]!;
      out[y * nw + x] = sum / (y1 - y0);
    }
  }
  return out;
}

const SSIM_SIGMA = 1.5;
const SSIM_RADIUS = 5; // 11×11 Gaussian window
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
const KERNEL = Array.from({ length: SSIM_RADIUS * 2 + 1 }, (_, i) => Math.exp(-((i - SSIM_RADIUS) ** 2) / (2 * SSIM_SIGMA ** 2)));

/**
 * Mean SSIM (11×11 Gaussian window, sigma 1.5) of grayscale copies scaled down to a 256px short side.
 * Same-size inputs. The window is renormalised at the borders.
 */
export function ssimOf(a: RawImage, b: RawImage): number {
  let { width: w, height: h } = a;
  let ga = grayscale(a);
  let gb = grayscale(b);
  const short = Math.min(w, h);
  if (short > VISUAL_SSIM_SHORT_SIDE) {
    const scale = VISUAL_SSIM_SHORT_SIDE / short;
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    ga = downscale(ga, w, h, nw, nh);
    gb = downscale(gb, w, h, nw, nh);
    w = nw;
    h = nh;
  }
  const n = w * h;
  const aa = new Float64Array(n);
  const bb = new Float64Array(n);
  const ab = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    aa[i] = ga[i]! * ga[i]!;
    bb[i] = gb[i]! * gb[i]!;
    ab[i] = ga[i]! * gb[i]!;
  }
  const ma = blur(ga, w, h);
  const mb = blur(gb, w, h);
  const saa = blur(aa, w, h);
  const sbb = blur(bb, w, h);
  const sab = blur(ab, w, h);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const mx = ma[i]!;
    const my = mb[i]!;
    const vx = saa[i]! - mx * mx;
    const vy = sbb[i]! - my * my;
    const cov = sab[i]! - mx * my;
    total += ((2 * mx * my + C1) * (2 * cov + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
  }
  return total / n;
}

/** Separable Gaussian blur, weights renormalised where the window leaves the image. */
function blur(src: Float64Array, w: number, h: number): Float64Array {
  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let weight = 0;
      for (let k = -SSIM_RADIUS; k <= SSIM_RADIUS; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= w) continue;
        const kw = KERNEL[k + SSIM_RADIUS]!;
        sum += src[y * w + xx]! * kw;
        weight += kw;
      }
      tmp[y * w + x] = sum / weight;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let weight = 0;
      for (let k = -SSIM_RADIUS; k <= SSIM_RADIUS; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= h) continue;
        const kw = KERNEL[k + SSIM_RADIUS]!;
        sum += tmp[yy * w + x]! * kw;
        weight += kw;
      }
      out[y * w + x] = sum / weight;
    }
  }
  return out;
}
