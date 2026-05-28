"use client";

/**
 * app/(app)/admin/authentication/_components/authentication-table.tsx
 *
 * The unified list of sign-in methods rendered on /admin/authentication.
 * One row per provider, columns: icon · name · protocol chip · description ·
 * enabled badge · edit link. Built on the shared <DataTable> so it reflows
 * into labelled cards under md (mobile-first).
 *
 * Per-protocol edit pages live elsewhere:
 *   - Local Auth → /admin/settings
 *   - OIDC (DB) → /admin/oidc-providers/<id>
 *   - OIDC (env) → no editor (env vars only — row badged "ENV")
 *
 * PR 2 (LDAP) and PR 3 (SAML) add their own rows + detail pages and plug
 * into this same table by adding to the parent's `AuthRow[]`.
 */

import Link from "next/link";
import { useMemo } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";

export interface AuthRow {
  /**
   * Disambiguates rendering for the same protocol — `oidc-env` is read-only,
   * `oidc-db` is editable, `local` routes to the global Settings page,
   * `saml-db` routes to the SAML provider detail page,
   * `ldap-db` is the per-row LDAP entry (no env analogue).
   */
  kind: "local" | "oidc-db" | "oidc-env" | "saml-db" | "ldap-db";
  /** Stable react key. For "local" and "oidc-env" not a DB id. */
  id: string;
  slug: string;
  name: string;
  /** Secondary line under the name (issuer URL, description, …). */
  description: string;
  enabled: boolean;
  /** Chip text — "Local", "OIDC", "SAML", "LDAP". */
  protocol: "Local" | "OIDC" | "SAML" | "LDAP";
  /** Edit destination. Null when there's nothing to edit (env-only OIDC). */
  detailHref: string | null;
  /** When false, the row shows "View" instead of "Edit" / "Read-only". */
  canEdit: boolean;
  iconUrl: string | null;
}

export function AuthenticationTable({ rows }: { rows: AuthRow[] }) {
  const columns = useMemo<Array<ColumnDef<AuthRow, unknown>>>(
    () => [
      {
        id: "icon",
        header: "",
        enableSorting: false,
        cell: (ctx) => {
          const r = ctx.row.original;
          return r.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={r.iconUrl}
              alt=""
              style={{ width: 20, height: 20, objectFit: "contain", display: "block" }}
            />
          ) : (
            <span className="block h-5 w-5 rounded bg-[color:var(--color-bg-muted)]" aria-hidden />
          );
        },
      },
      {
        accessorKey: "name",
        header: "Name",
        cell: (ctx) => (
          <span className="inline-flex items-center gap-2">
            <span className="font-medium">{ctx.row.original.name}</span>
            {ctx.row.original.kind === "oidc-env" ? (
              <span
                className="rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-muted)] px-2 py-0.5 text-[0.625rem] font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase"
                title="Configured via OIDC_* environment variables. Edit by changing env vars, not the UI."
              >
                Env
              </span>
            ) : null}
          </span>
        ),
      },
      {
        accessorKey: "protocol",
        header: "Protocol",
        cell: (ctx) => (
          <span className="inline-flex items-center rounded-full bg-[color:var(--color-bg-muted)] px-2 py-0.5 font-mono text-[0.625rem] tracking-wider uppercase">
            {ctx.row.original.protocol}
          </span>
        ),
      },
      {
        accessorKey: "description",
        header: "Description",
        cell: (ctx) => (
          // Wrap, don't truncate — same posture as the role-description column
          // we added in the previous PR. The text is long enough to be the
          // operator's "how is this configured" cue at a glance.
          <span className="block max-w-prose text-xs whitespace-normal text-[color:var(--color-fg-muted)]">
            {ctx.row.original.description}
          </span>
        ),
      },
      {
        accessorKey: "enabled",
        header: "Enabled",
        cell: (ctx) =>
          ctx.row.original.enabled ? (
            <span className="rounded-full bg-[color:var(--color-success)]/15 px-2 py-0.5 text-xs">
              Yes
            </span>
          ) : (
            <span className="rounded-full bg-[color:var(--color-fg-muted)]/15 px-2 py-0.5 text-xs">
              No
            </span>
          ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: (ctx) => {
          const r = ctx.row.original;
          if (!r.detailHref) {
            return (
              <span
                className="text-xs text-[color:var(--color-fg-muted)]"
                title="Read-only — configured by environment variables."
              >
                Read-only
              </span>
            );
          }
          return (
            <Link href={r.detailHref} className="text-sm underline">
              {r.canEdit ? "Edit" : "View"}
            </Link>
          );
        },
      },
    ],
    [],
  );

  return (
    <DataTable
      data={rows}
      columns={columns}
      pageSize={Math.max(rows.length, 10)}
      hidePagination
      hideSearch
      stateKey="authentication-list"
      emptyMessage="No sign-in methods match."
      noDataMessage="No sign-in methods configured yet."
    />
  );
}
