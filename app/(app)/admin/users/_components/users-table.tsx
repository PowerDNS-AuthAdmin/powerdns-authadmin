"use client";

/**
 * app/(app)/admin/users/_components/users-table.tsx
 *
 * Client wrapper around the shared `<DataTable>` for the admin
 * users list. Adds sortable columns + global search; the filter
 * chips (URL-driven, server-rendered) live on the page above us
 * and compose without overlap - chips narrow the dataset, search
 * narrows further within the chip selection.
 *
 * Rows arrive pre-formatted: dates are server-side
 * `toLocaleString()` strings (project-hydration-locale-dates rule)
 * AND ISO strings (for stable sorting). The Status / Security cells
 * are renderers that map structured props to chips/dots - no Date
 * math on the client.
 */

import Link from "next/link";
import { useMemo } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { Check, X } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { LocalTime } from "@/components/ui/local-time";
import { freshnessOf } from "@/lib/freshness";

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  // Pre-formatted for display; ISO for sort. Both server-rendered.
  lastSignInDisplay: string;
  lastSignInIso: string | null;
  /**
   * ISO timestamp of the latest admin edit to this user row (Tick
   * 89). Distinct from `lastSignInIso` - that's the USER signing
   * in; this is an ADMIN editing the row. Null when no admin edits
   * recorded, or when the actor lacks `audit.read`.
   */
  lastAdminEditIso: string | null;
  rolesCount: number;
  // Structured signals - rendered as Status / Security cells, not
  // pre-rendered strings, so the chips stay JSX (and the cell
  // renderer functions stay reusable).
  disabledAt: string | null;
  lockedUntilIso: string | null;
  mustChangePassword: boolean;
  ssoOnly: boolean;
  mfaEnrolled: boolean;
  emailVerified: boolean;
  failedLoginCount: number;
}

export function UsersTable({
  rows,
  showLastAdminEdit,
}: {
  rows: UserRow[];
  /**
   * Whether to render the "Last admin edit" column. When false the
   * column is omitted entirely (not just blanked) - keeps the table
   * compact for actors without `audit.read`, matching the
   * /admin/servers (T-88) and /zones (T-87) approach.
   */
  showLastAdminEdit: boolean;
}) {
  const columns = useMemo<Array<ColumnDef<UserRow, unknown>>>(() => {
    const baseCols: Array<ColumnDef<UserRow, unknown>> = [
      {
        accessorKey: "email",
        header: "Email",
        cell: (ctx) => <span className="font-medium">{ctx.getValue<string>()}</span>,
      },
      {
        accessorKey: "name",
        header: "Name",
        cell: (ctx) => ctx.getValue<string | null>() ?? "-",
      },
      {
        id: "status",
        header: "Status",
        enableSorting: false,
        cell: (ctx) => (
          <UserStatus
            disabledAt={ctx.row.original.disabledAt}
            ssoOnly={ctx.row.original.ssoOnly}
            mustChangePassword={ctx.row.original.mustChangePassword}
            lockedUntilIso={ctx.row.original.lockedUntilIso}
          />
        ),
      },
      {
        id: "security",
        header: "Security",
        enableSorting: false,
        cell: (ctx) => (
          <SecurityChips
            mfaEnrolled={ctx.row.original.mfaEnrolled}
            emailVerified={ctx.row.original.emailVerified}
            ssoOnly={ctx.row.original.ssoOnly}
            failedLoginCount={ctx.row.original.failedLoginCount}
          />
        ),
      },
      {
        // Sort by the ISO string so it orders correctly. Render the
        // value via <LocalTime> so the browser shows it in the local
        // zone - "Never" falls through when iso is null.
        accessorKey: "lastSignInIso",
        header: "Last sign-in",
        sortUndefined: "last",
        cell: (ctx) => (
          <span className="text-xs">
            <LocalTime ts={ctx.row.original.lastSignInIso} fallback="Never" />
          </span>
        ),
      },
      {
        accessorKey: "rolesCount",
        header: "Roles",
        cell: (ctx) => <span className="text-xs">{ctx.getValue<number>()}</span>,
      },
    ];

    if (showLastAdminEdit) {
      baseCols.push({
        accessorKey: "lastAdminEditIso",
        header: "Last admin edit",
        // ISO sort is chronological; nulls sort last when desc.
        sortUndefined: "last",
        cell: (ctx) => {
          const iso = ctx.getValue<string | null>();
          if (!iso) return <span className="text-xs text-[color:var(--color-fg-muted)]">-</span>;
          return (
            <span className="text-xs text-[color:var(--color-fg-muted)]" title={iso}>
              {freshnessOf(iso).label}
            </span>
          );
        },
      });
    }

    baseCols.push({
      id: "actions",
      header: "",
      enableSorting: false,
      cell: (ctx) => (
        <Link
          href={`/admin/users/${ctx.row.original.id}`}
          className="text-[color:var(--color-accent)] hover:underline"
        >
          Manage
        </Link>
      ),
    });

    return baseCols;
  }, [showLastAdminEdit]);

  return (
    <DataTable
      columns={columns}
      data={rows}
      searchPlaceholder="Search by email or name…"
      initialSort={[{ id: "email", desc: false }]}
      sortParam="sort"
      pageSizeParam="pageSize"
      rowHref={(r) => `/admin/users/${r.id}`}
      noDataMessage="No users match this filter."
    />
  );
}

