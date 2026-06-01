import { describe, expect, it } from "vitest";
import { emailDomainAllowed, resolveAllowedDomains } from "./email-domain-allowlist";

describe("emailDomainAllowed", () => {
  it("passes through everything when the allow-list is empty (back-compat)", () => {
    expect(emailDomainAllowed("anyone@anywhere.example", [])).toEqual({
      ok: true,
      domain: "anywhere.example",
    });
  });

  it("accepts an exact match", () => {
    expect(emailDomainAllowed("alice@example.com", ["example.com"])).toEqual({
      ok: true,
      domain: "example.com",
    });
  });

  it("is case-insensitive on the domain", () => {
    expect(emailDomainAllowed("Alice@EXAMPLE.com", ["example.com"])).toEqual({
      ok: true,
      domain: "example.com",
    });
  });

  it("rejects a partial suffix match (`evil-example.com` ≠ `example.com`)", () => {
    expect(emailDomainAllowed("attacker@evil-example.com", ["example.com"])).toEqual({
      ok: false,
      domain: "evil-example.com",
    });
  });

  it("rejects a subdomain that isn't explicitly listed", () => {
    expect(emailDomainAllowed("alice@sub.example.com", ["example.com"])).toEqual({
      ok: false,
      domain: "sub.example.com",
    });
  });

  it("accepts the subdomain when it IS explicitly listed", () => {
    expect(emailDomainAllowed("alice@sub.example.com", ["example.com", "sub.example.com"])).toEqual(
      { ok: true, domain: "sub.example.com" },
    );
  });

  it("emits the (no-@-in-email) sentinel for unparseable inputs", () => {
    expect(emailDomainAllowed("no-at-sign-here", ["example.com"])).toEqual({
      ok: false,
      domain: "(no-@-in-email)",
    });
  });

  it("treats an empty domain part as unparseable", () => {
    expect(emailDomainAllowed("alice@", ["example.com"])).toEqual({
      ok: false,
      domain: "(no-@-in-email)",
    });
  });

  it("uses the rightmost @ to extract the domain", () => {
    // Per RFC 5321 the local part can contain quoted @-signs. We're
    // pragmatic here - pick the last @ - which is what every IdP we care
    // about parses too.
    expect(emailDomainAllowed('"weird@local"@example.com', ["example.com"])).toEqual({
      ok: true,
      domain: "example.com",
    });
  });
});

describe("resolveAllowedDomains", () => {
  it("returns the env default when the provider override is null (inherit)", () => {
    expect(resolveAllowedDomains(null, ["example.com"])).toEqual(["example.com"]);
    expect(resolveAllowedDomains(null, [])).toEqual([]);
  });

  it("returns the provider override when it is non-empty (replace, not append)", () => {
    expect(resolveAllowedDomains(["override.example"], ["env.example"])).toEqual([
      "override.example",
    ]);
  });

  it("returns an explicit empty override even when env imposes a list", () => {
    // "[]" at the provider level means "no restriction here" - used
    // for a public-signup provider on an otherwise-locked-down
    // server. Distinct from `null` (inherit env).
    expect(resolveAllowedDomains([], ["env.example"])).toEqual([]);
  });

  it("composes with emailDomainAllowed end-to-end", () => {
    // Verify the resolver + matcher work together as the OIDC
    // callback uses them.
    const effective = resolveAllowedDomains(["acme.com"], ["env.example"]);
    expect(emailDomainAllowed("alice@acme.com", effective)).toEqual({
      ok: true,
      domain: "acme.com",
    });
    expect(emailDomainAllowed("attacker@env.example", effective)).toEqual({
      ok: false,
      domain: "env.example",
    });
  });
});
