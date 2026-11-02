// @vitest-environment jsdom

/**
 * components/domain/token-reveal.dom.test.tsx
 *
 * The new-token panel: the plain token leads with its own Copy, the client
 * snippets start folded, and the setup hint appears only when the deployment
 * configured one.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogProvider } from "@/components/ui/dialog";
import { TokenReveal, type TokenRevealHint } from "./token-reveal";

const TOKEN = "pda_pat_EXAMPLEonlyEXAMPLEonlyEXAMPLE01";

describe("TokenReveal", () => {
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
    vi.restoreAllMocks();
  });

  function render(hint: TokenRevealHint | null, onDone = () => undefined) {
    act(() =>
      root.render(
        <DialogProvider>
          <TokenReveal
            token={TOKEN}
            name="ci-pipeline"
            appUrl="https://dns.example.com"
            hint={hint}
            onDone={onDone}
          />
        </DialogProvider>,
      ),
    );
  }

  function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === label,
    );
    if (!found) throw new Error(`no button "${label}"`);
    return found;
  }

  it("shows the plain token with its own Copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(null);
    expect(container.querySelector("[data-testid=token-value]")!.textContent).toBe(TOKEN);
    await act(async () => {
      button("Copy token").click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(TOKEN);
    expect(container.textContent).toContain("Copied ✓");
  });

  it("starts with the snippets folded", () => {
    render(null);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toContain("(advanced)");
    expect(details.textContent).toContain("--scope user");
  });

  it("shows no hint unless one is configured", () => {
    render(null);
    expect(container.querySelector("[data-testid=token-setup-hint]")).toBeNull();
  });

  it("shows the configured hint, linked, and points the advanced section at it", () => {
    render({
      command: "acme-setup",
      text: "Paste just this token when acme-setup asks for it. That's all you need.",
      url: "https://docs.example.com/setup",
    });
    const hint = container.querySelector("[data-testid=token-setup-hint]")!;
    const link = hint.querySelector("a")!;
    expect(link.textContent).toContain("acme-setup");
    expect(link.getAttribute("href")).toBe("https://docs.example.com/setup");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(hint.textContent).toContain("That's all you need.");
    expect(container.querySelector("summary")!.textContent).toContain(
      "Other ways to connect (advanced)",
    );
  });

  it("falls back to a default sentence and an unlinked badge", () => {
    render({ command: "acme-setup", text: null, url: null });
    const hint = container.querySelector("[data-testid=token-setup-hint]")!;
    expect(hint.querySelector("a")).toBeNull();
    expect(hint.textContent).toContain("Paste just this token when acme-setup asks for it.");
  });

  it("calls onDone from Done", () => {
    const onDone = vi.fn();
    render(null, onDone);
    act(() => button("Done").click());
    expect(onDone).toHaveBeenCalledOnce();
  });
});
