"use client";

/**
 * components/ui/scroll-dialog.tsx
 *
 * A wide modal for long lists: "show all" views where the table cell can
 * only fit the first few entries. Unlike `Dialog`, whose whole viewport
 * scrolls, this one keeps its header, toolbar and footer fixed and scrolls
 * only the list between them, so the bulk action and the close button stay
 * reachable at entry 200. Under `sm` it becomes a full-screen sheet; above
 * it is `min(64rem, 100vw - 2rem)` wide and at most 80vh tall.
 *
 * It shares the page lock, focus restore and tab-order helpers with
 * `dialog.tsx`, so a `confirm()` opened from inside it stacks on top: keys
 * are only handled while this dialog is the topmost modal, which keeps an
 * Escape meant for the confirm from closing the list underneath it.
 */

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { getTabbables, lockPage, ModalPortal, restoreFocus, unlockPage } from "./dialog";

interface ScrollDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  /** Fixed above the scrolling list: filter box, "Select all", bulk actions. */
  toolbar?: ReactNode;
  /** Fixed below the scrolling list. */
  footer?: ReactNode;
  children: ReactNode;
}

function isTopmostModal(element: HTMLElement | null): boolean {
  if (!element) return false;
  const modals = document.querySelectorAll('[aria-modal="true"]');
  // Modals portal into <body> in the order they open, so the last one is on top.
  return modals[modals.length - 1] === element;
}

export function ScrollDialog({
  open,
  onClose,
  title,
  description,
  toolbar,
  footer,
  children,
}: ScrollDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // Read through a ref so an inline `onClose` arrow does not re-run the
  // open effect (and bounce focus) on every parent render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    lockPage();
    const tabbables = getTabbables(dialogRef.current);
    const initial = tabbables.find((el) => el.dataset["dialogFocus"] === "true") ?? tabbables[0];
    initial?.focus();

    function onKey(event: KeyboardEvent) {
      if (!isTopmostModal(dialogRef.current)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab") {
        const focusable = getTabbables(dialogRef.current);
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const active = document.activeElement;
        const outside = !dialogRef.current?.contains(active);
        if (event.shiftKey && (active === first || outside)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || outside)) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      unlockPage();
      restoreFocus(previouslyFocused);
    };
  }, [open]);

  if (!open) return null;

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-[100] !mt-0 flex items-stretch justify-center sm:items-center sm:p-4">
        <div
          className="absolute inset-0 bg-black/50"
          onClick={() => onCloseRef.current()}
          aria-hidden
        />
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          className="relative flex h-full w-full flex-col bg-[color:var(--color-bg)] shadow-xl sm:h-auto sm:max-h-[80vh] sm:w-[min(64rem,calc(100vw-2rem))] sm:rounded-lg sm:border sm:border-[color:var(--color-border)]"
        >
          <div className="flex items-start gap-3 border-b border-[color:var(--color-border)] px-4 py-3 sm:px-6 sm:py-4">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-lg font-semibold break-words">
                {title}
              </h2>
              {description ? (
                <div id={descriptionId} className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
                  {description}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => onCloseRef.current()}
              aria-label="Close"
              className="-mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-subtle)] hover:text-[color:var(--color-fg)] focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:outline-none"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
          {toolbar ? (
            <div className="border-b border-[color:var(--color-border)] px-4 py-3 sm:px-6">
              {toolbar}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 sm:px-6">
            {children}
          </div>
          {footer ? (
            <div className="border-t border-[color:var(--color-border)] px-4 py-3 sm:px-6">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </ModalPortal>
  );
}
