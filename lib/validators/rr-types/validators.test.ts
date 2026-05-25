/**
 * lib/validators/rr-types/validators.test.ts
 *
 * Smoke tests for the per-type validators. Each test asserts at least one
 * "good" case and one "bad" case so a regression on the registry surface
 * fails loudly. RFC-edge cases (warning-only paths) get a couple of cases
 * for the most operationally relevant types (A, MX, TXT).
 */

import { describe, expect, it } from "vitest";
import { extractQuotedStrings } from "@/lib/dns/txt";
import { aValidator } from "./a";
import { aaaaValidator } from "./aaaa";
import { caaValidator } from "./caa";
import { cnameValidator } from "./cname";
import { dnameValidator } from "./dname";
import { dsValidator } from "./ds";
import { mxValidator } from "./mx";
import { naptrValidator } from "./naptr";
import { nsValidator } from "./ns";
import { openpgpkeyValidator } from "./openpgpkey";
import { ptrValidator } from "./ptr";
import { srvValidator } from "./srv";
import { smimeaValidator } from "./smimea";
import { sshfpValidator } from "./sshfp";
import { httpsValidator, svcbValidator } from "./svcb";
import { tlsaValidator } from "./tlsa";
import { txtValidator } from "./txt";
import { uriValidator } from "./uri";
import { getRRTypeValidator, hasErrors, SUPPORTED_TYPES } from "./index";

describe("A validator", () => {
  it("accepts a globally routable IPv4", () => {
    const r = aValidator.validate("192.0.2.1");
    expect(hasErrors(r)).toBe(false);
    expect(r.normalized).toBe("192.0.2.1");
  });

  it("rejects malformed IPv4", () => {
    expect(hasErrors(aValidator.validate("not.an.ip"))).toBe(true);
    expect(hasErrors(aValidator.validate("256.0.0.1"))).toBe(true);
  });

  it("warns on loopback / link-local / multicast / reserved", () => {
    expect(aValidator.validate("127.0.0.1").issues[0]?.level).toBe("warning");
    expect(aValidator.validate("169.254.1.1").issues[0]?.level).toBe("warning");
    expect(aValidator.validate("224.0.0.1").issues[0]?.level).toBe("warning");
    expect(aValidator.validate("240.0.0.1").issues[0]?.level).toBe("warning");
  });
});

describe("AAAA validator", () => {
  it("accepts and canonicalizes compressed IPv6", () => {
    const r = aaaaValidator.validate("2001:0db8::0001");
    expect(hasErrors(r)).toBe(false);
    expect(r.normalized).toBe("2001:db8::1");
  });

  it("rejects malformed IPv6", () => {
    expect(hasErrors(aaaaValidator.validate("2001:db8:::1"))).toBe(true);
    expect(hasErrors(aaaaValidator.validate("g001::1"))).toBe(true);
  });

  it("warns on loopback / link-local / ULA", () => {
    expect(aaaaValidator.validate("::1").issues[0]?.level).toBe("warning");
    expect(aaaaValidator.validate("fe80::1").issues[0]?.level).toBe("warning");
    expect(aaaaValidator.validate("fc00::1").issues[0]?.level).toBe("warning");
  });

  it("rejects a fully-specified address that still contains :: (RFC 4291 § 2.2.2)", () => {
    // '::' must represent one or more zero groups; when all 8 groups are
    // explicit there is no room for even one zero group — this is malformed.
    expect(hasErrors(aaaaValidator.validate("1:2:3:4:5:6:7:8::"))).toBe(true);
    expect(hasErrors(aaaaValidator.validate("::1:2:3:4:5:6:7:8"))).toBe(true);
  });
});

describe("CNAME validator", () => {
  it("accepts a fully-qualified target", () => {
    const r = cnameValidator.validate("target.example.com.");
    expect(hasErrors(r)).toBe(false);
    expect(r.normalized).toBe("target.example.com.");
  });

  it("warns when the target looks like an IP", () => {
    const r = cnameValidator.validate("192.0.2.1");
    expect(r.issues.some((i) => i.message.includes("IP address"))).toBe(true);
  });

  it("warns when trailing dot is missing", () => {
    const r = cnameValidator.validate("target.example.com");
    expect(r.issues.some((i) => i.message.includes("trailing dot"))).toBe(true);
    expect(r.normalized).toBe("target.example.com.");
  });
});

