/**
 * tests/integration/auth/sessions.test.ts
 *
 * Session revocation contracts. GET endpoints for listing sessions
 * aren't exposed by the app today — sessions are read via DB queries.
 * Covers admin per-user revoke, admin per-session revoke, self-revoke
 * via /api/auth/sessions/[id], and the cross-client invalidation that
 * follows revocation.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAs, loginAsBootstrap, uniqueEmail } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

describe("session revocation", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("admin revokes all sessions for a target user (DELETE /api/admin/users/[id]/sessions)", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("multi-sess");
    const password = "abcdef-123456-multi";
    const target = await createUser(admin, { email, name: "MultiSess", password });

    const clientA = await loginAs(email, password);
    const clientB = await loginAs(email, password);
    expect(clientA.hasCookie("pda_session")).toBe(true);
    expect(clientB.hasCookie("pda_session")).toBe(true);

    const before = await dbQuery<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1",
      [target.id],
    );
    expect(Number(before[0]!.count)).toBeGreaterThanOrEqual(2);

    const res = await admin.call(`/api/admin/users/${target.id}/sessions`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; revoked: number };
    expect(body.ok).toBe(true);
    expect(body.revoked).toBeGreaterThanOrEqual(2);

    const after = await dbQuery<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM sessions WHERE user_id = $1",
      [target.id],
    );
    expect(Number(after[0]!.count)).toBe(0);
  });

  it("admin revokes a single session (DELETE /api/admin/users/[id]/sessions/[sessionId])", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("one-sess");
    const password = "abcdef-123456-one";
    const target = await createUser(admin, { email, name: "OneSess", password });

    await loginAs(email, password);
    await loginAs(email, password);

    const rows = await dbQuery<{ id: string }>(
      "SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at",
      [target.id],
    );
    expect(rows.length).toBe(2);
    const victimSessionId = rows[0]!.id;

    const res = await admin.call(`/api/admin/users/${target.id}/sessions/${victimSessionId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const after = await dbQuery<{ id: string }>("SELECT id FROM sessions WHERE user_id = $1", [
      target.id,
    ]);
    const remainingIds = after.map((r) => r.id);
    expect(remainingIds).not.toContain(victimSessionId);
    expect(remainingIds.length).toBe(1);
  });

  it("admin per-session revoke rejects a session id belonging to a different user (404)", async () => {
    const admin = await loginAsBootstrap();
    const a = await createUser(admin, {
      email: uniqueEmail("user-a"),
      name: "UserA",
      password: "abcdef-123456-aaa",
    });
    const b = await createUser(admin, {
      email: uniqueEmail("user-b"),
      name: "UserB",
      password: "abcdef-123456-bbb",
    });

    await loginAs(a.email, a.password);
    const aSessions = await dbQuery<{ id: string }>("SELECT id FROM sessions WHERE user_id = $1", [
      a.id,
    ]);

    const res = await admin.call(`/api/admin/users/${b.id}/sessions/${aSessions[0]!.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("user self-revokes their own session via /api/auth/sessions/[id]", async () => {
    const admin = await loginAsBootstrap();
    const email = uniqueEmail("self-revoke");
    const password = "abcdef-123456-self";
    const created = await createUser(admin, { email, name: "SelfRevoke", password });

    const clientA = await loginAs(email, password);
    const clientB = await loginAs(email, password);

    const rows = await dbQuery<{ id: string }>(
      "SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at",
      [created.id],
    );
    expect(rows.length).toBe(2);
    const sessionAId = rows[0]!.id;

    // clientA's session is the first row (oldest). Revoke it via clientA.
    const res = await clientA.call(`/api/auth/sessions/${sessionAId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    // clientA's session is now revoked → follow-up calls return 401.
    const probe = await clientA.call("/api/profile/tokens", { method: "GET" });
    expect(probe.status).toBe(401);

    // clientB still has a working session.
    const probeB = await clientB.call("/api/profile/tokens", { method: "GET" });
    expect(probeB.status).toBe(200);
  });

  it("user cannot revoke another user's session via /api/auth/sessions/[id] (403)", async () => {
    const admin = await loginAsBootstrap();
    const victim = await createUser(admin, {
      email: uniqueEmail("victim"),
      name: "Victim",
      password: "abcdef-123456-vic",
    });
    const attacker = await createUser(admin, {
      email: uniqueEmail("attacker"),
      name: "Attacker",
      password: "abcdef-123456-atk",
    });

    await loginAs(victim.email, victim.password);
    const victimRows = await dbQuery<{ id: string }>("SELECT id FROM sessions WHERE user_id = $1", [
      victim.id,
    ]);
    const attackerClient = await loginAs(attacker.email, attacker.password);

    const res = await attackerClient.call(`/api/auth/sessions/${victimRows[0]!.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  it("DELETE /api/admin/sessions wipes every session (incident-response, spares actor)", async () => {
    const admin = await loginAsBootstrap();
    const u1 = await createUser(admin, {
      email: uniqueEmail("wipe-1"),
      name: "Wipe1",
      password: "abcdef-123456-w1",
    });
    const u2 = await createUser(admin, {
      email: uniqueEmail("wipe-2"),
      name: "Wipe2",
      password: "abcdef-123456-w2",
    });
    await loginAs(u1.email, u1.password);
    await loginAs(u2.email, u2.password);

    const before = await dbQuery<{ count: string }>("SELECT COUNT(*)::text AS count FROM sessions");
    expect(Number(before[0]!.count)).toBeGreaterThanOrEqual(3);

    const res = await admin.call("/api/admin/sessions", { method: "DELETE" });
    expect(res.status).toBe(200);

    // Actor's own session is spared by default; everyone else is gone.
    const after = await dbQuery<{ user_id: string }>("SELECT user_id FROM sessions");
    expect(after.length).toBe(1);
    const probe = await admin.call("/api/admin/users", { method: "GET" });
    expect(probe.status).toBe(200);
  });
});