function UserStatus({
  disabledAt,
  ssoOnly,
  mustChangePassword,
  lockedUntilIso,
}: {
  disabledAt: string | null;
  ssoOnly: boolean;
  mustChangePassword: boolean;
  lockedUntilIso: string | null;
}) {
  if (disabledAt) {
    return (
      <span className="inline-flex items-center gap-1 text-xs">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-fg-subtle)]" />
        Disabled
      </span>
    );
  }
  // Compare via Date.parse to keep the client out of Date math
  // beyond what's strictly needed - ISO parsing is well-defined.
  if (lockedUntilIso && Date.parse(lockedUntilIso) > Date.now()) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs"
        title={`Auto-unlocks at ${lockedUntilIso}`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-error)]" />
        Locked out
      </span>
    );
  }
  if (mustChangePassword) {
    return (
      <span className="inline-flex items-center gap-1 text-xs">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-warn)]" />
        Must change password
      </span>
    );
  }
  if (ssoOnly) {
    return (
      <span className="inline-flex items-center gap-1 text-xs">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-accent)]" />
        SSO only
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-success)]" />
      Active
    </span>
  );
}

function SecurityChips({
  mfaEnrolled,
  emailVerified,
  ssoOnly,
  failedLoginCount,
}: {
  mfaEnrolled: boolean;
  emailVerified: boolean;
  ssoOnly: boolean;
  failedLoginCount: number;
}) {
  // SSO accounts authenticate through the identity provider - MFA and email
  // verification are the IdP's responsibility, so the app-level flags don't
  // apply. Show a placeholder instead of a misleading "MFA ✗".
  if (ssoOnly) {
    return (
      <span
        title="Single sign-on account - authentication, MFA, and email verification are handled by the identity provider."
        className="text-[0.6875rem] tracking-wide text-[color:var(--color-fg-subtle)]"
      >
        SSO · managed by IdP
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-3">
      <SecurityFlag
        label="MFA"
        ok={mfaEnrolled}
        title={mfaEnrolled ? "Two-factor authentication enrolled." : "No second factor enrolled."}
      />
      <SecurityFlag
        label="EMAIL"
        ok={emailVerified}
        title={emailVerified ? "Email address verified." : "Email address not yet verified."}
      />
      {failedLoginCount > 0 ? (
        <span
          title={`${failedLoginCount} consecutive failed login attempt${failedLoginCount === 1 ? "" : "s"} since the last success.`}
          className="rounded bg-[color:var(--color-error)]/15 px-1.5 py-0.5 font-mono text-[0.625rem] text-[color:var(--color-error)]"
        >
          {failedLoginCount} fail
        </span>
      ) : null}
    </span>
  );
}

/** A security mechanism + a small green tick / red cross. */
function SecurityFlag({ label, ok, title }: { label: string; ok: boolean; title: string }) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 text-[0.6875rem] tracking-wide text-[color:var(--color-fg-muted)]"
    >
      {label}
      {ok ? (
        <Check aria-hidden size={13} className="text-[color:var(--color-success)]" />
      ) : (
        <X aria-hidden size={13} className="text-[color:var(--color-error)]" />
      )}
    </span>
  );
}