describe("MX validator", () => {
  it("accepts a typical MX", () => {
    const r = mxValidator.validate("10 mail.example.com.");
    expect(hasErrors(r)).toBe(false);
    expect(r.normalized).toBe("10 mail.example.com.");
  });

  it("recognises RFC 7505 Null MX", () => {
    const r = mxValidator.validate("0 .");
    expect(hasErrors(r)).toBe(false);
  });

  it("rejects malformed shapes", () => {
    expect(hasErrors(mxValidator.validate("mail.example.com."))).toBe(true);
    expect(hasErrors(mxValidator.validate("10"))).toBe(true);
    expect(hasErrors(mxValidator.validate("99999 mail.example.com."))).toBe(true);
  });
});

describe("NS / PTR validators (hostname-based)", () => {
  it("NS accepts a fully-qualified hostname", () => {
    expect(hasErrors(nsValidator.validate("ns1.example.com."))).toBe(false);
  });

  it("PTR accepts a fully-qualified hostname", () => {
    expect(hasErrors(ptrValidator.validate("host.example.com."))).toBe(false);
  });
});

describe("SRV validator", () => {
  it("accepts a typical SRV", () => {
    const r = srvValidator.validate("10 5 443 service.example.com.");
    expect(hasErrors(r)).toBe(false);
  });

  it("rejects wrong token count", () => {
    expect(hasErrors(srvValidator.validate("10 5 443"))).toBe(true);
    expect(hasErrors(srvValidator.validate("10 5 443 service.example.com. extra"))).toBe(true);
  });

  it("rejects port > 65535 as an error (16-bit field, RFC 2782)", () => {
    // port=70000 overflows the 16-bit wire field — this must be an error,
    // not merely a warning, because the value cannot be encoded.
    const r = srvValidator.validate("10 5 70000 service.example.com.");
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("0–65535"))).toBe(true);
  });

  it("warns on port 0 but does not error", () => {
    // Port 0 is encodable (fits in 16 bits) but operationally unusual.
    const r = srvValidator.validate("10 5 0 service.example.com.");
    expect(r.issues.some((i) => i.level === "warning")).toBe(true);
    expect(r.issues.some((i) => i.level === "error")).toBe(false);
  });
});

describe("TXT validator", () => {
  it("accepts a quoted character-string", () => {
    expect(hasErrors(txtValidator.validate('"v=spf1 -all"'))).toBe(false);
  });

  it("auto-quotes bare text with a warning", () => {
    const r = txtValidator.validate("v=spf1 -all");
    expect(hasErrors(r)).toBe(false);
    expect(r.normalized.startsWith('"')).toBe(true);
    expect(r.issues.some((i) => i.message.includes("double quotes"))).toBe(true);
  });

  it("warns on oversize character-string", () => {
    const long = `"${"a".repeat(300)}"`;
    const r = txtValidator.validate(long);
    expect(r.issues.some((i) => i.message.includes("255"))).toBe(true);
  });

  it('escapes \\ before " when auto-quoting bare text (RFC 1035 § 5.1 escape order)', () => {
    // Regression for issue #2: the old code escaped `"` first, then `\`,
    // so the backslash inserted by the quote pass got doubled. The value
    // `a "b" c\d` must round-trip through extractQuotedStrings back to the
    // original bare string.
    const raw = 'a "b" c\\d';
    const r = txtValidator.validate(raw);
    expect(hasErrors(r)).toBe(false);
    // Normalized form must be a quoted string.
    expect(r.normalized.startsWith('"')).toBe(true);
    expect(r.normalized.endsWith('"')).toBe(true);
    // Round-trip: parsing the normalized value must recover the original.
    const parsed = extractQuotedStrings(r.normalized);
    expect(parsed).not.toBeNull();
    expect(parsed![0]).toBe(raw);
  });
});

