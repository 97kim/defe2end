// Structure comparison of two accessibility snapshots (stage 7 contract section 6, "구조 판정" and "제한").
// A snapshot is text, one element per line, indentation = tree depth:
//   - link "Home":
//     - /url: https://shop.example/home
// Pure code: the server, the app and the web UI use the same rules.

/** Initial limits (contract section 6); adjust from measurements. */
export interface StructureLimits {
  maxBytes: number;
  maxLines: number;
  diffTimeMs: number;
  maxEditLines: number;
}

export const STRUCTURE_LIMITS: Readonly<StructureLimits> = {
  maxBytes: 256 * 1024,
  maxLines: 5_000,
  diffTimeMs: 2_000,
  maxEditLines: 2_000,
};

/** Placeholder a link's own-side origin is replaced with. */
export const ORIGIN_PLACEHOLDER = "{origin}";

export type StructureVerdict = "same" | "different" | "incomparable";
/**
 * `too_large` / `too_many_lines`: an input is over the size limits (`incomparable`).
 * `diff_timeout` / `too_many_edits`: the snapshots differ but no element diff was produced (`different`).
 */
export type StructureReason = "too_large" | "too_many_lines" | "diff_timeout" | "too_many_edits";
export type StructureEntryKind = "same" | "moved" | "left_only" | "right_only" | "changed";

/**
 * One row of the diff, in display order. Line numbers are 1-based in the normalised snapshot.
 * `moved` appears twice, once where it was (`at: "left"`) and once where it is (`at: "right"`), each
 * carrying both line numbers. `changed` carries both sides' text.
 */
export interface StructureEntry {
  kind: StructureEntryKind;
  left?: number;
  right?: number;
  at?: "left" | "right";
  /** Line text (normalised) for `same`, `moved`, `left_only`, `right_only`. */
  text?: string;
  leftText?: string;
  rightText?: string;
}

export interface StructureCounts {
  moved: number;
  leftOnly: number;
  rightOnly: number;
  changed: number;
}

export interface StructureDiffResult {
  verdict: StructureVerdict;
  reason?: StructureReason;
  counts?: StructureCounts;
  /**
   * The whole diff (the screen folds it). Bounded by the input limits: at most one row per line of each
   * side, so 10,000 rows of at most 256KiB of text per side.
   */
  entries?: StructureEntry[];
}

export interface StructureDiffOptions {
  /** Each side's base address (or origin); links starting with it become `{origin}`. */
  leftOrigin?: string;
  rightOrigin?: string;
  limits?: Partial<StructureLimits>;
  /** Clock for the time limit; tests replace it. */
  now?: () => number;
}

function originOf(base: string | undefined): string | undefined {
  if (!base) return undefined;
  try {
    const origin = new URL(base).origin;
    return origin === "null" ? undefined : origin.toLowerCase();
  } catch {
    return undefined;
  }
}

const URL_LINE = /^(\s*- \/url: )(.*)$/;

/**
 * Newlines to `\n`, trailing spaces and trailing blank lines removed, and link values (`/url:` lines only,
 * not screen text) that start with `origin` followed by a path, query, hash, quote or the end get the origin
 * replaced with `{origin}`. Case-insensitive; another host or port is left alone.
 */
export function normalizeSnapshot(text: string, base?: string): string[] {
  const origin = originOf(base);
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (!origin) return lines;
  return lines.map((line) => {
    const m = URL_LINE.exec(line);
    if (!m) return line;
    const value = m[2]!;
    const start = value.startsWith('"') ? 1 : 0;
    if (value.slice(start, start + origin.length).toLowerCase() !== origin) return line;
    const next = value.charAt(start + origin.length);
    if (next !== "" && !"/?#\"".includes(next)) return line;
    return m[1]! + value.slice(0, start) + ORIGIN_PLACEHOLDER + value.slice(start + origin.length);
  });
}

interface ParsedLine {
  depth: number;
  /** Line without indentation: the element's identity for move detection. */
  body: string;
  role: string;
}

const ROLE = /^-\s+("(?:[^"\\]|\\.)*"|[^\s:"[]+)/;

function parse(line: string): ParsedLine {
  const body = line.trimStart();
  const depth = line.length - body.length;
  const m = ROLE.exec(body);
  return { depth, body, role: m ? m[1]! : body };
}

function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

type Op = { t: "eq"; i: number; j: number } | { t: "del"; i: number } | { t: "ins"; j: number };

class Stop {
  constructor(readonly reason: "diff_timeout" | "too_many_edits") {}
}

