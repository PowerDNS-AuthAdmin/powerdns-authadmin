// @vitest-environment jsdom

/**
 * components/ui/row-disclosure.dom.test.tsx
 *
 * The row accordion keeps one row open per table, and the chevron is wired to
 * its panel the way a screen reader expects: `aria-expanded` for the state,
 * `aria-controls` naming the panel, and an accessible name that says which
 * way the toggle will go.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DisclosureChevron,
  RowDisclosurePanel,
  rowDetailId,
  useRowDisclosure,
} from "./row-disclosure";

const ROWS = [
  { id: "a", label: "alpha" },
  { id: "b", label: "beta" },
];

function Harness() {
  const details = useRowDisclosure();
  return (
    <ul>
      {ROWS.map((row) => (
        <li key={row.id} data-row={row.id}>
          <DisclosureChevron
            open={details.isOpen(row.id)}
            onToggle={() => details.toggle(row.id)}
            label={row.label}
            controls={rowDetailId("t-", row.id)}
            data-test-chevron={row.id}
          />
          {details.isOpen(row.id) ? (
            <RowDisclosurePanel id={rowDetailId("t-", row.id)} label={`Details for ${row.label}`}>
              body of {row.label}
            </RowDisclosurePanel>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

describe("row disclosure", () => {
  let container: HTMLDivElement;
  let root: Root;

  const chevron = (id: string) =>
    container.querySelector<HTMLButtonElement>(`[data-row="${id}"] button`)!;
  const panels = () => container.querySelectorAll("[role=region]");

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

  it("starts with every row collapsed", () => {
    expect(panels().length).toBe(0);
    expect(chevron("a").getAttribute("aria-expanded")).toBe("false");
    expect(chevron("b").getAttribute("aria-expanded")).toBe("false");
  });

  it("opens one row at a time: opening B closes A", () => {
    act(() => chevron("a").click());
    expect(chevron("a").getAttribute("aria-expanded")).toBe("true");
    expect(panels().length).toBe(1);
    expect(panels()[0]!.textContent).toBe("body of alpha");

    act(() => chevron("b").click());
    expect(chevron("a").getAttribute("aria-expanded")).toBe("false");
    expect(chevron("b").getAttribute("aria-expanded")).toBe("true");
    expect(panels().length).toBe(1);
    expect(panels()[0]!.textContent).toBe("body of beta");
  });

  it("collapses the open row when its chevron is pressed again", () => {
    act(() => chevron("a").click());
    act(() => chevron("a").click());
    expect(chevron("a").getAttribute("aria-expanded")).toBe("false");
    expect(panels().length).toBe(0);
  });

  it("wires aria-controls to the panel it reveals", () => {
    const controls = chevron("a").getAttribute("aria-controls");
    expect(controls).toBe("t-detail-a");
    act(() => chevron("a").click());
    const panel = container.querySelector(`#${controls}`)!;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute("role")).toBe("region");
    expect(panel.getAttribute("aria-label")).toBe("Details for alpha");
  });

  it("flips its accessible name between Show and Hide", () => {
    expect(chevron("a").getAttribute("aria-label")).toBe("Show details for alpha");
    act(() => chevron("a").click());
    expect(chevron("a").getAttribute("aria-label")).toBe("Hide details for alpha");
  });

  it("passes data attributes through to the button", () => {
    expect(chevron("b").getAttribute("data-test-chevron")).toBe("b");
  });

  it("makes a panel id safe for whitespace in the row id", () => {
    expect(rowDetailId("p-", "a b\tc")).toBe("p-detail-a-b-c");
  });
});