describe("CAA validator", () => {
  it("accepts a typical CAA issue", () => {
    const r = caaValidator.validate('0 issue "letsencrypt.org"');
    expect(hasErrors(r)).toBe(false);
  });

  it("rejects bad shapes", () => {
    expect(hasErrors(caaValidator.validate("issue letsencrypt.org"))).toBe(true);
    expect(hasErrors(caaValidator.validate('256 issue "x"'))).toBe(true);
  });

  it("warns on unknown tag", () => {
    const r = caaValidator.validate('0 customtag "value"');
    expect(r.issues.some((i) => i.message.includes("not in the IANA"))).toBe(true);
  });

  it("re-quotes a leading-only quote (unbalanced) into a balanced string", () => {
    // A value like `"letsencrypt.org` (opening quote, no closing quote) is
    // unbalanced — passing it through verbatim would produce malformed wire
    // data. The validator must wrap it so the output is balanced.
    const r = caaValidator.validate('0 issue "letsencrypt.org');
    expect(hasErrors(r)).toBe(false); // unbalanced quote is a warning, not an error
    const normalized = r.normalized;
    // normalized value field must start and end with '"' and be balanced.
    const valueField = normalized.split(" ").slice(2).join(" ");
    expect(valueField.startsWith('"')).toBe(true);
    expect(valueField.endsWith('"')).toBe(true);
    expect(valueField.length).toBeGreaterThanOrEqual(2);
  });

  it("escapes backslashes (not just quotes) when quoting a bare value", () => {
    // A bare value containing `\` must have it escaped before being wrapped —
    // leaving it raw emits malformed wire data (CodeQL js/incomplete-sanitization).
    const r = caaValidator.validate("0 issue ca\\corp");
    const valueField = r.normalized.split(" ").slice(2).join(" ");
    expect(valueField).toBe('"ca\\\\corp"'); // \  →  \\  inside the quoted string
  });

  it("escapes backslash before quote in a bare value (correct order)", () => {
    const r = caaValidator.validate('0 issue a\\b"c');
    const valueField = r.normalized.split(" ").slice(2).join(" ");
    // a\b"c  →  "a\\b\"c"  — backslash doubled, quote escaped, neither doubled twice.
    expect(valueField).toBe('"a\\\\b\\"c"');
  });
});

describe("DS validator", () => {
  // Real DS record for `example.com.` (digest-type 2 / SHA-256 — 64 hex chars).
  const VALID_SHA256 = "12345 13 2 " + "a".repeat(64);

  it("accepts a canonical SHA-256 DS record", () => {
    const r = dsValidator.validate(VALID_SHA256);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.normalized).toBe("12345 13 2 " + "a".repeat(64));
  });

  it("rejects fewer than 4 parts", () => {
    expect(
      dsValidator
        .validate("12345 13 2")
        .issues.some((i) => i.level === "error" && i.message.includes("four parts")),
    ).toBe(true);
  });

  it("rejects key-tag outside 0-65535", () => {
    const r = dsValidator.validate(`70000 13 2 ${"a".repeat(64)}`);
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("Key tag"))).toBe(true);
  });

  it("rejects non-numeric algorithm", () => {
    const r = dsValidator.validate(`12345 X 2 ${"a".repeat(64)}`);
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("Algorithm"))).toBe(true);
  });

  it("warns on out-of-common algorithm but doesn't error", () => {
    // Algorithm 3 (DSA/SHA1) is in range 1-255 but not in COMMON_ALGORITHMS.
    const r = dsValidator.validate(`12345 3 2 ${"a".repeat(64)}`);
    expect(
      r.issues.some((i) => i.level === "warning" && i.message.includes("commonly-deployed")),
    ).toBe(true);
    expect(r.issues.some((i) => i.level === "error")).toBe(false);
  });

  it("rejects digest hex length mismatch for known digest-type", () => {
    // digest-type 2 (SHA-256) requires 64 hex chars; passing 40 is wrong.
    const r = dsValidator.validate(`12345 13 2 ${"a".repeat(40)}`);
    expect(
      r.issues.some((i) => i.level === "error" && i.message.includes("requires 64 hex characters")),
    ).toBe(true);
  });

  it("normalizes whitespace inside the digest (registrar paste artifact)", () => {
    // Registrars sometimes print the digest in 8-char groups separated
    // by spaces. The validator strips them and lowercases.
    const spaced = "12345 13 2 " + "AA BB CC DD".repeat(8); // 64 hex chars
    const r = dsValidator.validate(spaced);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.normalized).toBe("12345 13 2 " + "aabbccdd".repeat(8));
  });

  it("rejects non-hex characters in the digest", () => {
    const r = dsValidator.validate(`12345 13 2 ${"z".repeat(64)}`);
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("hex"))).toBe(true);
  });

  it("warns on SHA-1 digest-type (deprecated)", () => {
    // digest-type 1 (SHA-1) — 40 hex chars; structurally valid but
    // deprecated. The validator emits a warning, not an error.
    const r = dsValidator.validate(`12345 8 1 ${"a".repeat(40)}`);
    expect(r.issues.some((i) => i.level === "error")).toBe(false);
    expect(r.issues.some((i) => i.level === "warning" && i.message.includes("deprecated"))).toBe(
      true,
    );
  });

  it("warns on unknown digest-type (5+) but doesn't error", () => {
    const r = dsValidator.validate(`12345 13 7 ${"a".repeat(64)}`);
    expect(
      r.issues.some((i) => i.level === "warning" && i.message.includes("rarely deployed")),
    ).toBe(true);
    expect(r.issues.some((i) => i.level === "error")).toBe(false);
  });

  it("normalizes uppercase hex to lowercase", () => {
    const r = dsValidator.validate(`12345 13 2 ${"A".repeat(64)}`);
    expect(r.normalized.endsWith("a".repeat(64))).toBe(true);
  });
});

