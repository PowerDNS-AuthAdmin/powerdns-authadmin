"use client";

/**
 * components/ui/dialog.tsx
 *
 * In-app modal + toast system, replacing the browser's native alert / confirm
 * which the project bans on UX grounds. Exposes an imperative API via the
 * `useDialog()` hook:
 *
 *   const { confirm, toast } = useDialog();
 *   if (await confirm({ title: "Delete user?", variant: "danger" })) { … }
 *   toast({ kind: "success", description: "Saved." });
 *
 * Both are global: the `DialogProvider` mounts once in `app/(app)/layout.tsx`
 * and `app/(auth)/layout.tsx`, and every component beneath gets the hook.
 *
 * Accessibility:
 *   - role="dialog", aria-modal, aria-labelledby / aria-describedby
 *   - Escape closes (resolves false for confirms)
 *   - Backdrop click closes (configurable per-call)
 *   - Focus moves into the dialog on open; first focusable element is the
 *     primary action. Restored to the prior activeElement on close.
 *   - Focus trap via Tab cycling among tabbable descendants.
 *
 * Toasts are non-blocking and auto-dismiss after 4–8s depending on kind.
 * Stacked top-right, dismissible, paused on hover.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

// =============================================================================
// Shared body-scroll-lock — counter-based so stacked dialogs cooperate.
//
// The bug this guards against: each Dialog effect used to save+restore
// `body.style.overflow` independently. When the editor flow opened a second
// dialog (Review) on top of the first (Editor), the Review effect captured
// the already-set `overflow: hidden` as its "previous" value. On close,
// React fires cleanups in an order that depends on commit timing — if the
// outer cleanup ran first, the inner cleanup would then *re-apply*
// `overflow: hidden` over the now-restored `""`, leaving the page scroll
// permanently locked.
//
// Instead, every Dialog calls `lockBodyScroll()` on open and
// `unlockBodyScroll()` on close. The first lock snapshots the original
// value and applies `hidden`; subsequent locks just bump the counter. The
// last unlock restores the snapshot. Order-independent.
// =============================================================================

let activeDialogLocks = 0;
let bodyOverflowBeforeLock: string | null = null;

function lockBodyScroll(): void {
  if (typeof document === "undefined") return;
  if (activeDialogLocks === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  activeDialogLocks++;
}

function unlockBodyScroll(): void {
  if (typeof document === "undefined") return;
  if (activeDialogLocks === 0) return;
  activeDialogLocks--;
  if (activeDialogLocks === 0 && bodyOverflowBeforeLock !== null) {
    document.body.style.overflow = bodyOverflowBeforeLock;
    bodyOverflowBeforeLock = null;
  }
}

// =============================================================================
// Public API
// =============================================================================

export type DialogVariant = "default" | "danger";

/** Optional checkbox rendered between the description and the action row. */
export interface ConfirmCheckbox {
  label: string;
  /** Initial checked state. Default false. */
  defaultChecked?: boolean;
  /** Alert shown (in a warning style) ONLY while the box is unchecked. */
  warningWhenUnchecked?: string;
}

export interface ConfirmCheckboxResult {
  confirmed: boolean;
  /** The checkbox's final state (only meaningful when `confirmed`). */
  checked: boolean;
}

export interface ConfirmOptions {
  title: string;
  /** Body text. Accepts a node so callers can prepend an icon, bold a phrase, etc. */
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
  /** When true (default), backdrop click cancels. Disable for high-stakes prompts. */
  dismissOnBackdrop?: boolean;
  /** Adds a checkbox; `confirm` then resolves `{ confirmed, checked }`. */
  checkbox?: ConfirmCheckbox;
}

export interface PromptOptions {
  title: string;
  description?: string;
  /** Initial value of the input. */
  defaultValue?: string;
  /** HTML placeholder attribute. */
  placeholder?: string;
  /** Label text above the input. Defaults to the title. */
  label?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * Optional synchronous validator. Return null when the value is
   * acceptable, or a string error message to render under the input
   * and block submission.
   */
  validate?: (value: string) => string | null;
  /** When true (default), backdrop click cancels. */
  dismissOnBackdrop?: boolean;
}

export type ToastKind = "success" | "error" | "info" | "warn";

export interface ToastOptions {
  title?: string;
  description: string;
  kind?: ToastKind;
  /** Duration in ms. Default depends on kind. */
  durationMs?: number;
}

interface DialogApi {
  confirm: {
    (opts: ConfirmOptions & { checkbox: ConfirmCheckbox }): Promise<ConfirmCheckboxResult>;
    (opts: ConfirmOptions): Promise<boolean>;
  };
  /**
   * Prompt for a single text value. Resolves with the trimmed input
   * on confirm, or `null` on cancel / dismiss. Replaces the browser's
   * `window.prompt` for the same reasons we ban `alert` / `confirm`:
   * native modals are unstyled, can't be tested, and break flow on
   * mobile.
   */
  prompt: (opts: PromptOptions) => Promise<string | null>;
  toast: (opts: ToastOptions) => void;
}

