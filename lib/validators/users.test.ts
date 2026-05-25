import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, signupSchema } from "./users";

const validPassword = "a".repeat(MIN_PASSWORD_LENGTH);

describe("signupSchema", () => {
  it("accepts a valid email + policy-compliant password", () => {
    const parsed = signupSchema.parse({ email: "user@example.com", password: validPassword });
    expect(parsed.email).toBe("user@example.com");
    expect(parsed.password).toBe(validPassword);
    expect(parsed.name).toBeUndefined();
  });

  it("rejects an invalid email", () => {
    expect(() => signupSchema.parse({ email: "not-an-email", password: validPassword })).toThrow();
  });

  it("rejects a password shorter than the policy minimum", () => {
    const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);
    const result = signupSchema.safeParse({ email: "user@example.com", password: short });
    expect(result.success).toBe(false);
  });

  it("trims a provided name and keeps it", () => {
    const parsed = signupSchema.parse({
      email: "user@example.com",
      password: validPassword,
      name: "  Ada Lovelace  ",
    });
    expect(parsed.name).toBe("Ada Lovelace");
  });

  it("normalises a whitespace-only name to undefined", () => {
    const parsed = signupSchema.parse({
      email: "user@example.com",
      password: validPassword,
      name: "   ",
    });
    expect(parsed.name).toBeUndefined();
  });

  it("accepts an optional captcha token", () => {
    const parsed = signupSchema.parse({
      email: "user@example.com",
      password: validPassword,
      captchaToken: "tok",
    });
    expect(parsed.captchaToken).toBe("tok");
  });

  it("rejects an over-long name", () => {
    const result = signupSchema.safeParse({
      email: "user@example.com",
      password: validPassword,
      name: "x".repeat(121),
    });
    expect(result.success).toBe(false);
  });
});
