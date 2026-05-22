/**
 * app/(app)/admin/audit/page.tsx
 *
 * Audit log viewer. RSC; filters read from the query string so a URL can be
 * bookmarked/shared. Permission: audit.read.
 *
 * Filters: actor type, actor id, action, resource type/id, ISO date range.
 * Pagination: limit (max 500) + offset, prev/next links carry filters.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { queryAuditLog } from "@/lib/db/repositories/audit";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { auditQuerySchema } from "@/lib/validators/audit";
import { BareDiff } from "@/app/(app)/zones/[zoneId]/_components/bare-diff";
import {
  PdnsHttpLog,
  type PdnsHttpLogEntry,
} from "@/app/(app)/zones/[zoneId]/_components/pdns-http-log";
import { findPdnsRequestsByRequestIds } from "@/lib/db/repositories/pdns-requests";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import type { PdnsRequestRow } from "@/lib/db/schema";
import { jsonToDiffLines } from "@/lib/diff/json-lines";
import { LiveFeedSubscriber } from "@/components/ui/live-feed-subscriber";
import { LocalTime } from "@/components/ui/local-time";
import { AuditFilterForm } from "./_components/audit-filter-form";

/**
 * Quick-filter chips. Each is a curated subset of the audit query
 * space that operators reach for during incident response. Reads as
 * regular URL params so deep-links work and the chips stay
 * server-rendered (no JS state).
 */
interface QuickFilter {
  label: string;
  description: string;
  params: Record<string, string>;
}