describe("SSHFP validator", () => {
  // Ed25519 + SHA-256 — the modern combo `ssh-keygen -r` emits by default.
  const VALID_ED25519_SHA256 = `4 2 ${"a".repeat(64)}`;

  it("accepts a canonical Ed25519/SHA-256 record", () => {
    const r = sshfpValidator.validate(VALID_ED25519_SHA256);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.normalized).toBe(`4 2 ${"a".repeat(64)}`);
  });

  it("rejects fewer than 3 parts", () => {
    expect(
      sshfpValidator
        .validate("4 2")
        .issues.some((i) => i.level === "error" && i.message.includes("three parts")),
    ).toBe(true);
  });

  it("warns on deprecated DSA algorithm (2)", () => {
    const r = sshfpValidator.validate(`2 2 ${"a".repeat(64)}`);
    expect(r.issues.some((i) => i.level === "error")).toBe(false);
    expect(r.issues.some((i) => i.level === "warning" && i.message.includes("deprecated"))).toBe(
      true,
    );
  });

  it("warns on out-of-registry algorithm", () => {
    // Algorithm 5 is unallocated in the IANA SSHFP registry.
    const r = sshfpValidator.validate(`5 2 ${"a".repeat(64)}`);
    expect(r.issues.some((i) => i.level === "warning" && i.message.includes("IANA"))).toBe(true);
    expect(r.issues.some((i) => i.level === "error")).toBe(false);
  });

  it("warns on deprecated SHA-1 fingerprint-type (1) and accepts its 40-char length", () => {
    const r = sshfpValidator.validate(`4 1 ${"a".repeat(40)}`);
    // No length error — 40 chars is correct for SHA-1.
    expect(r.issues.some((i) => i.level === "error")).toBe(false);
    // But SHA-1 is deprecated per RFC 6594.
    expect(r.issues.some((i) => i.level === "warning" && i.message.includes("deprecated"))).toBe(
      true,
    );
  });

  it("rejects wrong fingerprint length for the declared fp-type", () => {
    // SHA-256 requires 64 hex chars; passing 40 is wrong.
    const r = sshfpValidator.validate(`4 2 ${"a".repeat(40)}`);
    expect(
      r.issues.some((i) => i.level === "error" && i.message.includes("requires 64 hex characters")),
    ).toBe(true);
  });

  it("normalizes whitespace inside the fingerprint (ssh-keygen line-wrap artifact)", () => {
    // ssh-keygen sometimes emits the fp split across continued lines.
    const spaced = `4 2 ${"AA BB CC DD ".repeat(8).trim()}`; // 64 hex chars
    const r = sshfpValidator.validate(spaced);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.normalized).toBe(`4 2 ${"aabbccdd".repeat(8)}`);
  });

  it("rejects non-hex characters", () => {
    const r = sshfpValidator.validate(`4 2 ${"z".repeat(64)}`);
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("hex"))).toBe(true);
  });

  it("warns on unknown fingerprint-type (3+)", () => {
    const r = sshfpValidator.validate(`4 3 ${"a".repeat(64)}`);
    expect(r.issues.some((i) => i.level === "warning" && i.message.includes("RFC 6594"))).toBe(
      true,
    );
    expect(r.issues.some((i) => i.level === "error")).toBe(false);
  });
});

