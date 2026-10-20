// @vitest-environment jsdom

/**
 * components/ui/toggle-chip.dom.test.tsx
 *
 * The chip is a toggle button: `aria-pressed` is the state assistive tech
 * reads, and the count either shows a number or holds the space with a
 * skeleton while it is still unknown.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToggleChip } from "./toggle-chip";

describe("ToggleChip", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("exposes its state through aria-pressed", () => {
    act(() =>
      root.render(
        <ToggleChip active tone="warn" title="Warnings" onClick={() => undefined} count={3}>
          Warn
        </ToggleChip>,
      ),
    );
    const button = container.querySelector("button")!;
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("title")).toBe("Warnings");

    act(() =>
      root.render(
        <ToggleChip active={false} tone="warn" title="Warnings" onClick={() => undefined} count={3}>
          Warn
        </ToggleChip>,
      ),
    );
    expect(container.querySelector("button")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("renders the label and the count as text", () => {
    act(() =>
      root.render(
        <ToggleChip active tone="success" title="Healthy" onClick={() => undefined} count={12}>
          OK
        </ToggleChip>,
      ),
    );
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("OK12");
    expect(button.querySelector(".tabular-nums")?.textContent).toBe("12");
    expect(button.querySelector("[role=status]")).toBeNull();
  });

  it("holds the count's place with a skeleton while it is unknown", () => {
    act(() =>
      root.render(
        <ToggleChip active tone="error" title="Errors" onClick={() => undefined} count={null}>
          Error
        </ToggleChip>,
      ),
    );
    const button = container.querySelector("button")!;
    const skeleton = button.querySelector("[role=status]");
    expect(skeleton).not.toBeNull();
    expect(skeleton!.getAttribute("aria-label")).toBe("Counting…");
    expect(button.querySelector(".tabular-nums")).toBeNull();
  });

  it("calls onClick when pressed", () => {
    const onClick = vi.fn();
    act(() =>
      root.render(
        <ToggleChip active={false} tone="muted" title="Info" onClick={onClick} count={0}>
          Info
        </ToggleChip>,
      ),
    );
    act(() => container.querySelector("button")!.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
