"use client";

import { useTranslations } from "next-intl";
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ghostOut } from "../../app/transitions/ghost-out";
import { CloseIcon } from "../icons";

/**
 * ds-2 Feedback/Dialog on a scrim. Native modal <dialog>: the page behind is inert, so focus stays inside.
 * Escape, the scrim and the × call `onClose`; the parent decides whether it really closes.
 * Focus returns to whatever had it when the dialog opened. With `onSubmit` the body and footer are one form.
 */
export function Dialog({
  open = true,
  title,
  onClose,
  onSubmit,
  children,
  footer,
  wide,
}: {
  open?: boolean;
  title: string;
  onClose: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const t = useTranslations("common.dialog");
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // The body mounts only once the dialog is showing, so `autoFocus` inside it lands (focus() on a closed dialog is lost).
  const [shown, setShown] = useState(false);
  // Set while we close it ourselves; any other close (browsers can force one on repeated Escape) is reported.
  const closing = useRef(false);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closing.current = false;
    if (!dialog.open) dialog.showModal();
    setShown(true);
    return () => {
      closing.current = true;
      // Close transition: a fading copy stays briefly; the real dialog closes now (focus returns at once).
      if (dialog.open) ghostOut(dialog, { scrim: true });
      setShown(false);
      if (dialog.open) dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  const body = (
    <>
      <div className="flex items-start justify-between gap-4 px-6 pt-5">
        <h2 id={titleId} className="text-title-md">
          {title}
        </h2>
        <button type="button" onClick={onClose} aria-label={t("close")} className="rounded-control p-1 text-text-muted hover:bg-bg-subtle hover:text-text-primary">
          <CloseIcon width={16} height={16} />
        </button>
      </div>
      <div className="flex flex-col gap-4 px-6 py-4">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-border px-6 py-4">{footer}</div>}
    </>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape: let the parent close it (it may refuse, e.g. while saving).
        event.preventDefault();
        onClose();
      }}
      // `close` arrives a task later: skip it if we closed it, or if it is already open again (Strict Mode remount).
      onClose={() => !closing.current && !ref.current?.open && onClose()}
      // A press on the dialog element itself is a press on the scrim (the content covers the box).
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      className={`t-modal m-auto ${wide ? "w-[min(576px,calc(100vw-32px))]" : "w-[min(480px,calc(100vw-32px))]"} rounded-card border border-border bg-bg-surface p-0 text-text-primary shadow-e3 backdrop:bg-text-primary/30`}
    >
      {open &&
        shown &&
        (onSubmit ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit(event);
            }}
          >
            {body}
          </form>
        ) : (
          body
        ))}
    </dialog>
  );
}
