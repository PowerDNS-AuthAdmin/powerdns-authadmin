/**
 * tests/integration/auth/signup.test.ts
 *
 * POST /api/auth/signup — public self-service signup, gated by SIGNUP_ENABLED.
 *
 * The shared integration stack boots with SIGNUP_ENABLED unset (signup OFF) so
 * the existing auth suite's admin-created/unverified login flows keep working.
 * We therefore:
 *   - ALWAYS assert the disabled→404 / enabled→200 contract against whatever
 *     stack is up;
 *   - run the full happy-path / non-enumeration / allow-list / rate-limit /
 *     verification-gate suite only when SIGNUP_INTEGRATION is set, which signals
 *     the stack was booted with SIGNUP_ENABLED=true (SMTP unset → audit-log
 *     fallback). Without it those cases skip (the spec's "skip when prereqs
 *     aren't met" contract).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { anonClient } from "../helpers/http";
import { loginAs, uniqueEmail } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

const STRONG_PASSWORD = "signup-passw0rd-1234";

describe("POST /api/auth/signup — feature gate", () => {
  it("returns 404 when disabled, or a uniform 200 OK when enabled", async () => {
    const res = await anonClient().call("/api/auth/signup", {
      method: "POST",
      json: { email: uniqueEmail("gate"), password: STRONG_PASSWORD },
    });
    expect([200, 404]).toContain(res.status);
  });
});

describe.skipIf(!process.env["SIGNUP_INTEGRATION"])(
  "POST /api/auth/signup — full flow (requires SIGNUP_ENABLED=true)",
  () => {
    beforeEach(async () => {
      await resetState({ skipPdns: true });
    });

    it("happy path: creates an UNVERIFIED user with the default role + audit + verification", async () => {
      const email = uniqueEmail("signup-ok");
      const res = await anonClient().call("/api/auth/signup", {
        method: "POST",
        json: { email, password: STRONG_PASSWORD, name: "New Person" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; message: string };
      expect(body.ok).toBe(true);

      const users = await dbQuery<{
        id: string;
        email_verified_at: string | null;
        password_hash: string | null;
        must_change_password: boolean;
      }>(
        "SELECT id, email_verified_at, password_hash, must_change_password FROM users WHERE lower(email) = lower($1)",
        [email],
      );
      expect(users).toHaveLength(1);
      const user = users[0]!;
      expect(user.email_verified_at).toBeNull(); // unverified by construction
      expect(user.password_hash).toMatch(/^\$argon2id\$/); // Argon2id
      expect(user.must_change_password).toBe(false); // self-chosen password

      // Exactly one global role assignment, the default low-privilege role.
      const roles = await dbQuery<{ slug: string; scope_type: string }>(
        `SELECT r.slug, ra.scope_type FROM role_assignments ra
           JOIN roles r ON r.id = ra.role_id WHERE ra.user_id = $1`,
        [user.id],
      );
      expect(roles).toHaveLength(1);
      expect(roles[0]!.scope_type).toBe("global");
      expect(roles[0]!.slug).toBe(process.env["SIGNUP_DEFAULT_ROLE"] ?? "read-only");

      // user.create (source: signup) + role assignment + verification-sent audit.
      const actions = (
        await dbQuery<{ action: string }>(
          "SELECT action FROM audit_log WHERE resource_id = $1 ORDER BY created_at",
          [user.id],
        )
      ).map((a) => a.action);
      expect(actions).toContain("user.create");
      expect(actions).toContain("role.assignment.created");
      expect(actions).toContain("auth.email.verify.sent");
    });

    it("created user CANNOT log in until verified, then CAN after verification", async () => {
      const email = uniqueEmail("signup-gate");
      await anonClient().call("/api/auth/signup", {
        method: "POST",
        json: { email, password: STRONG_PASSWORD },
      });

      const blocked = await anonClient().call("/api/auth/login", {
        method: "POST",
        json: { email, password: STRONG_PASSWORD },
      });
      expect(blocked.status).toBe(403);
      expect(((await blocked.json()) as { reason?: string }).reason).toBe("email-unverified");

      await dbQuery("UPDATE users SET email_verified_at = now() WHERE lower(email) = lower($1)", [
        email,
      ]);
      const client = await loginAs(email, STRONG_PASSWORD);
      expect(client.hasCookie("pda_csrf")).toBe(true);
    });

    it("duplicate email is NON-enumerating: same status/body, no second user", async () => {
      const email = uniqueEmail("signup-dup");
      const first = await anonClient().call("/api/auth/signup", {
        method: "POST",
        json: { email, password: STRONG_PASSWORD },
      });
      const firstBody = (await first.json()) as Record<string, unknown>;

      const second = await anonClient().call("/api/auth/signup", {
        method: "POST",
        json: { email, password: "totally-different-pw-99" },
      });
      const secondBody = (await second.json()) as Record<string, unknown>;

      expect(second.status).toBe(first.status);
      expect(secondBody).toEqual(firstBody);

      const users = await dbQuery("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
      expect(users).toHaveLength(1);
    });

    it("rejects a weak/short password with 400", async () => {
      const res = await anonClient().call("/api/auth/signup", {
        method: "POST",
        json: { email: uniqueEmail("signup-weak"), password: "short" },
      });
      expect(res.status).toBe(400);
    });

    it("rate-limits a burst of signups from one IP", async () => {
      const client = anonClient(); // one client == one source IP
      let saw429 = false;
      for (let i = 0; i < 8; i++) {
        const res = await client.call("/api/auth/signup", {
          method: "POST",
          json: { email: uniqueEmail(`signup-rl-${i}`), password: STRONG_PASSWORD },
        });
        if (res.status === 429) {
          saw429 = true;
          break;
        }
      }
      // sensitiveLimiter is capacity 3 — a burst of 8 must trip it.
      expect(saw429).toBe(true);
    });
  },
);

/**
 * Domain allow-list rejection. Requires a stack booted with
 * SIGNUP_ALLOWED_EMAIL_DOMAINS set to a list that EXCLUDES the test domain
 * (signalled by SIGNUP_INTEGRATION_DOMAIN_DENY) so an out-of-list address is
 * rejected with 403/domain-not-allowed and no user is created.
 */
describe.skipIf(!process.env["SIGNUP_INTEGRATION_DOMAIN_DENY"])(
  "POST /api/auth/signup — email-domain allow-list",
  () => {
    it("rejects an out-of-allow-list domain with 403 and creates no user", async () => {
      const email = `signup-denied-${Date.now()}@blocked.invalid`;
      const res = await anonClient().call("/api/auth/signup", {
        method: "POST",
        json: { email, password: STRONG_PASSWORD },
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { reason?: string }).reason).toBe("domain-not-allowed");
      const users = await dbQuery("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
      expect(users).toHaveLength(0);
    });
  },
);
