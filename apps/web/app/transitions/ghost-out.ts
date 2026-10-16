// Close transitions without delaying React unmounts (dialogs, menus and toasts are removed by their parents):
// right before an element goes away, a non-interactive copy is left at the same place and fades out over
// `--motion-fast`, then removed. Focus return and Escape handling stay with the real element, which is
// already gone. With prefers-reduced-motion nothing is copied.

export function motionMs(name = "--motion-fast"): number {
  if (typeof window === "undefined") return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  return raw.endsWith("ms") ? n : n * 1000;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** Leaves a fading copy of `el` where it is. `scrim`: also fade a modal backdrop. */
export function ghostOut(el: Element | null, opts: { scrim?: boolean } = {}): void {
  if (!el || typeof document === "undefined" || prefersReducedMotion()) return;
  const ms = motionMs();
  if (ms <= 0) return;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const copy = el.cloneNode(true) as HTMLElement;
  copy.removeAttribute("id");
  for (const n of copy.querySelectorAll("[id]")) n.removeAttribute("id");
  copy.setAttribute("aria-hidden", "true");
  copy.setAttribute("inert", "");
  // Drop the enter-transition classes: their @starting-style would replay the open animation on the copy.
  copy.classList.remove("t-modal", "t-dropdown", "t-toast", "t-panel-slide");
  copy.classList.add("t-ghost");
  Object.assign(copy.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: "0", inset: "auto" });
  // A closed <dialog> copy needs `open` to render outside the top layer.
  if (copy.tagName === "DIALOG") copy.setAttribute("open", "");
  const nodes: HTMLElement[] = [];
  if (opts.scrim) {
    const scrim = document.createElement("div");
    scrim.className = "t-ghost t-ghost-scrim";
    scrim.setAttribute("aria-hidden", "true");
    nodes.push(scrim);
  }
  nodes.push(copy);
  for (const n of nodes) document.body.appendChild(n);
  window.setTimeout(() => nodes.forEach((n) => n.remove()), ms + 50);
}
