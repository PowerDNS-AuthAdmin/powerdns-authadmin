/**
 * tests/integration/profile/mfa.test.ts
 *
 * TOTP enrollment + removal. Start enrollment (POST), compute the
 * 6-digit code locally from the returned secret using a tiny HOTP
 * impl, confirm with PUT, then verify the encrypted secret column is
 * non-null. DELETE disables MFA and nulls the column.
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAs, loginAsBootstrap, uniqueEmail } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx < 0) throw new Error(`Invalid base32 char: ${c}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function totpCode(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  const high = Math.floor(counter / 0x100000000);
  const low = counter & 0xffffffff;
  buf.writeUInt32BE(high, 0);
  buf.writeUInt32BE(low >>> 0, 4);
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

interface EnrollStartResponse {
  ok: boolean;
  uri: string;
  qrSvg: string;
  secret: string;
  revealToken: string;
  expiresInSec: number;
}

describe("/api/profile/mfa/totp", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("POST starts enrollment: returns otpauth URI + secret + revealToken", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("mfa-start");
    const password = "abcdef-123456-mst";
    await createUser(admin, { email, name: "MfaStart", password });
    const client = await loginAs(email, password);

    const res = await client.call("/api/profile/mfa/totp", { method: "POST" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as EnrollStartResponse;
    expect(body.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(body.secret).toMatch(/^[A-Z2-7]+$/);
    expect(body.revealToken).toBeTypeOf("string");
    expect(body.qrSvg).toMatch(/<svg/);
  });

  it("PUT with the correct code enrolls TOTP; users.totp_secret_encrypted is non-null", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("mfa-confirm");
    const password = "abcdef-123456-mco";
    const created = await createUser(admin, { email, name: "MfaConfirm", password });
    const client = await loginAs(email, password);

    const start = await client.sendJson<EnrollStartResponse>("POST", "/api/profile/mfa/totp");

    const code = totpCode(start.secret);
    const res = await client.call("/api/profile/mfa/totp", {
      method: "PUT",
      json: { revealToken: start.revealToken, code },
    });
    expect(res.status).toBe(200);

    const rows = await dbQuery<{ totp_secret_encrypted: string | null }>(
      "SELECT totp_secret_encrypted FROM users WHERE id = $1",
      [created.id],
    );
    expect(rows[0]!.totp_secret_encrypted).not.toBeNull();
  });

  it("PUT with a wrong code rejects enrollment (400) and column stays null", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("mfa-bad");
    const password = "abcdef-123456-mbd";
    const created = await createUser(admin, { email, name: "MfaBad", password });
    const client = await loginAs(email, password);

    const start = await client.sendJson<EnrollStartResponse>("POST", "/api/profile/mfa/totp");

    const res = await client.call("/api/profile/mfa/totp", {
      method: "PUT",
      json: { revealToken: start.revealToken, code: "000000" },
    });
    expect(res.status).toBe(400);

    const rows = await dbQuery<{ totp_secret_encrypted: string | null }>(
      "SELECT totp_secret_encrypted FROM users WHERE id = $1",
      [created.id],
    );
    expect(rows[0]!.totp_secret_encrypted).toBeNull();
  });

  it("DELETE disables MFA; users.totp_secret_encrypted goes back to null", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("mfa-disable");
    const password = "abcdef-123456-mdi";
    const created = await createUser(admin, { email, name: "MfaDisable", password });
    const client = await loginAs(email, password);

    const start = await client.sendJson<EnrollStartResponse>("POST", "/api/profile/mfa/totp");
    await client.sendJson("PUT", "/api/profile/mfa/totp", {
      revealToken: start.revealToken,
      code: totpCode(start.secret),
    });

    const res = await client.call("/api/profile/mfa/totp", { method: "DELETE" });
    expect(res.status).toBe(200);

    const rows = await dbQuery<{ totp_secret_encrypted: string | null }>(
      "SELECT totp_secret_encrypted FROM users WHERE id = $1",
      [created.id],
    );
    expect(rows[0]!.totp_secret_encrypted).toBeNull();
  });

  it("re-starting enrollment when TOTP is already enabled returns 409", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("mfa-twice");
    const password = "abcdef-123456-mtw";
    await createUser(admin, { email, name: "MfaTwice", password });
    const client = await loginAs(email, password);

    const start = await client.sendJson<EnrollStartResponse>("POST", "/api/profile/mfa/totp");
    await client.sendJson("PUT", "/api/profile/mfa/totp", {
      revealToken: start.revealToken,
      code: totpCode(start.secret),
    });

    const res = await client.call("/api/profile/mfa/totp", { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("audit_log records auth.mfa.enrolled and auth.mfa.removed", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("mfa-audit");
    const password = "abcdef-123456-mau";
    const created = await createUser(admin, { email, name: "MfaAudit", password });
    const client = await loginAs(email, password);

    const start = await client.sendJson<EnrollStartResponse>("POST", "/api/profile/mfa/totp");
    await client.sendJson("PUT", "/api/profile/mfa/totp", {
      revealToken: start.revealToken,
      code: totpCode(start.secret),
    });
    await client.sendJson("DELETE", "/api/profile/mfa/totp");

    const rows = await dbQuery<{ action: string }>(
      "SELECT action FROM audit_log WHERE resource_id = $1 ORDER BY ts",
      [created.id],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("auth.mfa.enrolled");
    expect(actions).toContain("auth.mfa.removed");
  });
});
