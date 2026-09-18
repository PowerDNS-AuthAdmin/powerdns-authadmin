/**
 * lib/client/form-dom.test.ts
 *
 * The unit suite runs in a Node environment with no DOM, so these tests drive
 * `readFormFields` through a structural stand-in for the one API it uses -
 * `form.elements.namedItem`. That covers the lookup and coercion rules; the
 * hydration race the helper exists to fix needs a real browser and is covered
 * by tests/e2e/pre-hydration-input.spec.ts.
 */

import { describe, expect, it } from "vitest";
import { readFormFields } from "./form-dom";

/** A form whose named fields resolve to the given elements. */
function fakeForm(fields: Record<string, unknown>): HTMLFormElement {
  return {
    elements: {
      namedItem: (name: string) => (name in fields ? fields[name] : null),
    },
  } as unknown as HTMLFormElement;
}

describe("readFormFields", () => {
  it("reads each named field's current DOM value", () => {
    const form = fakeForm({
      email: { value: "operator@example.test" },
      password: { value: "correct horse battery staple" },
    });

    expect(readFormFields(form, ["email", "password"])).toEqual({
      email: "operator@example.test",
      password: "correct horse battery staple",
    });
  });

  it("returns only the requested names", () => {
    const form = fakeForm({
      email: { value: "operator@example.test" },
      password: { value: "hunter2" },
    });

    expect(readFormFields(form, ["email"])).toEqual({ email: "operator@example.test" });
  });

  it("reads an empty field as an empty string", () => {
    const form = fakeForm({ email: { value: "" } });

    expect(readFormFields(form, ["email"])).toEqual({ email: "" });
  });

  it("falls back to an empty string when no field carries the name", () => {
    const form = fakeForm({ email: { value: "operator@example.test" } });

    expect(readFormFields(form, ["email", "captchaToken"])).toEqual({
      email: "operator@example.test",
      captchaToken: "",
    });
  });

  it("falls back to an empty string when the named element has no string value", () => {
    // A <fieldset>, or a name shared by several non-input elements, resolves
    // to something without a usable `value` - read it as blank, don't throw.
    const form = fakeForm({ group: {}, count: { value: 12 }, missing: null });

    expect(readFormFields(form, ["group", "count", "missing"])).toEqual({
      group: "",
      count: "",
      missing: "",
    });
  });
});
