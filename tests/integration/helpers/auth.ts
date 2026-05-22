/**
 * tests/integration/helpers/auth.ts
 *
 * Login / user-creation fixtures.
 *
 * `loginAsBootstrap()` returns a TestHttp client carrying the bootstrap
 * admin's session — the canonical "do everything" actor. Use it for setup
 * and for tests that need super-admin privileges.
 *
 * `createUser()` + `loginAs()` model the common "create an operator-scoped
 * user, then act as them" pattern. RBAC tests use this to verify that a
 * caller without super-admin can't reach restricted routes.
 */

import { anonClient, type TestHttp } from "./http";

export const BOOTSTRAP_EMAIL = process.env["TEST_BOOTSTRAP_EMAIL"] ?? "admin@test.local";
export const BOOTSTRAP_PASSWORD =
  process.env["TEST_BOOTSTRAP_PASSWORD"] ?? "test-bootstrap-pw-changeme-now";

export const SYSTEM_ROLES = {
  superAdmin: "super-admin",
  teamOwner: "team-owner",
  operator: "operator",
  zoneEditor: "zone-editor",
  readOnly: "read-only",
} as const;

export type SystemRoleSlug = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];

export interface CreatedUser {
  id: string;
  email: string;
  name: string;
  password: string;
}

/** Log in as the bootstrap admin. Throws if the API rejects the credentials. */
export async function loginAsBootstrap(): Promise<TestHttp> {
  const client = anonClient();
  await client.sendJson("POST", "/api/auth/login", {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  return client;
}

/** Log in any user with explicit credentials. */
export async function loginAs(email: string, password: string): Promise<TestHttp> {
  const client = anonClient();
  await client.sendJson("POST", "/api/auth/login", { email, password });
  return client;
}

/**
 * Cache of role-slug → role-id resolved against the running app's
 * /api/admin/roles endpoint. Tests want to refer to roles by slug
 * ("operator") while the API takes UUIDs.
 */
const roleIdCache = new Map<string, string>();

export async function resolveRoleId(admin: TestHttp, slug: string): Promise<string> {
  const cached = roleIdCache.get(slug);
  if (cached) return cached;
  const { roles } = await admin.getJson<{ roles: Array<{ id: string; slug: string }> }>(
    "/api/admin/roles",
  );
  for (const r of roles) roleIdCache.set(r.slug, r.id);
  const id = roleIdCache.get(slug);
  if (!id) throw new Error(`[auth.helpers] role with slug "${slug}" not found in /api/admin/roles`);
  return id;
}

/**
 * Create a user via the admin API. Optionally assigns a global system role.
 * Returns the user id + the password the caller picked (so tests can log in
 * as them without round-tripping through email reset).
 */
export async function createUser(
  admin: TestHttp,
  attrs: {
    email: string;
    name: string;
    password: string;
    roleSlug?: SystemRoleSlug;
  },
): Promise<CreatedUser> {
  const body: Record<string, unknown> = {
    email: attrs.email,
    name: attrs.name,
    password: attrs.password,
  };
  if (attrs.roleSlug) {
    body["roleId"] = await resolveRoleId(admin, attrs.roleSlug);
  }
  const { user } = await admin.sendJson<{
    user: { id: string; email: string; name: string | null };
  }>("POST", "/api/admin/users", body);
  return {
    id: user.id,
    email: user.email,
    name: user.name ?? attrs.name,
    password: attrs.password,
  };
}

/** Convenience: create + log in as the new user, returning their client. */
export async function createAndLogin(
  admin: TestHttp,
  attrs: { email: string; name: string; password: string; roleSlug?: SystemRoleSlug },
): Promise<{ user: CreatedUser; client: TestHttp }> {
  const user = await createUser(admin, attrs);
  const client = await loginAs(user.email, user.password);
  return { user, client };
}

/** Convenience: random-looking unique email per test run. */
export function uniqueEmail(prefix = "test"): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${suffix}@test.local`;
}
