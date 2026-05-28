import { describe, expect, it } from "vitest";
import { startRegistration } from "./registration";
import type { ResolvedWebauthnConfig } from "./config";

const CONFIG: ResolvedWebauthnConfig = {
  rpId: "dns.example.com",
  rpName: "Example DNS",
  expectedOrigins: ["https://dns.example.com"],
  userVerification: "preferred",
  attestation: "none",
};

const USER = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "alice@example.com",
  name: "Alice",
};

describe("startRegistration", () => {
  it("returns a challenge plus options that bind to the configured RP", async () => {
    const result = await startRegistration({
      config: CONFIG,
      user: USER,
      existingCredentials: [],
    });
    expect(typeof result.challenge).toBe("string");
    expect(result.challenge.length).toBeGreaterThan(20);
    expect(result.options.rp.id).toBe("dns.example.com");
    expect(result.options.rp.name).toBe("Example DNS");
    expect(result.options.user.name).toBe("alice@example.com");
  });

  it("populates excludeCredentials when the user already has credentials", async () => {
    const result = await startRegistration({
      config: CONFIG,
      user: USER,
      existingCredentials: [
        { id: "abc123", transports: ["usb", "nfc"] },
        { id: "def456", transports: ["internal"] },
      ],
    });
    expect(result.options.excludeCredentials).toHaveLength(2);
    expect(result.options.excludeCredentials?.[0]?.id).toBe("abc123");
    expect(result.options.excludeCredentials?.[1]?.transports).toEqual(["internal"]);
  });

  it("threads attestation type from config", async () => {
    const direct = await startRegistration({
      config: { ...CONFIG, attestation: "direct" },
      user: USER,
      existingCredentials: [],
    });
    expect(direct.options.attestation).toBe("direct");
  });

  it("threads userVerification through authenticatorSelection", async () => {
    const required = await startRegistration({
      config: { ...CONFIG, userVerification: "required" },
      user: USER,
      existingCredentials: [],
    });
    expect(required.options.authenticatorSelection?.userVerification).toBe("required");
  });
});
