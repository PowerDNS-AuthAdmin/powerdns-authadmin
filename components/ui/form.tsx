"use client";

/**
 * components/ui/form.tsx
 *
 * The form primitives every settings panel, create form and editor shares:
 * `Field` (caption + control + hint + errors), the `inputClass` the text
 * controls are styled with, and `Section` (the bordered card a long form is
 * grouped into).
 *
 * `Field` wires the caption to its control for assistive technology. The
 * caller hands over a bare control; the field gives it an id (`useId`) when
 * it has none, points the `<label htmlFor>` at it and lists the hint and
 * error paragraphs in `aria-describedby`. Clicking the caption focuses the
 * control and a screen reader announces the field by name - which a
 * `<label>` with no `htmlFor` sitting next to an input never did.
 *
 * When the child is not a single labelable control (a `<div>` holding a
 * Switch and its state text, a checkbox `<label>`), the caption becomes a
 * `<span>` and the wrapper a `role="group"` labelled by it, so the name
 * still reaches the controls inside without producing a dangling `<label>`.
 *
 * Sizes keep the rhythm each surface already had:
 *   sm       standard forms (text-sm caption, text-xs hint)
 *   xs       the record editors (text-xs caption)
 *   compact  the zone-settings panels (text-xs caption with a 4px gap,
 *            11px hint)
 *   caps     uppercase muted caption (import/export)
 *   caps-xs  the 10px uppercase caption of the filter bars
 */

import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";

/** Text-control styling without the top margin - for inputs laid out in a row. */
export const inputBaseClass =
  "block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] disabled:opacity-60";

/** Text-control styling for a control sitting under a `Field` caption. */
export const inputClass = `mt-1 ${inputBaseClass}`;

export type FieldSize = "sm" | "xs" | "compact" | "caps" | "caps-xs";

const SIZE_STYLES: Record<FieldSize, { wrapper: string; caption: string; hint: string }> = {
  sm: {
    wrapper: "",
    caption: "block text-sm font-medium",
    hint: "mt-1 text-xs text-[color:var(--color-fg-muted)]",
  },
  xs: {
    wrapper: "",
    caption: "block text-xs font-medium",
    hint: "mt-1 text-xs text-[color:var(--color-fg-muted)]",
  },
  compact: {
    wrapper: "",
    caption: "mb-1 block text-xs font-medium",
    hint: "mt-1 text-[0.6875rem] text-[color:var(--color-fg-muted)]",
  },
  caps: {
    wrapper: "space-y-1.5",
    caption: "block text-xs font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase",
    hint: "text-xs text-[color:var(--color-fg-muted)]",
  },
  "caps-xs": {
    wrapper: "space-y-1",
    caption: "block text-[0.625rem] tracking-wide text-[color:var(--color-fg-muted)] uppercase",
    hint: "text-[0.625rem] text-[color:var(--color-fg-muted)]",
  },
};

export interface FieldProps {
  label: ReactNode;
  /**
   * Id for the control. Optional - a child without an id gets a generated
   * one. Pass it when something else (a test, a `prompt` default) needs to
   * find the control by id.
   */
  id?: string;
  /** Appends a red asterisk to the caption. */
  required?: boolean;
  hint?: ReactNode;
  /** Validation messages; rendered as a live `role="alert"` under the control. */
  errors?: string[];
  size?: FieldSize;
  /** Extra classes on the wrapper (grid spans, margins). */
  className?: string;
  children: ReactNode;
}

interface WireableProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
}

/** Elements the caption can't point at: containers and nested labels. */
const NON_LABELABLE_TAGS = new Set(["div", "span", "label", "ul", "ol", "fieldset", "p"]);

export function Field({
  label,
  id,
  required,
  hint,
  errors,
  size = "sm",
  className,
  children,
}: FieldProps) {
  const autoId = useId();
  const hintId = `${autoId}-hint`;
  const errorId = `${autoId}-error`;
  const captionId = `${autoId}-caption`;
  const hasErrors = errors !== undefined && errors.length > 0;
  const styles = SIZE_STYLES[size];

  // The control is the first labelable element among the children - a field
  // may also carry a preview line or a secondary note after its input, and
  // those must not swallow the label wiring.
  const parts = Children.toArray(children);
  const controlIndex = parts.findIndex(
    (part) => isValidElement<WireableProps>(part) && isLabelable(part.type),
  );
  let controlId: string | undefined;
  let control: ReactNode = children;
  if (controlIndex !== -1) {
    const target = parts[controlIndex] as ReactElement<WireableProps>;
    controlId = target.props.id ?? id ?? autoId;
    const describedBy = [
      target.props["aria-describedby"],
      hint ? hintId : null,
      hasErrors ? errorId : null,
    ]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(" ");
    const wired = cloneElement(target, {
      id: controlId,
      ...(describedBy ? { "aria-describedby": describedBy } : {}),
      ...(hasErrors && target.props["aria-invalid"] === undefined ? { "aria-invalid": true } : {}),
    });
    control = parts.length === 1 ? wired : parts.map((p, i) => (i === controlIndex ? wired : p));
  }

  const caption = (
    <>
      {label}
      {required ? <span className="text-[color:var(--color-error)]"> *</span> : null}
    </>
  );
  const wrapperClass = [styles.wrapper, className ?? ""].filter(Boolean).join(" ");

  return (
    <div
      className={wrapperClass || undefined}
      role={controlId ? undefined : "group"}
      aria-labelledby={controlId ? undefined : captionId}
    >
      {controlId ? (
        <label htmlFor={controlId} className={styles.caption}>
          {caption}
        </label>
      ) : (
        <span id={captionId} className={styles.caption}>
          {caption}
        </span>
      )}
      {control}
      {hint ? (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      ) : null}
      {hasErrors ? (
        <p id={errorId} className="mt-1 text-xs text-[color:var(--color-error)]" role="alert">
          {errors.join(" ")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Host elements are labelable unless they're known containers; a component
 * (SelectMenu, NumberInput, DateTimePicker, …) is assumed to forward `id` to
 * its focusable element, which every control under components/ui does.
 */
function isLabelable(type: unknown): boolean {
  if (typeof type === "string") return !NON_LABELABLE_TAGS.has(type);
  return typeof type === "function" || (typeof type === "object" && type !== null);
}

/** Bordered card grouping one topic of a long form, with an uppercase title. */
export function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-5">
      <header>
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">{subtitle}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}
