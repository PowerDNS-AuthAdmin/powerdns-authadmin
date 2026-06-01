/**
 * tests/integration/auth/logout.test.ts
 *
 * POST /api/auth/logout - invalidates the current session. Verifies the
 * session record is gone from the DB and follow-up calls with the same
 * cookie are rejected.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { loginAsBootstrap } from "../helpers/auth";
import { resetState } from "../helpers/reset";
import { dbQuery } from "../helpers/db";

describe("POST /api/auth/logout", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("invalidates the session and removes its DB row", async () => {
    const client = await loginAsBootstrap();
    const sessionsBefore = await dbQuery<{ count: string }>("SELECT count(*)::text FROM sessions");
    expect(Number(sessionsBefore[0]!.count)).toBeGreaterThan(0);

    const res = await client.call("/api/auth/logout", { method: "POST" });
    expect(res.status).toBeLessThan(400);

    const sessionsAfter = await dbQuery<{ count: string }>("SELECT count(*)::text FROM sessions");
    expect(Number(sessionsAfter[0]!.count)).toBe(0);
  });

  it("subsequent calls with the invalidated session are unauthorized", async () => {
    const client = await loginAsBootstrap();
    await client.call("/api/auth/logout", { method: "POST" });
    const probe = await client.call("/api/admin/users");
    expect(probe.status).toBe(401);
  });
});