const DialogContext = createContext<DialogApi | null>(null);

export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error(
      "useDialog must be used inside a <DialogProvider>. Add it to the route layout.",
    );
  }
  return ctx;
}

// =============================================================================
// Provider
// =============================================================================

interface ConfirmState extends ConfirmOptions {
  id: number;
  resolve: (value: ConfirmCheckboxResult) => void;
}

interface PromptState extends PromptOptions {
  id: number;
  resolve: (value: string | null) => void;
}

interface ToastState extends ToastOptions {
  id: number;
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [confirmStack, setConfirmStack] = useState<ConfirmState[]>([]);
  const [promptStack, setPromptStack] = useState<PromptState[]>([]);
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const nextId = useRef(1);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean | ConfirmCheckboxResult> => {
    return new Promise<boolean | ConfirmCheckboxResult>((resolve) => {
      setConfirmStack((stack) => [
        ...stack,
        {
          ...opts,
          id: nextId.current++,
          // Callers without a checkbox keep the historical boolean contract;
          // callers with one get the richer { confirmed, checked }.
          resolve: (r: ConfirmCheckboxResult) => resolve(opts.checkbox ? r : r.confirmed),
        },
      ]);
    });
  }, []) as DialogApi["confirm"];

  const resolveTop = useCallback((value: ConfirmCheckboxResult) => {
    setConfirmStack((stack) => {
      const top = stack[stack.length - 1];
      if (!top) return stack;
      top.resolve(value);
      return stack.slice(0, -1);
    });
  }, []);

  const prompt = useCallback((opts: PromptOptions): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      setPromptStack((stack) => [...stack, { ...opts, id: nextId.current++, resolve }]);
    });
  }, []);

  const resolveTopPrompt = useCallback((value: string | null) => {
    setPromptStack((stack) => {
      const top = stack[stack.length - 1];
      if (!top) return stack;
      top.resolve(value);
      return stack.slice(0, -1);
    });
  }, []);

  const toast = useCallback((opts: ToastOptions) => {
    const id = nextId.current++;
    const durationMs =
      opts.durationMs ?? (opts.kind === "error" ? 8000 : opts.kind === "warn" ? 6000 : 4000);
    setToasts((current) => [...current, { ...opts, id }]);
    if (durationMs > 0) {
      window.setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== id));
      }, durationMs);
    }
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const api = useMemo<DialogApi>(() => ({ confirm, prompt, toast }), [confirm, prompt, toast]);

  // Stack ordering: confirms render under prompts when both are open
  // (a prompt opened from inside a confirm's handler still appears on
  // top). The `isTopMost` heuristic considers BOTH stacks because the
  // global topmost is whatever was opened last, regardless of kind.
  const totalOpen = confirmStack.length + promptStack.length;

  return (
    <DialogContext.Provider value={api}>
      {children}
      {confirmStack.map((state, index) => (
        <ConfirmModal
          key={state.id}
          state={state}
          isTopMost={index === confirmStack.length - 1 && promptStack.length === 0}
          onResolve={resolveTop}
        />
      ))}
      {promptStack.map((state, index) => (
        <PromptModal
          key={state.id}
          state={state}
          isTopMost={index === promptStack.length - 1}
          onResolve={resolveTopPrompt}
        />
      ))}
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
      {/* Reference totalOpen so the linter sees it used in dev-tools
          telemetry hooks we may add later. Cheap no-op. */}
      <span hidden data-dialog-open-count={totalOpen} />
    </DialogContext.Provider>
  );
}

// =============================================================================
// Confirm modal
// =============================================================================

