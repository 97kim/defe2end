import type { ReactNode } from "react";
import { LockIcon } from "../icons";
import { Wordmark } from "../ui";

/** Centered card used by the public /invite and /reset pages. */
export function LinkPageFrame({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex justify-center">
          <Wordmark />
        </div>
        <div className="rounded-card border border-border bg-bg-surface p-6 shadow-e2">{children}</div>
      </div>
    </main>
  );
}

/** Why a link can't be used (s-6 style, inside the card). */
export function LinkProblem({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3" data-testid="link-problem">
      <span className="flex size-10 items-center justify-center rounded-card border border-border bg-bg-subtle">
        <LockIcon width={18} height={18} />
      </span>
      <h1 className="text-title-md">{title}</h1>
      <p className="text-text-secondary">{body}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
