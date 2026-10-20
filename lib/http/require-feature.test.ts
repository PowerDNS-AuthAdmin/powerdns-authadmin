import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  optionalFeatures: { zoneMonitoring: false, reverseDns: true },
}));

import { NotFoundError } from "@/lib/errors";
import { requireFeature } from "./require-feature";

describe("requireFeature", () => {
  it("answers 404 for a disabled feature and passes an enabled one", () => {
    expect(() => requireFeature("zoneMonitoring")).toThrow(NotFoundError);
    expect(() => requireFeature("reverseDns")).not.toThrow();
  });
});
