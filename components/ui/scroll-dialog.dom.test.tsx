// @vitest-environment jsdom

/**
 * components/ui/scroll-dialog.dom.test.tsx
 *
 * The show-all dialog is labelled, closes on Escape and backdrop, hands focus
 * back to the button that opened it, and leaves Escape to a modal stacked on
 * top of it (the confirm a bulk action opens) instead of closing underneath.
 */

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScrollDialog } from "./scroll-dialog";

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" data-opener onClick={() => setOpen(true)}>
        + 27 others
      </button>
      <ScrollDialog open={open} onClose={() => setOpen(false)} title="28 addresses">
        <button type="button">first</button>
      </ScrollDialog>
    </>
  );
}

const flushMicrotasks = () => act(async () => await Promise.resolve());

describe("ScrollDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
  const opener = () => container.querySelector<HTMLButtonElement>("[data-opener]")!;
  const pressEscape = () =>
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

  beforeEach(() => {
    (globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("opens labelled, focuses inside, and restores focus on Escape", async () => {
    opener().focus();
    act(() => opener().click());
    const el = dialog()!;
    expect(el.getAttribute("aria-modal")).toBe("true");
    const titleId = el.getAttribute("aria-labelledby")!;
    expect(document.getElementById(titleId)?.textContent).toBe("28 addresses");
    expect(el.contains(document.activeElement)).toBe(true);

    pressEscape();
    expect(dialog()).toBeNull();
    await flushMicrotasks();
    expect(document.activeElement).toBe(opener());
  });

  it("closes on a backdrop click", () => {
    act(() => opener().click());
    const backdrop = dialog()!.previousElementSibling as HTMLElement;
    act(() => backdrop.click());
    expect(dialog()).toBeNull();
  });

  it("ignores Escape while another modal is stacked on top", () => {
    act(() => opener().click());
    const stacked = document.createElement("div");
    stacked.setAttribute("aria-modal", "true");
    document.body.appendChild(stacked);
    pressEscape();
    expect(dialog()).not.toBeNull();
    stacked.remove();
    pressEscape();
    expect(dialog()).toBeNull();
  });
});
