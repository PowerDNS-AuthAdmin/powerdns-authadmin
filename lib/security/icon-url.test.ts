import { describe, expect, it } from "vitest";
import { isSafeIconUrl, safeIconUrl } from "./icon-url";

describe("safeIconUrl", () => {
  it("accepts absolute http(s) URLs", () => {
    expect(safeIconUrl("https://cdn.example.com/logo.svg")).toBe(
      "https://cdn.example.com/logo.svg",
    );
    expect(safeIconUrl("http://cdn.example.com/logo.png")).toBe("http://cdn.example.com/logo.png");
  });

  it("accepts inline base64 data:image URIs", () => {
    const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    expect(safeIconUrl(gif)).toBe(gif);
    const svg = "data:image/svg+xml;base64,PHN2Zy8+";
    expect(safeIconUrl(svg)).toBe(svg);
  });

  it("trims surrounding whitespace so the checked value is the rendered value", () => {
    // The whole point of returning a value rather than a boolean: a caller
    // can't validate one string and render a different one (#113).
    expect(safeIconUrl("  https://cdn.example.com/logo.svg  ")).toBe(
      "https://cdn.example.com/logo.svg",
    );
  });

  it("rejects script-bearing and non-image schemes", () => {
    expect(safeIconUrl("javascript:alert(1)")).toBeNull();
    expect(safeIconUrl("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeIconUrl("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeIconUrl("vbscript:msgbox(1)")).toBeNull();
    expect(safeIconUrl("file:///etc/passwd")).toBeNull();
  });

  it("rejects relative and protocol-relative values", () => {
    expect(safeIconUrl("//evil.example.com/logo.svg")).toBeNull();
    expect(safeIconUrl("/logo.svg")).toBeNull();
    expect(safeIconUrl("logo.svg")).toBeNull();
    expect(safeIconUrl("")).toBeNull();
  });

  it("rejects a data:image URI whose payload isn't clean base64", () => {
    // The previous regex stopped at the `;base64,` prefix and accepted any
    // trailing bytes, so a payload could smuggle arbitrary characters.
    expect(safeIconUrl('data:image/svg+xml;base64,"><script>alert(1)</script>')).toBeNull();
    expect(safeIconUrl("data:image/png;base64,")).toBeNull();
  });

  it("rejects a data:image URI that isn't base64-encoded", () => {
    expect(safeIconUrl("data:image/svg+xml,<svg onload=alert(1)>")).toBeNull();
  });

  it("rejects malformed http(s) URLs that only look right by prefix", () => {
    // A bare prefix check passed these; parsing does not.
    expect(safeIconUrl("https://")).toBeNull();
  });

  it("normalizes the scheme before matching, so case tricks don't slip through", () => {
    // The URL parser lower-cases the protocol, so the allowlist sees a
    // canonical value rather than whatever casing was typed.
    expect(safeIconUrl("HTTPS://cdn.example.com/logo.svg")).toBe(
      "https://cdn.example.com/logo.svg",
    );
    expect(safeIconUrl("JAVASCRIPT:alert(1)")).toBeNull();
  });

  it("rejects a non-image data: type even when the payload is valid base64", () => {
    expect(safeIconUrl("data:application/javascript;base64,YWxlcnQoMSk=")).toBeNull();
  });
});

describe("isSafeIconUrl", () => {
  it("agrees with safeIconUrl", () => {
    expect(isSafeIconUrl("https://cdn.example.com/logo.svg")).toBe(true);
    expect(isSafeIconUrl("javascript:alert(1)")).toBe(false);
  });
});
