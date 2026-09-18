/**
 * lib/client/form-dom.ts
 *
 * Helpers for controlled forms whose fields can be filled without React
 * hearing about it.
 *
 * A server-rendered form is real, focusable HTML the moment it paints. The
 * browser accepts keystrokes and a password manager will happily fill it long
 * before the client bundle arrives and React attaches its `onChange`
 * handlers. Anything that lands in that window reaches the DOM and nothing
 * else: hydration then binds to already-filled inputs while state still holds
 * its initial `""`. `required` passes (the browser validates the DOM), the
 * submit handler serialises the empty state, and the re-render that follows
 * writes those empty strings back into the fields - blanking what the visitor
 * typed. On the login form that surfaced as a flat "Invalid request body."
 * against an empty-looking form (#139).
 *
 * Reading the DOM closes the gap from both ends: `useDomFieldSync` adopts
 * pre-hydration input on mount, and `readFormFields` re-reads at submit time
 * so a later autofill can't slip past either. Both key off the `name`
 * attribute, so any field they cover needs one.
 */

import "client-only";
import { useEffect, useRef, type RefObject } from "react";

/**
 * Current DOM values of `names`, straight off the form element.
 *
 * A name with no matching field - or one whose element carries no string
 * `value` - reads as `""` rather than throwing, so a caller can ask for a
 * field that only renders in some states.
 */
export function readFormFields<K extends string>(
  form: HTMLFormElement,
  names: readonly K[],
): Record<K, string> {
  const values = {} as Record<K, string>;
  for (const name of names) {
    const field: unknown = form.elements.namedItem(name);
    values[name] =
      typeof field === "object" &&
      field !== null &&
      "value" in field &&
      typeof field.value === "string"
        ? field.value
        : "";
  }
  return values;
}

/**
 * Adopt values the form already held when React arrived.
 *
 * Runs once, right after hydration: for every `name` in `setters`, a
 * non-empty DOM value is pushed into the matching state setter. Empty fields
 * are skipped so this can't clobber a default the component itself supplied.
 *
 * Mount-only is the point - re-running would fight the user's own edits - so
 * the setters are captured from the first render and later identities are
 * ignored. `useState` setters are stable, which is what callers pass.
 */
export function useDomFieldSync(
  formRef: RefObject<HTMLFormElement | null>,
  setters: Readonly<Record<string, (value: string) => void>>,
): void {
  const initialSetters = useRef(setters).current;

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const values = readFormFields(form, Object.keys(initialSetters));
    for (const [name, setValue] of Object.entries(initialSetters)) {
      const value = values[name];
      if (value) setValue(value);
    }
  }, [formRef, initialSetters]);
}