describe("TLSA validator", () => {
  // DANE-EE + SPKI + SHA-256 — the most-deployed combo for service certs.
  const VALID_DANE_EE_SPKI_SHA256 = `3 1 1 ${"a".repeat(64)}`;

  it("accepts a canonical DANE-EE/SPKI/SHA-256 record", () => {
    const r = tlsaValidator.validate(VALID_DANE_EE_SPKI_SHA256);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.normalized).toBe(`3 1 1 ${"a".repeat(64)}`);
  });

  it("rejects fewer than 4 parts", () => {
    expect(
      tlsaValidator
        .validate("3 1 1")
        .issues.some((i) => i.level === "error" && i.message.includes("four parts")),
    ).toBe(true);
  });

  it("rejects non-numeric usage", () => {
    const r = tlsaValidator.validate(`X 1 1 ${"a".repeat(64)}`);
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("Usage"))).toBe(true);
  });

  it("warns on out-of-RFC-7218 usage (4+)", () => {
    const r = tlsaValidator.validate(`4 1 1 ${"a".repeat(64)}`);
    expect(r.issues.some((i) => i.level === "warning" && i.message.includes("RFC 7218"))).toBe(
      true,
    );
    expect(r.issues.some((i) => i.level === "error")).toBe(false);
  });

  it("warns on undefined selector (2+)", () => {
    const r = tlsaValidator.validate(`3 5 1 ${"a".repeat(64)}`);
    expect(r.issues.some((i) => i.level === "warning" && i.message.includes("Selector"))).toBe(
      true,
    );
  });

  it("rejects wrong hex length for matching-type 1 (SHA-256)", () => {
    // SHA-256 requires 64 hex chars; passing 32 is wrong.
    const r = tlsaValidator.validate(`3 1 1 ${"a".repeat(32)}`);
    expect(
      r.issues.some((i) => i.level === "error" && i.message.includes("requires 64 hex characters")),
    ).toBe(true);
  });

  it("accepts SHA-512 with the 128-hex-char length", () => {
    const r = tlsaValidator.validate(`3 1 2 ${"a".repeat(128)}`);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("rejects wrong length for SHA-512", () => {
    const r = tlsaValidator.validate(`3 1 2 ${"a".repeat(64)}`);
    expect(
      r.issues.some(
        (i) => i.level === "error" && i.message.includes("requires 128 hex characters"),
      ),
    ).toBe(true);
  });

  it("warns on short cert-data for matching-type 0 (Full)", () => {
    // matching-type 0 is variable-length but should be a full cert in
    // hex — hundreds of chars. 64 is suspicious.
    const r = tlsaValidator.validate(`3 1 0 ${"a".repeat(64)}`);
    expect(
      r.issues.some((i) => i.level === "warning" && i.message.includes("hundreds of hex")),
    ).toBe(true);
    expect(r.issues.some((i) => i.level === "error")).toBe(false);
  });

  it("accepts a long matching-type 0 without warning", () => {
    const r = tlsaValidator.validate(`3 1 0 ${"a".repeat(400)}`);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.issues.some((i) => i.message.includes("hundreds of hex"))).toBe(false);
  });

  it("warns on unknown matching-type (3+)", () => {
    const r = tlsaValidator.validate(`3 1 5 ${"a".repeat(64)}`);
    expect(r.issues.some((i) => i.level === "warning" && i.message.includes("RFC 6698"))).toBe(
      true,
    );
  });

  it("normalizes whitespace inside cert-data (paste artifact)", () => {
    const spaced = `3 1 1 ${"AA BB CC DD ".repeat(8).trim()}`; // 64 hex chars
    const r = tlsaValidator.validate(spaced);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.normalized).toBe(`3 1 1 ${"aabbccdd".repeat(8)}`);
  });

  it("rejects non-hex characters", () => {
    const r = tlsaValidator.validate(`3 1 1 ${"z".repeat(64)}`);
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("hex"))).toBe(true);
  });
});

describe("SVCB / HTTPS validators", () => {
  it("accepts a canonical HTTP/3-advertising HTTPS record", () => {
    const r = httpsValidator.validate("1 . alpn=h2,h3 port=443");
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("accepts an AliasMode record (priority 0, target only)", () => {
    const r = svcbValidator.validate("0 svcb.example.com.");
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("rejects AliasMode with SvcParams (RFC 9460 § 2.4.2)", () => {
    const r = svcbValidator.validate("0 svcb.example.com. alpn=h2");
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("AliasMode"))).toBe(true);
  });

  it("rejects fewer than 2 parts", () => {
    expect(
      svcbValidator
        .validate("1")
        .issues.some((i) => i.level === "error" && i.message.includes("priority")),
    ).toBe(true);
  });

  it("rejects priority > 65535", () => {
    const r = svcbValidator.validate("70000 . alpn=h2");
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("Priority"))).toBe(true);
  });

  it("rejects duplicate SvcParam keys", () => {
    const r = svcbValidator.validate("1 . alpn=h2 alpn=h3");
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("more than once"))).toBe(
      true,
    );
  });

  it("warns on unknown SvcParam key", () => {
    const r = svcbValidator.validate("1 . unknownkey=value");
    expect(
      r.issues.some((i) => i.level === "warning" && i.message.includes("common IANA set")),
    ).toBe(true);
  });

  it("rejects non-uint16 port", () => {
    const r = svcbValidator.validate("1 . port=99999");
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("uint16"))).toBe(true);
  });

  it("warns when boolean SvcParam carries a value (no-default-alpn=1)", () => {
    const r = svcbValidator.validate("1 . no-default-alpn=1");
    expect(
      r.issues.some((i) => i.level === "warning" && i.message.includes("shouldn't carry a value")),
    ).toBe(true);
  });

  it("accepts bare boolean no-default-alpn", () => {
    const r = svcbValidator.validate("1 . no-default-alpn alpn=h2");
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.issues.some((i) => i.message.includes("shouldn't carry"))).toBe(false);
  });

  it("rejects comma-list keys with empty value (`alpn=`)", () => {
    const r = svcbValidator.validate("1 . alpn=");
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("comma"))).toBe(true);
  });

  it("HTTPS and SVCB share the validate function (identity-fields differ)", () => {
    // Both validators behave the same on the same input.
    const input = "1 . alpn=h2,h3 ipv4hint=192.0.2.1";
    expect(httpsValidator.validate(input).issues).toEqual(svcbValidator.validate(input).issues);
    // But identity fields differ.
    expect(httpsValidator.type).toBe("HTTPS");
    expect(svcbValidator.type).toBe("SVCB");
  });
});

