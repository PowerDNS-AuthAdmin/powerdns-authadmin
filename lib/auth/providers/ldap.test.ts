/**
 * lib/auth/providers/ldap.test.ts
 *
 * Unit coverage for the pure helpers exposed from `lib/auth/providers/ldap.ts`.
 * No real LDAP server is contacted here - those paths land in the
 * integration suite once we add the OpenLDAP container. The cases below
 * pin the security-critical bits:
 *
 *   • RFC 4515 §3 filter-value escaping (the SQL-injection analog for LDAP).
 *   • `{{username}}` substitution into operator-configured filters.
 *   • Validator behavior for `ldap://` vs `ldaps://` with and without
 *     `start_tls`.
 *   • Group attribute extraction from a fixture entry.
 *   • TLS options assembly with and without a CA pin.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Entry } from "ldapts";
import {
  buildTlsOptions,
  escapeLdapFilterValue,
  readEntryString,
  readEntryStringArray,
  substituteUserDn,
  substituteUsername,
} from "./ldap";

const env = process.env;

beforeEach(() => {
  vi.resetModules();
  // Defaults for the env-aware behaviour. Individual tests below override.
  process.env = {
    ...env,
    NODE_ENV: "test",
    APP_URL: "http://localhost:3000",
    APP_SECRET_KEY: "x".repeat(48),
    APP_ENCRYPTION_KEY: Buffer.from("y".repeat(48)).toString("base64"),
    DATABASE_URL: "postgres://x@y:5432/z",
    LDAP_ALLOW_INSECURE_PORT_389: "false",
    LDAP_TLS_INSECURE_SKIP_VERIFY: "false",
  };
});

afterEach(() => {
  process.env = env;
});

describe("escapeLdapFilterValue - RFC 4515 §4 test vectors", () => {
  it("escapes the five reserved characters", () => {
    expect(escapeLdapFilterValue("*")).toBe("\\2a");
    expect(escapeLdapFilterValue("(")).toBe("\\28");
    expect(escapeLdapFilterValue(")")).toBe("\\29");
    expect(escapeLdapFilterValue("\\")).toBe("\\5c");
    expect(escapeLdapFilterValue("\0")).toBe("\\00");
  });

  it("escapes parentheses in the canonical RFC vector", () => {
    // RFC 4515 §4: spaces are NOT in the must-escape set, so they pass
    // through. Only ( ) get rewritten.
    expect(escapeLdapFilterValue("Parens R Us (for all your parenthetical needs)")).toBe(
      "Parens R Us \\28for all your parenthetical needs\\29",
    );
  });

  it("leaves unreserved characters alone", () => {
    expect(escapeLdapFilterValue("alice@example.com")).toBe("alice@example.com");
    expect(escapeLdapFilterValue("ALICE_42-X")).toBe("ALICE_42-X");
  });

  it("preserves non-ASCII characters verbatim", () => {
    // Diacritics aren't in the reserved set; the byte stream goes through.
    expect(escapeLdapFilterValue("Lučić")).toBe("Lučić");
  });

  it("blunts a filter-injection attempt", () => {
    // An attacker types `*)(uid=*` hoping to widen the OR. After escaping,
    // the parens and asterisks are literal - the filter searches for the
    // verbatim string in `uid`.
    const evil = "*)(uid=*";
    expect(escapeLdapFilterValue(evil)).toBe("\\2a\\29\\28uid=\\2a");
  });
});

describe("substituteUsername", () => {
  it("substitutes a single placeholder", () => {
    expect(substituteUsername("(uid={{username}})", "alice")).toBe("(uid=alice)");
  });

  it("substitutes every occurrence (AD's typical OR filter)", () => {
    const filter = "(|(uid={{username}})(sAMAccountName={{username}})(mail={{username}}))";
    expect(substituteUsername(filter, "bob")).toBe("(|(uid=bob)(sAMAccountName=bob)(mail=bob))");
  });

  it("escapes the substituted value", () => {
    expect(substituteUsername("(uid={{username}})", "*)(uid=*")).toBe("(uid=\\2a\\29\\28uid=\\2a)");
  });
});

describe("substituteUserDn", () => {
  it("substitutes the user DN into the optional second-search filter", () => {
    const filter = "(&(objectClass=group)(member={{userDn}}))";
    const dn = "CN=Alice,OU=Users,DC=example,DC=com";
    expect(substituteUserDn(filter, dn)).toBe(
      `(&(objectClass=group)(member=CN=Alice,OU=Users,DC=example,DC=com))`,
    );
  });
});

describe("readEntryString / readEntryStringArray", () => {
  // Minimal fixture entry. `ldapts` exposes attributes as `string | string[]
  // | Buffer | Buffer[]`; we cover both single-value and multi-value paths.
  const entry = {
    dn: "CN=Alice,OU=Users,DC=example,DC=com",
    mail: "alice@example.com",
    displayName: ["Alice Anderson"],
    memberOf: ["CN=Admins,OU=Groups,DC=example,DC=com", "CN=Engineers,OU=Groups,DC=example,DC=com"],
    binaryAttr: Buffer.from("hello", "utf8"),
    emptyAttr: "",
    missingArr: [] as string[],
  } as unknown as Entry;

  it("returns the first value from a single-string attribute", () => {
    expect(readEntryString(entry, "mail")).toBe("alice@example.com");
  });

  it("returns the first value from a multi-valued attribute", () => {
    expect(readEntryString(entry, "displayName")).toBe("Alice Anderson");
  });

  it("decodes Buffer values as UTF-8", () => {
    expect(readEntryString(entry, "binaryAttr")).toBe("hello");
  });

  it("returns null for missing / empty attributes", () => {
    expect(readEntryString(entry, "nope")).toBeNull();
    expect(readEntryString(entry, "emptyAttr")).toBeNull();
    expect(readEntryString(entry, "missingArr")).toBeNull();
  });

  it("readEntryStringArray reads memberOf as a group list", () => {
    expect(readEntryStringArray(entry, "memberOf")).toEqual([
      "CN=Admins,OU=Groups,DC=example,DC=com",
      "CN=Engineers,OU=Groups,DC=example,DC=com",
    ]);
  });

  it("readEntryStringArray returns empty when attribute is absent", () => {
    expect(readEntryStringArray(entry, "missing")).toEqual([]);
    expect(readEntryStringArray(entry, "emptyAttr")).toEqual([]);
  });
});

describe("buildTlsOptions", () => {
  it("defaults to rejectUnauthorized=true with no CA pin", () => {
    const opts = buildTlsOptions({ tlsCaCert: null });
    expect(opts.rejectUnauthorized).toBe(true);
    expect(opts.ca).toBeUndefined();
  });

  it("attaches the CA pin when one is set on the provider", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----";
    const opts = buildTlsOptions({ tlsCaCert: pem });
    expect(opts.ca).toBe(pem);
  });

  it("honours the env opt-out for self-signed labs", async () => {
    // The module reads `env` at call-time via the bound import. Switch the
    // process env, re-import (resetModules above clears the cache), and
    // assert the flip flows through.
    process.env["LDAP_TLS_INSECURE_SKIP_VERIFY"] = "true";
    vi.resetModules();
    const reloaded = await import("./ldap");
    expect(reloaded.buildTlsOptions({ tlsCaCert: null }).rejectUnauthorized).toBe(false);
  });
});

describe("createLdapProviderSchema URL safety", () => {
  it("refuses ldap:// without start_tls and without the env opt-in", async () => {
    vi.resetModules();
    const { createLdapProviderSchema } = await import("@/lib/validators/ldap-providers");
    const res = createLdapProviderSchema.safeParse({
      slug: "corp",
      name: "Corp",
      serverUrl: "ldap://ad.example.com:389",
      bindDn: "CN=svc,DC=example,DC=com",
      bindPassword: "x",
      userSearchBase: "OU=Users,DC=example,DC=com",
      startTls: false,
    });
    expect(res.success).toBe(false);
    const msg = !res.success
      ? res.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).join(",")
      : "";
    expect(msg).toMatch(/Plain ldap:\/\/ is refused/);
  });

  it("accepts ldap:// when start_tls=true is set on the row", async () => {
    vi.resetModules();
    const { createLdapProviderSchema } = await import("@/lib/validators/ldap-providers");
    const res = createLdapProviderSchema.safeParse({
      slug: "corp",
      name: "Corp",
      serverUrl: "ldap://ad.example.com:389",
      bindDn: "CN=svc,DC=example,DC=com",
      bindPassword: "x",
      userSearchBase: "OU=Users,DC=example,DC=com",
      startTls: true,
    });
    expect(res.success).toBe(true);
  });

  it("accepts ldap:// when LDAP_ALLOW_INSECURE_PORT_389=true is set in env", async () => {
    process.env["LDAP_ALLOW_INSECURE_PORT_389"] = "true";
    vi.resetModules();
    const { createLdapProviderSchema } = await import("@/lib/validators/ldap-providers");
    const res = createLdapProviderSchema.safeParse({
      slug: "corp",
      name: "Corp",
      serverUrl: "ldap://ad.example.com:389",
      bindDn: "CN=svc,DC=example,DC=com",
      bindPassword: "x",
      userSearchBase: "OU=Users,DC=example,DC=com",
      startTls: false,
    });
    expect(res.success).toBe(true);
  });

  it("refuses redundant start_tls + ldaps://", async () => {
    vi.resetModules();
    const { createLdapProviderSchema } = await import("@/lib/validators/ldap-providers");
    const res = createLdapProviderSchema.safeParse({
      slug: "corp",
      name: "Corp",
      serverUrl: "ldaps://ad.example.com:636",
      bindDn: "CN=svc,DC=example,DC=com",
      bindPassword: "x",
      userSearchBase: "OU=Users,DC=example,DC=com",
      startTls: true,
    });
    expect(res.success).toBe(false);
    const msg = !res.success
      ? res.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).join(",")
      : "";
    expect(msg).toMatch(/StartTLS is redundant/);
  });

  it("rejects a user_search_filter missing the {{username}} placeholder", async () => {
    vi.resetModules();
    const { createLdapProviderSchema } = await import("@/lib/validators/ldap-providers");
    const res = createLdapProviderSchema.safeParse({
      slug: "corp",
      name: "Corp",
      serverUrl: "ldaps://ad.example.com:636",
      bindDn: "CN=svc,DC=example,DC=com",
      bindPassword: "x",
      userSearchBase: "OU=Users,DC=example,DC=com",
      userSearchFilter: "(objectClass=user)",
    });
    expect(res.success).toBe(false);
    const msg = !res.success ? res.error.issues.map((i) => i.message).join(",") : "";
    expect(msg).toMatch(/{{username}}/);
  });

  it("rejects a filter with unbalanced parens", async () => {
    vi.resetModules();
    const { createLdapProviderSchema } = await import("@/lib/validators/ldap-providers");
    const res = createLdapProviderSchema.safeParse({
      slug: "corp",
      name: "Corp",
      serverUrl: "ldaps://ad.example.com:636",
      bindDn: "CN=svc,DC=example,DC=com",
      bindPassword: "x",
      userSearchBase: "OU=Users,DC=example,DC=com",
      userSearchFilter: "(uid={{username}}",
    });
    expect(res.success).toBe(false);
  });
});
