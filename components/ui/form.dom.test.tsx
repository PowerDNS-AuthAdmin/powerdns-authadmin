// @vitest-environment jsdom

/**
 * components/ui/form.dom.test.tsx
 *
 * `Field` must keep its control mounted when a sibling appears next to it.
 * The create-zone form shows a "Stored as example.com." preview under the
 * zone-name input as soon as the value is non-empty, so the first keystroke
 * adds a sibling; if that remounts the input, focus is lost mid-word (#161).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Field } from "./form";

function fieldWithPreview(value: string) {
  return (
    <Field label="Zone name" hint="Lowercase.">
      <input value={value} onChange={() => undefined} />
      {value ? <p>Stored as {value}.</p> : null}
    </Field>
  );
}

describe("Field", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // react-dom's act() wants this flag to silence its environment warning.
    (globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps the same control mounted when a sibling appears after it", () => {
    act(() => root.render(fieldWithPreview("")));
    const before = container.querySelector("input");
    expect(before).not.toBeNull();
    before!.focus();
    expect(document.activeElement).toBe(before);

    act(() => root.render(fieldWithPreview("e")));
    const after = container.querySelector("input");
    expect(after).toBe(before);
    expect(document.activeElement).toBe(before);
    expect(container.querySelector("p:not([id])")?.textContent).toBe("Stored as e.");
  });

  it("keeps the same control mounted when the sibling goes away again", () => {
    act(() => root.render(fieldWithPreview("e")));
    const before = container.querySelector("input");
    act(() => root.render(fieldWithPreview("")));
    expect(container.querySelector("input")).toBe(before);
  });

  it("still wires the caption to the control and lists the hint", () => {
    act(() => root.render(fieldWithPreview("e")));
    const input = container.querySelector("input")!;
    const label = container.querySelector("label")!;
    expect(input.id).not.toBe("");
    expect(label.getAttribute("for")).toBe(input.id);
    const hint = container.querySelector("p[id]")!;
    expect(input.getAttribute("aria-describedby")).toBe(hint.id);
  });
});
