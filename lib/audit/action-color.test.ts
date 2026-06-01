import { describe, expect, it } from "vitest";
import { colorForAuditAction } from "./action-color";

describe("colorForAuditAction", () => {
  it("returns success tint for .create and .granted", () => {
    expect(colorForAuditAction("record.create")).toContain("color-success");
    expect(colorForAuditAction("role.granted")).toContain("color-success");
  });

  it("returns error tint for .delete and .revoked", () => {
    expect(colorForAuditAction("record.delete")).toContain("color-error");
    expect(colorForAuditAction("session.revoked")).toContain("color-error");
  });

  it("returns accent tint for .update and .set", () => {
    expect(colorForAuditAction("user.update")).toContain("color-accent");
    expect(colorForAuditAction("zone.metadata.set")).toContain("color-accent");
  });

  it("returns muted tint for unknown verbs", () => {
    expect(colorForAuditAction("auth.login.success")).toContain("color-fg-muted");
    expect(colorForAuditAction("anything.weird")).toContain("color-fg-muted");
  });

  it("does not match action that merely contains the verb mid-string", () => {
    // Suffix-only - `record.creates` (typo) should NOT be treated as create.
    expect(colorForAuditAction("record.creates")).toContain("color-fg-muted");
  });
});