describe("OPENPGPKEY validator", () => {
  // A short valid-base64 string (length multiple of 4). Decodes to
  // 300 bytes — plausibly key-sized so no length warning fires.
  const LONG_BASE64 = "A".repeat(400); // 400 / 4 * 3 = 300 bytes decoded

  it("accepts a plausibly-sized base64 blob", () => {
    const r = openpgpkeyValidator.validate(LONG_BASE64);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(r.issues.some((i) => i.level === "warning")).toBe(false);
  });

  it("rejects empty content", () => {
    expect(
      openpgpkeyValidator
        .validate("")
        .issues.some((i) => i.level === "error" && i.message.includes("empty")),
    ).toBe(true);
  });

  it("rejects whitespace-only content", () => {
    expect(
      openpgpkeyValidator
        .validate("   \n  \t  ")
        .issues.some((i) => i.level === "error" && i.message.includes("empty")),
    ).toBe(true);
  });

  it("rejects URL-safe base64 (`-`/`_`) — RFC 7929 uses standard base64", () => {
    const urlsafe = "A-B_CDEF"; // length 8, multiple of 4
    const r = openpgpkeyValidator.validate(urlsafe);
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("URL-safe"))).toBe(true);
  });

  it("rejects non-base64 characters", () => {
    const r = openpgpkeyValidator.validate("!@#$%^&*");
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("base64"))).toBe(true);
  });

  it("rejects length not divisible by 4 (truncated paste)", () => {
    expect(
      openpgpkeyValidator
        .validate("ABC")
        .issues.some((i) => i.level === "error" && i.message.includes("multiple of 4")),
    ).toBe(true);
  });

  it("warns on suspiciously short decoded length", () => {
    // 16 chars of base64 → 12 bytes decoded → well under 50-byte
    // sanity threshold.
    const r = openpgpkeyValidator.validate("AAAAAAAAAAAAAAAA");
    expect(r.issues.some((i) => i.level === "warning" && i.message.includes("bytes"))).toBe(true);
    expect(r.issues.some((i) => i.level === "error")).toBe(false);
  });

  it("strips whitespace before validation (gpg --export | base64 default wrap)", () => {
    // `base64` without -w0 wraps every 76 chars; the validator
    // strips the newlines transparently.
    const wrapped = LONG_BASE64.match(/.{1,76}/g)!.join("\n");
    const r = openpgpkeyValidator.validate(wrapped);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    // Normalized output is compact (newlines gone).
    expect(r.normalized).toBe(LONG_BASE64);
  });

  it("accepts padded base64 (== and = endings)", () => {
    // Length 400 with `==` padding → 298 bytes decoded; with `=`
    // padding → 299. Both well over the 50-byte threshold.
    const padDouble = "A".repeat(398) + "==";
    const padSingle = "A".repeat(399) + "=";
    expect(
      openpgpkeyValidator.validate(padDouble).issues.filter((i) => i.level === "error"),
    ).toEqual([]);
    expect(
      openpgpkeyValidator.validate(padSingle).issues.filter((i) => i.level === "error"),
    ).toEqual([]);
  });
});

