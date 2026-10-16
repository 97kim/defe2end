"use client";

import { useState } from "react";
import { Button, inputClass } from "../ui";

/** A one-time link shown once, read-only, with a copy button. */
export function LinkReveal({ url, copyLabel, copiedLabel }: { url: string; copyLabel: string; copiedLabel: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label={copyLabel} className={`${inputClass} font-mono text-code-sm`} data-testid="one-time-link" />
      <Button
        type="button"
        variant="secondary"
        className="shrink-0"
        onClick={async () => {
          await navigator.clipboard.writeText(url).catch(() => undefined);
          setCopied(true);
        }}
      >
        {copied ? copiedLabel : copyLabel}
      </Button>
    </div>
  );
}

/** Reads `#token=` once and removes it from the address bar (and so from history). */
export function readTokenFromHash(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  if (window.location.hash) history.replaceState(null, "", window.location.pathname);
  return token;
}