/** Shortest edit script (Myers), giving up past `maxD` edits or the deadline. */
function editScript(a: string[], b: string[], maxD: number, deadline: number, now: () => number): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  const A = (x: number) => a[pre + x];
  const B = (y: number) => b[pre + y];

  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const off = max + 1;
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    if (d > maxD) throw new Stop("too_many_edits");
    if ((d & 15) === 0 && now() > deadline) throw new Stop("diff_timeout");
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && A(x) === B(y)) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }

  const middle: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!; // V as it was before step d, k = -d..d stored from index 0
    const get = (k: number) => prev[k + d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      middle.push({ t: "eq", i: pre + x, j: pre + y });
    }
    if (x === prevX) {
      y--;
      middle.push({ t: "ins", j: pre + y });
    } else {
      x--;
      middle.push({ t: "del", i: pre + x });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    middle.push({ t: "eq", i: pre + x, j: pre + y });
  }
  middle.reverse();
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: "eq", i, j: i });
  ops.push(...middle);
  for (let s = suf; s > 0; s--) ops.push({ t: "eq", i: a.length - s, j: b.length - s });
  return ops;
}

/** Compares two snapshots per contract section 6. Never throws on content. */
export function diffStructure(left: string, right: string, opts: StructureDiffOptions = {}): StructureDiffResult {
  const limits = { ...STRUCTURE_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const started = now();
  if (utf8Length(left) > limits.maxBytes || utf8Length(right) > limits.maxBytes) return { verdict: "incomparable", reason: "too_large" };
  const a = normalizeSnapshot(left, opts.leftOrigin);
  const b = normalizeSnapshot(right, opts.rightOrigin);
  if (a.length > limits.maxLines || b.length > limits.maxLines) return { verdict: "incomparable", reason: "too_many_lines" };
  if (a.length === b.length && a.every((line, i) => line === b[i])) return { verdict: "same" };

  let ops: Op[];
  try {
    ops = editScript(a, b, limits.maxEditLines, started + limits.diffTimeMs, now);
  } catch (err) {
    if (err instanceof Stop) return { verdict: "different", reason: err.reason };
    throw err;
  }

  const pa = a.map(parse);
  const pb = b.map(parse);
  // Partner of each deleted/inserted line: a moved twin or an in-place change.
  const movedTo = new Map<number, number>();
  const movedFrom = new Map<number, number>();
  const changedTo = new Map<number, number>();
  const changedFrom = new Map<number, number>();

  const inserted = new Map<string, number[]>();
  for (const op of ops) if (op.t === "ins") (inserted.get(pb[op.j]!.body) ?? inserted.set(pb[op.j]!.body, []).get(pb[op.j]!.body)!).push(op.j);
  for (const op of ops) {
    if (op.t !== "del") continue;
    const twins = inserted.get(pa[op.i]!.body);
    const j = twins?.shift();
    if (j === undefined) continue;
    movedTo.set(op.i, j);
    movedFrom.set(j, op.i);
  }

  // In-place changes: within one run of edits, an unpaired deletion and insertion at the same depth with the same role.
  for (let s = 0; s < ops.length; ) {
    if (ops[s]!.t === "eq") {
      s++;
      continue;
    }
    let e = s;
    while (e < ops.length && ops[e]!.t !== "eq") e++;
    const dels: number[] = [];
    const ins: number[] = [];
    for (let q = s; q < e; q++) {
      const op = ops[q]!;
      if (op.t === "del" && !movedTo.has(op.i)) dels.push(op.i);
      else if (op.t === "ins" && !movedFrom.has(op.j)) ins.push(op.j);
    }
    for (const i of dels) {
      const at = ins.findIndex((j) => pb[j]!.depth === pa[i]!.depth && pb[j]!.role === pa[i]!.role);
      if (at < 0) continue;
      const j = ins.splice(at, 1)[0]!;
      changedTo.set(i, j);
      changedFrom.set(j, i);
    }
    s = e;
  }

  const entries: StructureEntry[] = [];
  const counts: StructureCounts = { moved: movedTo.size, leftOnly: 0, rightOnly: 0, changed: changedTo.size };
  for (const op of ops) {
    if (op.t === "eq") {
      entries.push({ kind: "same", left: op.i + 1, right: op.j + 1, text: a[op.i]! });
    } else if (op.t === "del") {
      const moved = movedTo.get(op.i);
      const changed = changedTo.get(op.i);
      if (moved !== undefined) entries.push({ kind: "moved", left: op.i + 1, right: moved + 1, at: "left", text: a[op.i]! });
      else if (changed !== undefined) entries.push({ kind: "changed", left: op.i + 1, right: changed + 1, leftText: a[op.i]!, rightText: b[changed]! });
      else {
        entries.push({ kind: "left_only", left: op.i + 1, text: a[op.i]! });
        counts.leftOnly++;
      }
    } else {
      const moved = movedFrom.get(op.j);
      if (moved !== undefined) entries.push({ kind: "moved", left: moved + 1, right: op.j + 1, at: "right", text: b[op.j]! });
      else if (!changedFrom.has(op.j)) {
        entries.push({ kind: "right_only", right: op.j + 1, text: b[op.j]! });
        counts.rightOnly++;
      }
    }
  }
  return { verdict: "different", counts, entries };
}