describe("URI validator", () => {
  it("accepts a canonical URI record (HTTPS target)", () => {
    const r = uriValidator.validate('10 1 "https://example.com/path"');
    expect(hasErrors(r)).toBe(false);
  });

  it("accepts a SIP target (typical ENUM-replacement use)", () => {
    const r = uriValidator.validate('10 1 "sip:info@example.com"');
    expect(hasErrors(r)).toBe(false);
  });

  it("rejects fewer than 3 parts", () => {
    expect(
      uriValidator
        .validate("10 1")
        .issues.some((i) => i.level === "error" && i.message.includes("three parts")),
    ).toBe(true);
  });

  it("rejects unquoted target", () => {
    expect(
      uriValidator
        .validate("10 1 https://example.com/")
        .issues.some((i) => i.level === "error" && i.message.includes("double-quoted")),
    ).toBe(true);
  });

  it("rejects non-numeric priority", () => {
    expect(
      uriValidator
        .validate('X 1 "https://example.com/"')
        .issues.some((i) => i.level === "error" && i.message.includes("Priority")),
    ).toBe(true);
  });

  it("rejects priority > 65535", () => {
    expect(
      uriValidator
        .validate('70000 1 "https://example.com/"')
        .issues.some((i) => i.level === "error" && i.message.includes("Priority")),
    ).toBe(true);
  });

  it("rejects weight > 65535", () => {
    expect(
      uriValidator
        .validate('10 70000 "https://example.com/"')
        .issues.some((i) => i.level === "error" && i.message.includes("Weight")),
    ).toBe(true);
  });

  it("rejects empty target string (RFC 7553 § 4.5)", () => {
    expect(
      uriValidator
        .validate('10 1 ""')
        .issues.some((i) => i.level === "error" && i.message.includes("cannot be empty")),
    ).toBe(true);
  });

  it("warns when target has no scheme (URI-reference not URI)", () => {
    const r = uriValidator.validate('10 1 "/relative/path"');
    expect(r.issues.some((i) => i.level === "warning" && i.message.includes("scheme-less"))).toBe(
      true,
    );
    expect(r.issues.some((i) => i.level === "error")).toBe(false);
  });

  it("accepts a target containing spaces (URI may contain percent-encoded spaces)", () => {
    // The quote-aware regex must accept spaces inside the target.
    const r = uriValidator.validate('10 1 "https://example.com/with space/index"');
    expect(hasErrors(r)).toBe(false);
  });
});

