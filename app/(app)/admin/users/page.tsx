/**
 * app/(app)/admin/users/page.tsx
 *
 * Admin user list. Shows status (active / disabled / must-change), last
 * sign-in, and how many role assignments they hold. Permission: user.read.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { CreateButton } from "@/components/ui/create-button";
import { listAllUsers } from "@/lib/db/repositories/users";
import { countAssignmentsForUsers } from "@/lib/db/repositories/roles";
import { latestAdminEditTimestampsForUsers } from "@/lib/db/repositories/audit-log";
import type { User } from "@/lib/db/schema";
import { UsersTable, type UserRow } from "./_components/users-table";
import { RevokeAllSessionsButton } from "./_components/revoke-all-button";

export const metadata: Metadata = { title: "Users" };

/**
 * URL-driven filter for the users list. Composes with the dashboard
 * "Attention required" widget so a tile-click lands on a
 * pre-filtered list. Each value maps to a predicate evaluated in
 * memory — the list is small enough (rare to exceed a few hundred
 * users) that adding a WHERE clause per filter isn't worth the
 * extra repo surface.
 */
type UserFilter = "locked" | "no-mfa" | "unverified" | "must-change";

const FILTER_LABELS: Record<UserFilter, string> = {
  locked: "Locked out",
  "no-mfa": "No MFA",
  unverified: "Unverified email",
  "must-change": "Must change password",
};

function isFilter(value: string | undefined): value is UserFilter {
  return (
    value === "locked" || value === "no-mfa" || value === "unverified" || value === "must-change"
  );
}

export default async function UsersListPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { ability } = await requireUserForPage({ can: "user.read" });
  const canCreate = ability.can("create", "User");
  // Same perm gate as the bulk-revoke route. Hidden for read-only
  // operators so they don't see a destructive button they can't
  // use.
  const canBulkRevoke = ability.can("update", "User");
  const canReadAudit = ability.can("read", "Audit");

  const { filter: rawFilter } = await searchParams;
  const filter = isFilter(rawFilter) ? rawFilter : null;

  const allUsers = await listAllUsers();
  const users = filter ? allUsers.filter((u) => matchesFilter(u, filter)) : allUsers;
  const counts = await countAssignmentsForUsers(users.map((u) => u.id));
  const lastAdminEdits =
    canReadAudit && users.length > 0
      ? await latestAdminEditTimestampsForUsers(users.map((u) => u.id))
      : new Map<string, Date>();

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            {users.length} account{users.length === 1 ? "" : "s"}
            {filter ? ` matching "${FILTER_LABELS[filter]}"` : " — newest first"}.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-2 [&>*]:w-full sm:[&>*]:w-auto">
          {canBulkRevoke ? <RevokeAllSessionsButton /> : null}
          {canCreate ? <CreateButton href="/admin/users/new" label="Add user" /> : null}
        </div>
      </header>

      <FilterChips active={filter} totalAll={allUsers.length} />

      <UsersTable
        showLastAdminEdit={canReadAudit}
        rows={users.map(
          (u): UserRow => ({
            id: u.id,
            email: u.email,
            name: u.name,
            lastSignInDisplay: u.lastLoginAt ? u.lastLoginAt.toLocaleString() : "Never",
            lastSignInIso: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
            lastAdminEditIso: lastAdminEdits.get(u.id)?.toISOString() ?? null,
            rolesCount: counts.get(u.id) ?? 0,
            disabledAt: u.disabledAt ? u.disabledAt.toISOString() : null,
            lockedUntilIso: u.lockedUntil ? u.lockedUntil.toISOString() : null,
            mustChangePassword: u.mustChangePassword,
            ssoOnly: u.passwordHash === null,
            mfaEnrolled: u.totpSecretEncrypted !== null,
            emailVerified: u.emailVerifiedAt !== null,
            failedLoginCount: u.failedLoginCount,
          }),
        )}
      />
    </div>
  );
}

/**
 * Predicate per filter. Excludes disabled accounts from every
 * bucket (matches `userAttentionCounts` semantics — disabled
 * accounts aren't actionable). The `unverified` predicate also
 * skips SSO-only accounts (IdP handles email verification).
 */
function matchesFilter(u: User, filter: UserFilter): boolean {
  if (u.disabledAt !== null) return false;
  switch (filter) {
    case "locked":
      return u.lockedUntil !== null && u.lockedUntil.getTime() > Date.now();
    case "no-mfa":
      // SSO-only users (no local password) defer MFA to the IdP —
      // skip them so the chip surfaces only the local-password
      // accounts that actually need to enroll TOTP.
      return u.totpSecretEncrypted === null && u.passwordHash !== null;
    case "unverified":
      return u.emailVerifiedAt === null && u.passwordHash !== null;
    case "must-change":
      return u.mustChangePassword;
  }
}

/**
 * Filter chip row. "All" is always present + active when no filter
 * is set. Each chip is a Link with `?filter=`; the active chip
 * renders with the accent background so the operator can see at a
 * glance what's narrowing the view. `totalAll` is shown on the
 * "All" chip so the operator knows what the unfiltered count is.
 */
function FilterChips({ active, totalAll }: { active: UserFilter | null; totalAll: number }) {
  const chips: Array<{ key: UserFilter | null; label: string; suffix?: string }> = [
    { key: null, label: "All", suffix: `(${totalAll})` },
    { key: "locked", label: FILTER_LABELS.locked },
    { key: "no-mfa", label: FILTER_LABELS["no-mfa"] },
    { key: "unverified", label: FILTER_LABELS.unverified },
    { key: "must-change", label: FILTER_LABELS["must-change"] },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((c) => {
        const isActive = c.key === active;
        const href = c.key ? `/admin/users?filter=${c.key}` : "/admin/users";
        return (
          <Link
            key={c.key ?? "all"}
            href={href}
            className={
              isActive
                ? "rounded-full bg-[color:var(--color-accent)] px-3 py-1 text-xs font-medium text-[color:var(--color-accent-fg)]"
                : "rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-3 py-1 text-xs hover:bg-[color:var(--color-bg-muted)]"
            }
          >
            {c.label}
            {c.suffix ? <span className="ml-1 opacity-70">{c.suffix}</span> : null}
          </Link>
        );
      })}
    </div>
  );
}
