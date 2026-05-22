/**
 * tests/integration/admin/teams.test.ts
 *
 * /api/admin/teams — CRUD plus member add/remove. Verifies the audit log
 * captures team.create + team.member.added, and that a non-admin operator
 * is forbidden from creating teams.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { createUser, loginAs, loginAsBootstrap, SYSTEM_ROLES, uniqueEmail } from "../helpers/auth";
import { dbQuery } from "../helpers/db";
import { resetState } from "../helpers/reset";

function uniqueSlug(prefix = "team"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface TeamRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

describe("/api/admin/teams", () => {
  beforeEach(async () => {
    await resetState({ skipPdns: true });
  });

  it("GET lists teams — empty after reset, then includes a newly created team", async () => {
    const admin = await loginAsBootstrap();
    const before = await admin.getJson<{ teams: TeamRow[] }>("/api/admin/teams");
    expect(before.teams).toEqual([]);

    const slug = uniqueSlug();
    const { team } = await admin.sendJson<{ team: TeamRow }>("POST", "/api/admin/teams", {
      slug,
      name: "Listed Team",
    });
    const after = await admin.getJson<{ teams: TeamRow[] }>("/api/admin/teams");
    expect(after.teams.map((t) => t.id)).toContain(team.id);
  });

  it("POST creates a team and returns it with 201", async () => {
    const admin = await loginAsBootstrap();
    const slug = uniqueSlug("create");
    const res = await admin.call("/api/admin/teams", {
      method: "POST",
      json: { slug, name: "Brand New", description: "a new team" },
    });
    expect(res.status).toBe(201);
    const { team } = (await res.json()) as { team: TeamRow };
    expect(team.slug).toBe(slug);
    expect(team.name).toBe("Brand New");
    expect(team.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("PATCH /api/admin/teams/[id] updates name", async () => {
    const admin = await loginAsBootstrap();
    const { team } = await admin.sendJson<{ team: TeamRow }>("POST", "/api/admin/teams", {
      slug: uniqueSlug("patch"),
      name: "Original",
    });
    const updated = await admin.sendJson<{ team: TeamRow }>(
      "PATCH",
      `/api/admin/teams/${team.id}`,
      { name: "Renamed" },
    );
    expect(updated.team.name).toBe("Renamed");
  });

  it("DELETE /api/admin/teams/[id] removes the team", async () => {
    const admin = await loginAsBootstrap();
    const { team } = await admin.sendJson<{ team: TeamRow }>("POST", "/api/admin/teams", {
      slug: uniqueSlug("del"),
      name: "Goner",
    });
    await admin.sendJson("DELETE", `/api/admin/teams/${team.id}`);
    const { teams } = await admin.getJson<{ teams: TeamRow[] }>("/api/admin/teams");
    expect(teams.find((t) => t.id === team.id)).toBeUndefined();
  });

  it("POST /api/admin/teams/[id]/members adds a user by email", async () => {
    const admin = await loginAsBootstrap();
    const { team } = await admin.sendJson<{ team: TeamRow }>("POST", "/api/admin/teams", {
      slug: uniqueSlug("memb"),
      name: "Member Host",
    });
    const newUser = await createUser(admin, {
      email: uniqueEmail("member"),
      name: "Member User",
      password: "member-test-password-1234",
    });
    const res = await admin.call(`/api/admin/teams/${team.id}/members`, {
      method: "POST",
      json: { email: newUser.email, teamRole: "member" },
    });
    expect(res.status).toBe(201);

    const rows = await dbQuery<{ user_id: string; team_role: string }>(
      "SELECT user_id, team_role FROM team_members WHERE team_id = $1",
      [team.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(newUser.id);
    expect(rows[0]!.team_role).toBe("member");
  });

  it("DELETE /api/admin/teams/[id]/members/[userId] removes the membership", async () => {
    const admin = await loginAsBootstrap();
    const { team } = await admin.sendJson<{ team: TeamRow }>("POST", "/api/admin/teams", {
      slug: uniqueSlug("remmemb"),
      name: "Remove Member",
    });
    const u = await createUser(admin, {
      email: uniqueEmail("rmmemb"),
      name: "Will Leave",
      password: "leaving-pass-words-1234",
    });
    await admin.sendJson("POST", `/api/admin/teams/${team.id}/members`, {
      email: u.email,
      teamRole: "member",
    });
    await admin.sendJson("DELETE", `/api/admin/teams/${team.id}/members/${u.id}`);
    const rows = await dbQuery("SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2", [
      team.id,
      u.id,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("GET /api/admin/teams/[id]/members — route is not exposed; expect 404 or 405", async () => {
    const admin = await loginAsBootstrap();
    const { team } = await admin.sendJson<{ team: TeamRow }>("POST", "/api/admin/teams", {
      slug: uniqueSlug("listmemb"),
      name: "List Members",
    });
    const res = await admin.call(`/api/admin/teams/${team.id}/members`);
    expect([404, 405]).toContain(res.status);
  });

  it("non-admin (operator) cannot create a team — 403", async () => {
    const admin = await loginAsBootstrap();
    const op = await createUser(admin, {
      email: uniqueEmail("op-team"),
      name: "Op",
      password: "operator-team-pass-123456",
      roleSlug: SYSTEM_ROLES.operator,
    });
    const opClient = await loginAs(op.email, op.password);
    const res = await opClient.call("/api/admin/teams", {
      method: "POST",
      json: { slug: uniqueSlug("forbid"), name: "Should Fail" },
    });
    expect(res.status).toBe(403);
  });

  it("audit log records team.create and team.member.added", async () => {
    const admin = await loginAsBootstrap();
    const { team } = await admin.sendJson<{ team: TeamRow }>("POST", "/api/admin/teams", {
      slug: uniqueSlug("audit"),
      name: "Audit Team",
    });
    const newUser = await createUser(admin, {
      email: uniqueEmail("audit-memb"),
      name: "Audited Member",
      password: "audited-member-pw-12345",
    });
    await admin.sendJson("POST", `/api/admin/teams/${team.id}/members`, {
      email: newUser.email,
      teamRole: "member",
    });
    const rows = await dbQuery<{ action: string }>(
      "SELECT action FROM audit_log WHERE resource_type = 'team' AND resource_id = $1 ORDER BY ts",
      [team.id],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("team.create");
    expect(actions).toContain("team.member.added");
  });
});
