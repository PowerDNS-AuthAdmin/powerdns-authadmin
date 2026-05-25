/**
 * scripts/seed.ts
 *
 * Idempotent seed. Runs on every container boot (after migrate, before
 * the Next.js server):
 *
 *   1. Upsert the system roles (super-admin, team-owner, operator,
 *      zone-editor, read-only).
 *   2. If BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD are set,
 *      ensure that user exists and holds the super-admin role.
 *
 * Bootstrap semantics (deliberate):
 *   - Keyed on email, NOT "is the users table empty". If the operator
 *     ran the bootstrap once, added a few users through the UI, then
 *     restarts with BOOTSTRAP_ADMIN_* still set, the seed re-checks the
 *     bootstrap email and creates/grants if it's missing. This makes the
 *     env vars the canonical declaration of "there should be a
 *     SuperAdmin with this email" rather than a one-shot first-run hook.
 *   - When the user already exists, the password is NOT touched. The
 *     env password is the initial value only; later changes are owned by
 *     the user (or by an admin reset through the UI). A separate
 *     BOOTSTRAP_ADMIN_RESET_PASSWORD=true escape hatch could be added if
 *     operators need it; today, simplicity wins.
 *   - The super-admin role assignment is upserted: if the user exists
 *     but doesn't have the global super-admin scope, it's granted.
 */

import { and, eq, isNull } from "drizzle-orm";
import { closeDatabase, db } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { upsertRole, findRoleBySlug } from "@/lib/db/repositories/roles";
import { findUserByEmail } from "@/lib/db/repositories/users";
import { hashPassword } from "@/lib/auth/password";
import { appendAudit } from "@/lib/audit/log";
import { DEFAULT_ROLES } from "@/lib/rbac/default-roles";
import { checkSignupDefaultRole } from "@/lib/auth/signup-policy";
import { roleAssignments, users } from "@/lib/db/schema";

async function seedRoles(): Promise<void> {
  for (const def of DEFAULT_ROLES) {
    await upsertRole({
      slug: def.slug,
      name: def.name,
      description: def.description,
      isSystem: true,
      permissions: def.permissions,
    });
    logger.info({ role: def.slug }, "seed.role.upserted");
  }
}

async function seedBootstrapAdmin(): Promise<void> {
  if (!env.BOOTSTRAP_ADMIN_EMAIL || !env.BOOTSTRAP_ADMIN_PASSWORD) {
    logger.info("seed.bootstrap.skipped: BOOTSTRAP_ADMIN_* not set");
    return;
  }

  const superAdmin = await findRoleBySlug("super-admin");
  if (!superAdmin) {
    throw new Error("seed.bootstrap: super-admin role missing (did seedRoles fail?)");
  }

  const bootstrapEmail = env.BOOTSTRAP_ADMIN_EMAIL;
  const existing = await findUserByEmail(bootstrapEmail);

  if (existing) {
    // User already exists — leave the password alone (it's the env's
    // INITIAL value, not an ongoing source of truth). Make sure the
    // super-admin global assignment is present; grant it if not. Idempotent
    // across restarts so an operator who manually demoted the bootstrap
    // admin can't accidentally re-grant by restart — but a fresh bootstrap
    // email never seen before is created end-to-end below.
    const existingAssignments = await db
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.userId, existing.id),
          eq(roleAssignments.roleId, superAdmin.id),
          eq(roleAssignments.scopeType, "global"),
          isNull(roleAssignments.scopeId),
        ),
      )
      .limit(1);
    if (existingAssignments.length > 0) {
      logger.info(
        { email: existing.email },
        "seed.bootstrap.user-exists: bootstrap admin present with super-admin already; no-op.",
      );
      return;
    }
    await db.insert(roleAssignments).values({
      userId: existing.id,
      roleId: superAdmin.id,
      scopeType: "global",
      scopeId: null,
      createdBy: null,
    });
    await appendAudit({
      actor: { type: "system", id: null },
      action: "role.assignment.created",
      resource: { type: "user", id: existing.id },
      after: {
        roleSlug: "super-admin",
        scopeType: "global",
        source: "bootstrap-seed",
      },
    });
    logger.warn(
      { email: existing.email },
      "seed.bootstrap.role-granted: bootstrap admin existed without super-admin; granted now.",
    );
    return;
  }

  const passwordHash = await hashPassword(env.BOOTSTRAP_ADMIN_PASSWORD);

  await db.transaction(async (tx) => {
    const userRows = await tx
      .insert(users)
      .values({
        email: bootstrapEmail,
        name: "Bootstrap Admin",
        passwordHash,
        emailVerifiedAt: new Date(),
        mustChangePassword: true,
      })
      .returning();
    const user = userRows[0];
    if (!user) {
      throw new Error("seed.bootstrap: user insert returned no row");
    }

    await tx.insert(roleAssignments).values({
      userId: user.id,
      roleId: superAdmin.id,
      scopeType: "global",
      scopeId: null,
      createdBy: null,
    });

    await appendAudit(
      {
        actor: { type: "system", id: null },
        action: "user.create",
        resource: { type: "user", id: user.id },
        after: { email: user.email, source: "bootstrap-seed" },
      },
      tx,
    );

    logger.warn(
      { email: user.email },
      "seed.bootstrap.user-created: SuperAdmin created. Change the password on first login.",
    );
  });
}

/**
 * Boot-time guard for self-service signup (`SIGNUP_ENABLED`). Runs after the
 * system roles are upserted so a default pointing at a seeded role resolves.
 *
 * Refuses to boot — same loud-failure contract as the env/SMTP checks — when
 * `SIGNUP_DEFAULT_ROLE` either doesn't exist or is admin-equivalent. Without
 * this, a typo'd or over-privileged default would turn public signup into a
 * silent admin-account vending machine. Only enforced when signup is on; when
 * it's off the var is inert and an operator can leave it at any value.
 */
async function validateSignupDefaultRole(): Promise<void> {
  if (!env.SIGNUP_ENABLED) {
    logger.info("seed.signup.skipped: SIGNUP_ENABLED=false");
    return;
  }
  const slug = env.SIGNUP_DEFAULT_ROLE;
  const role = await findRoleBySlug(slug);
  const check = checkSignupDefaultRole(role);
  if (check.ok) {
    logger.info({ role: slug }, "seed.signup.default-role.ok");
    return;
  }
  const detail =
    check.reason === "missing"
      ? `SIGNUP_DEFAULT_ROLE="${slug}" does not match any role. Create the role first, or point it at a seeded low-privilege role (e.g. "read-only").`
      : `SIGNUP_DEFAULT_ROLE="${slug}" is admin-equivalent. Self-service signup must only grant a low-privilege role — pick one without user/role/settings/server/audit permissions (e.g. "read-only").`;
  throw new Error(`seed.signup: refusing to boot — ${detail}`);
}

async function main(): Promise<void> {
  logger.info("seed.start");
  try {
    await seedRoles();
    await validateSignupDefaultRole();
    await seedBootstrapAdmin();
    logger.info("seed.complete");
  } finally {
    await closeDatabase();
  }
}

// Exit explicitly. This is a one-shot boot step run by docker/entrypoint.mjs
// via spawnSync, which blocks until the process exits. Relying on the event
// loop draining is unsafe here: a connection-pool socket and the pino-pretty
// transport worker can linger after the work is done, leaving the process
// alive forever — which would hang the entrypoint and the server would never
// start. `migrate.ts` avoids this by owning a short-lived pool; the seed uses
// the app singleton, so it must exit on its own.
main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "seed.failed");
    process.exit(1);
  });
