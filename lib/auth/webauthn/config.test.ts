import { describe, expect, it } from "vitest";
import { resolveWebauthnConfig } from "./config";

const BASE = {
  appUrl: "https://dns.example.com",
  rpIdOverride: undefined,
  rpNameOverride: undefined,
  siteName: null,
  userVerification: "preferred" as const,
  attestation: "none" as const,
  allowInsecureOrigins: false,
};

describe("resolveWebauthnConfig", () => {
  it("derives rpId from APP_URL hostname when no override is set", () => {
    const c = resolveWebauthnConfig({ ...BASE });
    expect(c.rpId).toBe("dns.example.com");
  });

  it("honours WEBAUTHN_RP_ID override (apex-domain sharing case)", () => {
    const c = resolveWebauthnConfig({ ...BASE, rpIdOverride: "example.com" });
    expect(c.rpId).toBe("example.com");
    expect(c.expectedOrigins).toContain("https://example.com");
    expect(c.expectedOrigins).toContain("https://dns.example.com");
  });

  it("falls back rpName: override > siteName > literal 'PowerDNS-AuthAdmin'", () => {
    expect(resolveWebauthnConfig({ ...BASE }).rpName).toBe("PowerDNS-AuthAdmin");
    expect(resolveWebauthnConfig({ ...BASE, siteName: "Acme DNS" }).rpName).toBe("Acme DNS");
    expect(
      resolveWebauthnConfig({ ...BASE, siteName: "Acme DNS", rpNameOverride: "Acme (Prod)" })
        .rpName,
    ).toBe("Acme (Prod)");
  });

  it("trims whitespace on string overrides", () => {
    expect(resolveWebauthnConfig({ ...BASE, rpIdOverride: "  example.com  " }).rpId).toBe(
      "example.com",
    );
    expect(resolveWebauthnConfig({ ...BASE, rpNameOverride: "  Acme  " }).rpName).toBe("Acme");
  });

  it("expectedOrigins always contains the APP_URL origin and https://<rpId>", () => {
    const c = resolveWebauthnConfig({ ...BASE });
    expect(c.expectedOrigins).toContain("https://dns.example.com");
  });

  it("does NOT include http:// origins when allowInsecureOrigins=false", () => {
    const c = resolveWebauthnConfig({ ...BASE });
    expect(c.expectedOrigins.every((o) => o.startsWith("https://"))).toBe(true);
  });

  it("includes http://<rpId> and http://localhost:3000 when allowInsecureOrigins=true", () => {
    const c = resolveWebauthnConfig({
      ...BASE,
      appUrl: "http://10.0.0.5:3000",
      allowInsecureOrigins: true,
    });
    expect(c.expectedOrigins).toContain("http://10.0.0.5");
    expect(c.expectedOrigins).toContain("http://localhost:3000");
  });

  it("passes through userVerification + attestation untouched", () => {
    const c = resolveWebauthnConfig({
      ...BASE,
      userVerification: "required",
      attestation: "direct",
    });
    expect(c.userVerification).toBe("required");
    expect(c.attestation).toBe("direct");
  });
});