describe("SMIMEA validator", () => {
  // RFC 8162 wire format identical to TLSA — the validator
  // delegates to TLSA's validate. Tests here pin (a) the identity
  // fields (type, label, RFC citation distinct from TLSA) and (b)
  // the delegation actually works on a canonical record.
  it("identity fields are SMIMEA-specific, not inherited from TLSA", () => {
    expect(smimeaValidator.type).toBe("SMIMEA");
    expect(smimeaValidator.rfc).toContain("RFC 8162");
    expect(smimeaValidator.label).toContain("SMIMEA");
  });

  it("delegates content validation to TLSA's logic (same wire format)", () => {
    // Canonical SHA-256-of-SPKI form: usage=3 selector=1 type=1
    // + 64 hex chars. Should pass with no errors — same as TLSA
    // accepts.
    const r = smimeaValidator.validate(`3 1 1 ${"a".repeat(64)}`);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("inherits TLSA's hex-length error for matching-type mismatch", () => {
    // Pinning the delegation: TLSA's length check fires for SMIMEA
    // exactly the same way.
    const r = smimeaValidator.validate(`3 1 1 ${"a".repeat(32)}`);
    expect(
      r.issues.some((i) => i.level === "error" && i.message.includes("requires 64 hex characters")),
    ).toBe(true);
  });
});

describe("DNAME validator", () => {
  it("accepts a fully-qualified target", () => {
    const r = dnameValidator.validate("example.net.");
    expect(hasErrors(r)).toBe(false);
    expect(r.normalized).toBe("example.net.");
  });

  it("warns when the target looks like an IPv4 address", () => {
    const r = dnameValidator.validate("192.0.2.1");
    expect(r.issues.some((i) => i.message.includes("IP address"))).toBe(true);
  });

  it("warns when the target looks like an IPv6 address", () => {
    const r = dnameValidator.validate("2001:db8::1");
    expect(r.issues.some((i) => i.message.includes("IP address"))).toBe(true);
  });

  it("warns when trailing dot is missing (and normalizes)", () => {
    const r = dnameValidator.validate("example.net");
    expect(r.issues.some((i) => i.message.includes("trailing dot"))).toBe(true);
    expect(r.normalized).toBe("example.net.");
  });
});

describe("NAPTR validator", () => {
  // Classic ENUM-style NAPTR: terminal U flag, SIP service, regexp
  // rewrites to a SIP URI.
  const ENUM_NAPTR = '100 10 "U" "E2U+sip" "!^.*$!sip:info@example.com!" .';

  it("accepts a canonical ENUM NAPTR record", () => {
    const r = naptrValidator.validate(ENUM_NAPTR);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("accepts an S-NAPTR record (regexp empty, replacement non-dot)", () => {
    const r = naptrValidator.validate('100 10 "S" "SIP+D2U" "" _sip._udp.example.com.');
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("rejects wrong token count", () => {
    expect(
      naptrValidator
        .validate("100 10")
        .issues.some((i) => i.level === "error" && i.message.includes("6 parts")),
    ).toBe(true);
  });

  it("rejects unterminated quoted string in regexp", () => {
    // Missing trailing quote in services field.
    expect(
      naptrValidator
        .validate('100 10 "S" "SIP+D2U "" _sip._udp.example.com.')
        .issues.some((i) => i.level === "error" && i.message.includes("tokenize")),
    ).toBe(true);
  });

  it("rejects non-numeric order/preference", () => {
    expect(
      naptrValidator
        .validate('X 10 "S" "SIP+D2U" "" _sip._udp.example.com.')
        .issues.some((i) => i.level === "error" && i.message.includes("Order")),
    ).toBe(true);
    expect(
      naptrValidator
        .validate('100 Y "S" "SIP+D2U" "" _sip._udp.example.com.')
        .issues.some((i) => i.level === "error" && i.message.includes("Preference")),
    ).toBe(true);
  });

  it("rejects order > 65535", () => {
    expect(
      naptrValidator
        .validate('70000 10 "S" "SIP+D2U" "" _sip._udp.example.com.')
        .issues.some((i) => i.level === "error" && i.message.includes("Order")),
    ).toBe(true);
  });

  it("rejects unquoted flags / services / regexp", () => {
    // Flags is `S` instead of `"S"` — tokenizer reads it as
    // unquoted, then stripQuotes returns null and the error fires.
    expect(
      naptrValidator
        .validate('100 10 S "SIP+D2U" "" _sip._udp.example.com.')
        .issues.some((i) => i.level === "error" && i.message.includes("Flags")),
    ).toBe(true);
  });

  it("warns on multi-character flags", () => {
    const r = naptrValidator.validate('100 10 "SU" "SIP+D2U" "" _sip._udp.example.com.');
    expect(r.issues.some((i) => i.level === "warning" && i.message.includes("longer than"))).toBe(
      true,
    );
  });

  it("warns on unknown flag letter outside {S,A,U,P}", () => {
    const r = naptrValidator.validate('100 10 "Z" "SIP+D2U" "" _sip._udp.example.com.');
    expect(
      r.issues.some((i) => i.level === "warning" && i.message.includes("not in the common set")),
    ).toBe(true);
  });

  it("rejects regexp without enough delimited parts", () => {
    // "!a!b" → split gives [, a, b] (3 parts) — missing the third
    // delimited section (flags), so the helper rejects.
    const r = naptrValidator.validate('100 10 "U" "E2U+sip" "!a!b" .');
    expect(r.issues.some((i) => i.level === "error" && i.message.includes("three delimited"))).toBe(
      true,
    );
  });

  it("rejects both regexp and replacement empty (record points nowhere)", () => {
    const r = naptrValidator.validate('100 10 "S" "SIP+D2U" "" .');
    expect(
      r.issues.some((i) => i.level === "error" && i.message.includes("cannot both be empty")),
    ).toBe(true);
  });

  it("warns when both regexp and replacement are non-empty", () => {
    const r = naptrValidator.validate(
      '100 10 "U" "E2U+sip" "!^.*$!sip:x@y.example!" _sip._udp.example.com.',
    );
    expect(
      r.issues.some((i) => i.level === "warning" && i.message.includes("regexp takes precedence")),
    ).toBe(true);
  });

  it("warns when replacement lacks a trailing dot (and isn't `.`)", () => {
    const r = naptrValidator.validate('100 10 "S" "SIP+D2U" "" _sip._udp.example.com');
    expect(r.issues.some((i) => i.level === "warning" && i.message.includes("trailing dot"))).toBe(
      true,
    );
  });

  it("accepts empty flags + non-empty regexp + replacement `.`", () => {
    // Flags can legitimately be empty when the record is a pure
    // regexp rewrite step with no terminal classification.
    const r = naptrValidator.validate('100 10 "" "E2U+sip" "!^.*$!sip:x@y.example!" .');
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("registry", () => {
  it("returns a real validator for each supported type", () => {
    for (const t of SUPPORTED_TYPES) {
      expect(getRRTypeValidator(t).type).toBe(t);
    }
  });

  it("returns a generic fallback for unknown types", () => {
    // HINFO is a real but rarely-used type without a typed validator
    // in this project. If a future tick adds one, swap the type here
    // for another still-unknown one (KX, DHCID, AFSDB, RP, LOC, ...).
    const r = getRRTypeValidator("HINFO");
    expect(r.type).toBe("HINFO");
    // Generic emits a warning that type-aware checks aren't available.
    const result = r.validate("intel-mac OSX");
    expect(result.issues.some((i) => i.level === "warning")).toBe(true);
  });
});