function quickFilters(): QuickFilter[] {
  // 24h ago in UTC midnight precision. Good enough for "recent" —
  // operators rarely need minute-level prefixes from the chips.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yyyy = yesterday.getUTCFullYear();
  const mm = String(yesterday.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(yesterday.getUTCDate()).padStart(2, "0");
  const from24h = `${yyyy}-${mm}-${dd}`;
  return [
    {
      label: "Last 24h",
      description: "Everything in the past day.",
      params: { from: from24h },
    },
    {
      label: "Failed sign-ins",
      description: "auth.login.failure across all reasons.",
      params: { action: "auth.login.failure" },
    },
    {
      label: "Password resets",
      description: "Reset requests, completions, invalid attempts.",
      params: { resourceType: "user", action: "auth.password.reset.requested" },
    },
    {
      label: "MFA admin changes",
      description: "TOTP enrolled / removed.",
      params: { action: "auth.mfa.removed" },
    },
    {
      label: "Session revocations",
      description: "Admin-driven session revokes for incident response.",
      params: { action: "user.sessions.revoked" },
    },
  ];
}

/**
 * The action vocabulary grouped by leading namespace, for
 * `<optgroup>` rendering. Ordering inside each group preserves the
 * vocabulary's declaration order (which roughly tracks lifecycle:
 * create → update → delete).
 */
function groupedActions(): Record<string, readonly string[]> {
  const groups: Record<string, string[]> = {};
  for (const a of AUDIT_ACTIONS) {
    const dot = a.indexOf(".");
    const ns = dot === -1 ? "(other)" : a.slice(0, dot);
    (groups[ns] ??= []).push(a);
  }
  return groups;
}

export const metadata: Metadata = { title: "Audit log" };

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AuditLogPage({ searchParams }: PageProps) {
  const { ability } = await requireUserForPage({ can: "audit.read" });
  // Per-resource navigation perms. Each ability gates one resource-
  // type link in the table. Operators without a given perm see
  // plain text instead of a Link — clicking a missing-perm link
  // would either 404 or land on a forbidden redirect, both of
  // which are worse than no link. Computed once at the top so the
  // cell renderer below doesn't re-call `ability.can` per row.
  const navAbilities = {
    user: ability.can("read", "User"),
    team: ability.can("read", "Team"),
    role: ability.can("read", "Role"),
    server: ability.can("read", "Server"),
    oidc: ability.can("read", "Oidc"),
    template: ability.can("use", "Template"),
  };
  const raw = await searchParams;
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") flat[k] = v;
  }

  const parsed = auditQuerySchema.safeParse(flat);
  if (!parsed.success) {
    return (
      <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-4 text-sm text-[color:var(--color-error)]">
        Invalid filters in URL.
      </div>
    );
  }
  const filters = parsed.data;
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  // Bare `YYYY-MM-DD` is friendly to type but parses as 00:00 UTC.
  // For `to` that means rows from that day get excluded by mistake.
  // Bump bare-date `to` forward by one day so the filter is "up to
  // and including this day." `from` stays at 00:00 UTC, which is
  // already what operators want for "starting on this day."
  const TO_END_OF_DAY_BUMP_MS = 24 * 60 * 60 * 1000;
  const isBareDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

  const page = await queryAuditLog(
    {
      ...(filters.actorId ? { actorId: filters.actorId } : {}),
      ...(filters.actorType ? { actorType: filters.actorType } : {}),
      ...(filters.action ? { action: filters.action } : {}),
      ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
      ...(filters.resourceId ? { resourceId: filters.resourceId } : {}),
      ...(filters.requestId ? { requestId: filters.requestId } : {}),
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.from ? { from: new Date(filters.from) } : {}),
      ...(filters.to
        ? {
            to: new Date(
              isBareDate(filters.to)
                ? new Date(filters.to).getTime() + TO_END_OF_DAY_BUMP_MS
                : filters.to,
            ),
          }
        : {}),
    },
    { limit, offset },
  );

  // Per-operation PDNS HTTP log. Batched lookup keyed on the audit row's
  // requestId — we render a collapsible inside each row's before/after
  // panel so an operator can see exactly what hit PDNS for that operation.
  const pdnsRequestIds = Array.from(
    new Set(
      page.entries
        .map((r) => r.requestId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  const [pdnsHttpByRequestId, allPdnsServers]: [
    Map<string, PdnsRequestRow[]>,
    Awaited<ReturnType<typeof listAllPdnsServers>>,
  ] = await Promise.all([
    pdnsRequestIds.length > 0
      ? findPdnsRequestsByRequestIds(pdnsRequestIds)
      : Promise.resolve(new Map<string, PdnsRequestRow[]>()),
    listAllPdnsServers(),
  ]);
  const serverById = new Map(allPdnsServers.map((s) => [s.id, s]));
  const serverBySlug = new Map(allPdnsServers.map((s) => [s.slug, s]));
  function httpEntriesFor(
    requestId: string | null | undefined,
    action: string,
  ): PdnsHttpLogEntry[] {
    if (!requestId) return [];
    const rows = pdnsHttpByRequestId.get(requestId);
    if (!rows) return [];
    const all = rows.map((row) => {
      const server =
        (row.serverId ? serverById.get(row.serverId) : null) ??
        (row.serverSlug ? serverBySlug.get(row.serverSlug) : null) ??
        null;
      return {
        id: String(row.id),
        ts: row.ts.toISOString(),
        serverSlug: row.serverSlug ?? null,
        serverName: server?.name ?? null,
        serverDbId: server?.id ?? null,
        op: row.op,
        method: row.method,
        url: row.url,
        requestHeaders: row.requestHeaders ?? null,
        requestBody: row.requestBody,
        responseStatus: row.responseStatus ?? null,
        error: row.error ?? null,
      };
    });
    // Split notify and other side-effect HTTP per audit action so an
    // operation with multiple audit rows doesn't double-render the
    // same three requests under every row.
    if (action === "zone.notify") return all.filter((e) => /notify/i.test(e.op));
    if (action.startsWith("zone.metadata.")) return all.filter((e) => /metadata/i.test(e.op));
    if (action.startsWith("dnssec.cryptokey.")) return all.filter((e) => /cryptokey/i.test(e.op));
    if (
      action.startsWith("record.") ||
      action === "zone.create" ||
      action === "zone.delete" ||
      action === "zone.settings.update"
    ) {
      return all.filter((e) => !/notify/i.test(e.op));
    }
    return all;
  }

  const prevHref =
    offset > 0 ? buildHref(flat, { offset: String(Math.max(0, offset - limit)) }) : null;
  const nextHref =
    offset + limit < page.total ? buildHref(flat, { offset: String(offset + limit) }) : null;

  return (
    <div className="space-y-6">
      <header>
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
          <LiveFeedSubscriber eventTypes={["audit.appended"]} />
        </div>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Append-only record of state-changing actions. Filters are passed as query parameters and
          can be bookmarked.
        </p>
      </header>

      <div className="flex flex-wrap gap-2">
        {quickFilters().map((q) => {
          const href = `/admin/audit?${new URLSearchParams(q.params).toString()}`;
          return (
            <Link
              key={q.label}
              href={href}
              title={q.description}
              className="rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-3 py-1 text-xs hover:bg-[color:var(--color-bg-muted)]"
            >
              {q.label}
            </Link>
          );
        })}
      </div>

      <AuditFilterForm
        initial={{
          action: filters.action ?? "",
          actorType: filters.actorType ?? "",
          resourceType: filters.resourceType ?? "",
          actorId: filters.actorId ?? "",
          resourceId: filters.resourceId ?? "",
          requestId: filters.requestId ?? "",
          q: filters.q ?? "",
          from: filters.from ?? "",
          to: filters.to ?? "",
        }}
        actionGroups={Object.entries(groupedActions()).map(([ns, actions]) => ({
          ns,
          actions,
        }))}
        hasFilters={Boolean(
          filters.action ??
          filters.actorType ??
          filters.resourceType ??
          filters.actorId ??
          filters.resourceId ??
          filters.requestId ??
          filters.q ??
          filters.from ??
          filters.to,
        )}
      />

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          Showing {page.entries.length === 0 ? 0 : offset + 1}–{offset + page.entries.length} of{" "}
          {page.total}.
        </p>
        {page.total > 0 ? (
          <Link
            href={`/api/admin/audit/export?${new URLSearchParams(
              Object.fromEntries(
                Object.entries(flat).filter(
                  ([k, v]) => v !== "" && k !== "limit" && k !== "offset",
                ),
              ),
            ).toString()}`}
            className="rounded-md border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-bg-muted)]"
            // Force a real download rather than navigating — Next's
            // <Link> normally prefetches; the API route streams CSV
            // so let the browser handle it as a binary response.
            prefetch={false}
          >
            Export CSV
          </Link>
        ) : null}
      </div>

      {page.entries.length === 0 ? (
        <div className="rounded-md border border-dashed border-[color:var(--color-border)] p-8 text-center text-sm text-[color:var(--color-fg-muted)]">
          No entries match.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-bg-subtle)] text-left text-xs tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Actor</th>
                <th className="px-4 py-2">Action</th>
                <th className="px-4 py-2">Resource</th>
                <th className="px-4 py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {page.entries.map((entry) => (
                <tr
                  key={String(entry.id)}
                  className="border-t border-[color:var(--color-border)] align-top"
                >
                  <td className="px-4 py-3 font-mono text-xs">
                    <LocalTime ts={entry.ts} />
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div>{entry.actorType}</div>
                    {entry.actorEmail ? (
                      // Email is the operator-friendly identifier;
                      // surface it above the UUID when available
                      // (deleted users / system / token actors fall
                      // back to UUID-only rendering below). Linked
                      // to the user-detail page when the operator
                      // has user.read so investigations get a one-
                      // click pivot from "who did this" to "manage
                      // them".
                      navAbilities.user && entry.actorType === "user" && entry.actorId ? (
                        <Link
                          href={`/admin/users/${entry.actorId}`}
                          className="block truncate text-[color:var(--color-accent)] hover:underline"
                          title={entry.actorEmail}
                        >
                          {entry.actorEmail}
                        </Link>
                      ) : (
                        <div className="truncate" title={entry.actorEmail}>
                          {entry.actorEmail}
                        </div>
                      )
                    ) : null}
                    {entry.actorId ? (
                      <div className="truncate font-mono text-[0.625rem] text-[color:var(--color-fg-muted)]">
                        {entry.actorId}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{entry.action}</td>
                  <td className="px-4 py-3 text-xs">
                    <div>{entry.resourceType}</div>
                    {entry.resourceId
                      ? (() => {
                          const href = resourceLinkHref(
                            entry.resourceType,
                            entry.resourceId,
                            navAbilities,
                          );
                          if (href) {
                            return (
                              <Link
                                href={href}
                                className="block truncate font-mono text-[color:var(--color-accent)] hover:underline"
                                title={entry.resourceId}
                              >
                                {entry.resourceId}
                              </Link>
                            );
                          }
                          return (
                            <div
                              className="truncate font-mono text-[color:var(--color-fg-muted)]"
                              title={entry.resourceId}
                            >
                              {entry.resourceId}
                            </div>
                          );
                        })()
                      : null}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {entry.before || entry.after ? (
                      <details className="space-y-1">
                        <summary className="cursor-pointer text-[color:var(--color-accent)] hover:underline">
                          before/after
                        </summary>
                        <div className="mt-1 max-w-md overflow-hidden rounded border border-[color:var(--color-border)]">
                          <BareDiff
                            removed={jsonToDiffLines(entry.before)}
                            added={jsonToDiffLines(entry.after)}
                            layout="stacked"
                          />
                        </div>
                      </details>
                    ) : null}
                    {(() => {
                      const httpEntries = httpEntriesFor(entry.requestId, entry.action);
                      return httpEntries.length > 0 ? (
                        <div className="mt-1 max-w-md overflow-hidden rounded border border-[color:var(--color-border)]">
                          <PdnsHttpLog entries={httpEntries} />
                        </div>
                      ) : null;
                    })()}
                    {entry.ip ? (
                      <div className="text-[color:var(--color-fg-muted)]">ip: {entry.ip}</div>
                    ) : null}
                    {entry.requestId ? (
                      <div className="text-[color:var(--color-fg-muted)]">
                        req:{" "}
                        <Link
                          href={`/admin/audit?${new URLSearchParams({ requestId: entry.requestId }).toString()}`}
                          className="font-mono text-[color:var(--color-accent)] hover:underline"
                          title="Filter to all rows from this request"
                        >
                          {entry.requestId}
                        </Link>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <nav className="flex items-center justify-between text-sm">
        {prevHref ? (
          <Link href={prevHref} className="text-[color:var(--color-accent)] hover:underline">
            ← Newer
          </Link>
        ) : (
          <span />
        )}
        {nextHref ? (
          <Link href={nextHref} className="text-[color:var(--color-accent)] hover:underline">
            Older →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </div>
  );
}

function buildHref(current: Record<string, string>, overrides: Record<string, string>): string {
  const params = new URLSearchParams(current);
  for (const [k, v] of Object.entries(overrides)) {
    params.set(k, v);
  }
  return `/admin/audit?${params.toString()}`;
}

/**
 * Map an audit row's (resourceType, resourceId) to the admin
 * detail page that knows about it — gated by the per-type read
 * permission so missing-perm operators don't get a clickable
 * dead-end. Returns `null` when no linkable destination applies
 * (caller falls back to plain-text render).
 *
 * Not-yet-linked:
 *   - `session` / `api-token` / `auth` — no admin detail page
 *      (sessions are managed under the user-detail page; tokens
 *      similarly). Could link to the parent user but the audit
 *      row's resourceId is the session/token id, not the userId
 *      — would need a denormalization or join we don't have.
 *   - `zone` — the audit stores the zone id which is the
 *      canonical zone name (PDNS convention). /zones/[zoneId]
 *      expects URL-encoded form; safe to link in principle but
 *      deferred until we add an integration test that exercises
 *      special-character zone names.
 *   - `audit` — meta-resource for export rows; self-reference.
 */
interface NavAbilities {
  user: boolean;
  team: boolean;
  role: boolean;
  server: boolean;
  oidc: boolean;
  template: boolean;
}

function resourceLinkHref(
  resourceType: string,
  resourceId: string,
  nav: NavAbilities,
): string | null {
  const enc = encodeURIComponent(resourceId);
  switch (resourceType) {
    case "user":
      return nav.user ? `/admin/users/${enc}` : null;
    case "team":
      return nav.team ? `/admin/teams/${enc}` : null;
    case "role":
      return nav.role ? `/admin/roles/${enc}` : null;
    case "pdns_server":
      return nav.server ? `/admin/servers/${enc}` : null;
    case "oidc_provider":
      return nav.oidc ? `/admin/oidc-providers/${enc}` : null;
    case "zone_template":
      return nav.template ? `/admin/zone-templates/${enc}` : null;
    default:
      return null;
  }
}