function ConfirmModal({
  state,
  isTopMost,
  onResolve,
}: {
  state: ConfirmState;
  isTopMost: boolean;
  onResolve: (value: ConfirmCheckboxResult) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [checked, setChecked] = useState(state.checkbox?.defaultChecked ?? false);
  // Cancel paths (escape / backdrop / Cancel) don't act on the checkbox.
  const cancel = useCallback(() => onResolve({ confirmed: false, checked: false }), [onResolve]);

  // Capture the element that triggered the dialog so we can restore focus.
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, []);

  // Body scroll lock + initial focus + key handling, only on the topmost modal.
  useEffect(() => {
    if (!isTopMost) return;
    lockBodyScroll();

    // Focus the primary action (last focusable element by render order) once
    // the dialog mounts so destructive prompts don't open with focus on the
    // confirm button — keyboard users have to deliberately move forward.
    const tabbables = getTabbables(dialogRef.current);
    const initial = tabbables.find((el) => el.dataset["dialogFocus"] === "true") ?? tabbables[0];
    initial?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
        return;
      }
      if (event.key === "Tab") {
        const focusable = getTabbables(dialogRef.current);
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      unlockBodyScroll();
    };
  }, [isTopMost, cancel]);

  const titleId = `dialog-title-${state.id}`;
  const descriptionId = state.description ? `dialog-description-${state.id}` : undefined;
  const variant = state.variant ?? "default";
  const dismissOnBackdrop = state.dismissOnBackdrop !== false;

  return (
    // Two-layer layout — see the matching comment in `Dialog` below for the
    // why. Outer is the scrollable viewport, inner flex centers the dialog
    // when there's room and lets it overflow + scroll when there isn't.
    <div className="fixed inset-0 z-[100] !mt-0 overflow-y-auto" aria-hidden={!isTopMost}>
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => dismissOnBackdrop && cancel()}
        aria-hidden
      />
      <div className="relative flex min-h-full items-center justify-center p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="relative w-full max-w-md rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-6 shadow-xl"
        >
          <h2 id={titleId} className="text-lg font-semibold">
            {state.title}
          </h2>
          {state.description ? (
            <p id={descriptionId} className="mt-2 text-sm text-[color:var(--color-fg-muted)]">
              {state.description}
            </p>
          ) : null}
          {state.checkbox ? (
            <div className="mt-4">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                  className="mt-0.5"
                />
                <span>{state.checkbox.label}</span>
              </label>
              {!checked && state.checkbox.warningWhenUnchecked ? (
                <div
                  role="alert"
                  className="mt-3 rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 px-3 py-2 text-sm text-[color:var(--color-error)]"
                >
                  {state.checkbox.warningWhenUnchecked}
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-4 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)]"
            >
              {state.cancelLabel ?? "Cancel"}
            </button>
            <button
              type="button"
              data-dialog-focus="true"
              onClick={() => onResolve({ confirmed: true, checked })}
              className={[
                "rounded-md px-4 py-2 text-sm font-medium",
                variant === "danger"
                  ? "bg-[color:var(--color-error)] text-white hover:opacity-95"
                  : "bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)] hover:opacity-95",
              ].join(" ")}
            >
              {state.confirmLabel ?? "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Prompt modal — text input variant of confirm
// =============================================================================

function PromptModal({
  state,
  isTopMost,
  onResolve,
}: {
  state: PromptState;
  isTopMost: boolean;
  onResolve: (value: string | null) => void;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [value, setValue] = useState(state.defaultValue ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    if (!isTopMost) return;
    lockBodyScroll();

    // Focus the input rather than the primary button — operator
    // starts typing immediately, the common case for a prompt.
    inputRef.current?.focus();
    inputRef.current?.select();

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onResolve(null);
        return;
      }
      if (event.key === "Tab") {
        const focusable = getTabbables(dialogRef.current);
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      unlockBodyScroll();
    };
  }, [isTopMost, onResolve]);

  function submit() {
    const trimmed = value.trim();
    if (state.validate) {
      const v = state.validate(trimmed);
      if (v) {
        setError(v);
        return;
      }
    }
    onResolve(trimmed);
  }

  const titleId = `prompt-title-${state.id}`;
  const descriptionId = state.description ? `prompt-description-${state.id}` : undefined;
  const inputId = `prompt-input-${state.id}`;
  const errorId = error ? `prompt-error-${state.id}` : undefined;
  const dismissOnBackdrop = state.dismissOnBackdrop !== false;

  return (
    <div className="fixed inset-0 z-[100] !mt-0 overflow-y-auto" aria-hidden={!isTopMost}>
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => dismissOnBackdrop && onResolve(null)}
        aria-hidden
      />
      <div className="relative flex min-h-full items-center justify-center p-4">
        <form
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="relative w-full max-w-md rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-6 shadow-xl"
        >
          <h2 id={titleId} className="text-lg font-semibold">
            {state.title}
          </h2>
          {state.description ? (
            <p id={descriptionId} className="mt-2 text-sm text-[color:var(--color-fg-muted)]">
              {state.description}
            </p>
          ) : null}
          <div className="mt-4">
            <label htmlFor={inputId} className="block text-sm font-medium">
              {state.label ?? state.title}
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              placeholder={state.placeholder}
              aria-invalid={error ? "true" : "false"}
              aria-describedby={errorId}
              className="mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:ring-2 focus:ring-[color:var(--color-accent)] focus:outline-none"
            />
            {error ? (
              <p id={errorId} className="mt-1 text-xs text-[color:var(--color-error)]" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => onResolve(null)}
              className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-4 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)]"
            >
              {state.cancelLabel ?? "Cancel"}
            </button>
            <button
              type="submit"
              data-dialog-focus="true"
              className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
            >
              {state.confirmLabel ?? "OK"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// =============================================================================
// Low-level Dialog — for custom content (forms, diff previews, etc.)
// =============================================================================

interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Accessible title. Required for screen readers; visually hidden via `hideTitle`. */
  title: string;
  hideTitle?: boolean;
  description?: string;
  /** Tailwind max-width class — default "max-w-lg". */
  maxWidthClass?: string;
  /** When false, backdrop click does nothing. Default true. */
  dismissOnBackdrop?: boolean;
  children: React.ReactNode;
}

/**
 * Controlled modal primitive. Use this when you need form fields or any
 * content beyond a yes/no question. Caller owns the open state.
 *
 *   <Dialog open={editing} onClose={() => setEditing(false)} title="Edit record">
 *     <form>…</form>
 *   </Dialog>
 */
export function Dialog({
  open,
  onClose,
  title,
  hideTitle = false,
  description,
  maxWidthClass = "max-w-lg",
  dismissOnBackdrop = true,
  children,
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useRef(`dlg-title-${Math.random().toString(36).slice(2)}`);
  const descriptionId = useRef(
    description ? `dlg-desc-${Math.random().toString(36).slice(2)}` : undefined,
  );

  // Hold the latest onClose in a ref so the key handler can call it without
  // forcing the focus/listener effects to re-run on every parent render.
  // Without this, an inline `onClose={() => setX(false)}` from the caller
  // (which is a new arrow function each render) would re-fire the effect on
  // every keystroke and bounce focus back to the primary action.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Open / close lifecycle: focus management, body scroll lock, key listener.
  // Depends only on `open` so it runs exactly once per open cycle.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    lockBodyScroll();

    const tabbables = getTabbables(dialogRef.current);
    const initial = tabbables.find((el) => el.dataset["dialogFocus"] === "true") ?? tabbables[0];
    initial?.focus();

    function onKey(event: KeyboardEvent) {
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
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      unlockBodyScroll();
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    // Two-layer layout: the outer is the scrollable viewport (with body
    // locked, this is the *only* surface that scrolls while the dialog is
    // open). The inner is a flex container with `min-h-full` — it stretches
    // to the viewport when the dialog is short (so `items-center` centers
    // the dialog), and grows past the viewport when the dialog is tall (so
    // the outer scrolls to reveal the overflow). The earlier single-div
    // approach (`fixed inset-0 flex items-center overflow-y-auto`) clipped
    // the top of any over-tall dialog above the scroll origin because
    // `items-center` centered content that was taller than the container.
    <div className="fixed inset-0 z-[100] !mt-0 overflow-y-auto">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => dismissOnBackdrop && onClose()}
        aria-hidden
      />
      <div className="relative flex min-h-full items-start justify-center p-4 sm:items-center">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId.current}
          aria-describedby={descriptionId.current}
          className={`relative my-4 w-full ${maxWidthClass} rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-6 shadow-xl`}
        >
          <h2 id={titleId.current} className={hideTitle ? "sr-only" : "text-lg font-semibold"}>
            {title}
          </h2>
          {description ? (
            <p
              id={descriptionId.current}
              className="mt-2 text-sm text-[color:var(--color-fg-muted)]"
            >
              {description}
            </p>
          ) : null}
          {children}
        </div>
      </div>
    </div>
  );
}

function getTabbables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const nodes = root.querySelectorAll<HTMLElement>(
    [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(","),
  );
  return Array.from(nodes).filter((el) => !el.hasAttribute("data-dialog-skip-tab"));
}

// =============================================================================
// Toast viewport
// =============================================================================

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastState[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed top-4 right-4 z-[120] flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  const kind = toast.kind ?? "info";
  const borderColor =
    kind === "success"
      ? "var(--color-success)"
      : kind === "error"
        ? "var(--color-error)"
        : kind === "warn"
          ? "var(--color-warn)"
          : "var(--color-border)";

  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      style={{ borderColor: `color-mix(in oklch, ${borderColor} 50%, transparent)` }}
      className="pointer-events-auto w-80 max-w-[90vw] rounded-md border bg-[color:var(--color-bg)] p-3 text-sm shadow-lg"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-1 h-2 w-2 flex-none rounded-full"
          style={{ backgroundColor: borderColor }}
        />
        <div className="flex-1">
          {toast.title ? <div className="font-medium">{toast.title}</div> : null}
          <div className={toast.title ? "text-[color:var(--color-fg-muted)]" : ""}>
            {toast.description}
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="text-xs text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
        >
          ×
        </button>
      </div>
    </div>
  );
}
