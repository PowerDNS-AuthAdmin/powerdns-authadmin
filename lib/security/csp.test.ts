/**
 * lib/security/csp.test.ts
 *
 * Guards the script-src shape that issue #28 was about: under 'strict-dynamic',
 * 'self' and host-sources are ignored by CSP3 browsers, so listing them is dead
 * weight that emits a console warning. They must NOT appear in script-src.
 */

import { describe, expect, it } from "vitest";
import { buildCsp } from "./csp";

const NONCE = "test-nonce-abc123";
const TURNSTILE = "https://challenges.cloudflare.com";

/** Parse a CSP header string into { directive: [sources] }. */
function parse(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}

describe("buildCsp — script-src under strict-dynamic", () => {
  it("does NOT include 'self' in script-src (it's ignored under strict-dynamic — issue #28)", () => {
    for (const dev of [false, true]) {
      for (const turnstile of [false, true]) {
        const d = parse(buildCsp(NONCE, dev, turnstile));
        expect(d["script-src"]).not.toContain("'self'");
        expect(d["script-src"]).not.toContain("'unsafe-inline'");
      }
    }
  });

  it("authorizes scripts via nonce + strict-dynamic only", () => {
    const d = parse(buildCsp(NONCE, false, false));
    expect(d["script-src"]).toContain(`'nonce-${NONCE}'`);
    expect(d["script-src"]).toContain("'strict-dynamic'");
  });

  it("keeps 'unsafe-eval' in dev only (strict-dynamic does not ignore it)", () => {
    expect(parse(buildCsp(NONCE, true, false))["script-src"]).toContain("'unsafe-eval'");
    expect(parse(buildCsp(NONCE, false, false))["script-src"]).not.toContain("'unsafe-eval'");
  });

  it("never puts the Turnstile origin in script-src (ignored under strict-dynamic)", () => {
    // Even with the captcha enabled — the loader carries the nonce instead.
    expect(parse(buildCsp(NONCE, false, true))["script-src"]).not.toContain(TURNSTILE);
  });
});

describe("buildCsp — Turnstile origin on honored directives", () => {
  it("adds the Turnstile origin to frame-src + connect-src when enabled", () => {
    const d = parse(buildCsp(NONCE, false, true));
    expect(d["frame-src"]).toContain(TURNSTILE);
    expect(d["connect-src"]).toContain(TURNSTILE);
  });

  it("omits it everywhere when the captcha is disabled", () => {
    const csp = buildCsp(NONCE, false, false);
    expect(csp).not.toContain(TURNSTILE);
  });
});

describe("buildCsp — baseline hardening stays intact", () => {
  it("keeps the strict non-script directives", () => {
    const d = parse(buildCsp(NONCE, false, false));
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'self'"]);
    expect(d["form-action"]).toEqual(["'self'"]);
    // valueless directive is emitted bare (no sources)
    expect(d["upgrade-insecure-requests"]).toEqual([]);
  });
});
