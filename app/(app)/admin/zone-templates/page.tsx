/**
 * app/(app)/admin/zone-templates/page.tsx
 *
 * Zone-template list. Templates are reusable scaffolds applied at zone-
 * creation time — they seed NS records, SOA timers, and any prelude
 * records (MX, CAA, SPF…) the operator wants on every zone.
 */

import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { listAllZoneTemplates } from "@/lib/db/repositories/zone-templates";
import { latestAdminEditTimestampsForZoneTemplates } from "@/lib/db/repositories/audit-log";
import { listAllPrimaries } from "@/lib/db/repositories/pdns-servers";
import { freshnessOf } from "@/lib/freshness";

export const metadata = { title: "Zone templates" };

export default async function ZoneTemplatesListPage() {
  const { ability } = await requireUserForPage({ can: "template.use" });
  const canManage = ability.can("manage", "Template");
  const canReadAudit = ability.can("read", "Audit");
  const [templates, primaries] = await Promise.all([listAllZoneTemplates(), listAllPrimaries()]);
  const primaryNameById = new Map(primaries.map((p) => [p.id, p.name]));
  const lastEdits =
    canReadAudit && templates.length > 0
      ? await latestAdminEditTimestampsForZoneTemplates(templates.map((t) => t.id))
      : new Map<string, Date>();

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Zone templates</h1>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Reusable scaffolds applied when creating a new zone — NS records, SOA timers, and any
            prelude records you want on every zone of this kind.
          </p>
        </div>
        {canManage ? (
          <Link
            href="/admin/zone-templates/new"
            className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
          >
            New template
          </Link>
        ) : null}
      </header>

      {templates.length === 0 ? (
        <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-8 text-center text-sm">
          <p className="text-[color:var(--color-fg-muted)]">
            No templates yet.{" "}
            {canManage ? (
              <>
                Add one to define a default NS set + SOA timers + prelude records that get applied
                whenever someone creates a new zone.
              </>
            ) : (
              "Ask an administrator to create one."
            )}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[color:var(--color-bg-subtle)] text-left text-xs tracking-wide text-[color:var(--color-fg-muted)] uppercase">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Slug</th>
                <th className="px-3 py-2">Nameservers</th>
                <th className="px-3 py-2">Records</th>
                {canReadAudit ? <th className="px-3 py-2">Last admin edit</th> : null}
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-t border-[color:var(--color-border)]">
                  <td className="px-3 py-2">
                    <div className="font-medium">{t.name}</div>
                    {t.description ? (
                      <div className="text-xs text-[color:var(--color-fg-muted)]">
                        {t.description}
                      </div>
                    ) : null}
                    {(() => {
                      const names = (t.defaultForPrimaryIds ?? [])
                        .map((id) => primaryNameById.get(id))
                        .filter((n): n is string => Boolean(n));
                      if (names.length === 0) return null;
                      return (
                        <div className="mt-1 flex items-center gap-1 text-xs text-[color:var(--color-success)]">
                          <svg
                            aria-hidden
                            viewBox="0 0 16 16"
                            className="h-3 w-3"
                            fill="currentColor"
                          >
                            <path d="M6.173 11.207 2.93 7.964l1.06-1.06 2.183 2.182 5.834-5.834 1.06 1.06z" />
                          </svg>
                          <span>
                            default for <span className="font-medium">{names.join(", ")}</span>
                          </span>
                        </div>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    <code className="rounded bg-[color:var(--color-bg-subtle)] px-1">{t.slug}</code>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {t.nameservers.length === 0 ? (
                      <span className="text-[color:var(--color-fg-muted)]">—</span>
                    ) : (
                      <span className="font-mono">
                        {t.nameservers.length} {t.nameservers.length === 1 ? "NS" : "NSs"}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{t.records.length}</td>
                  {canReadAudit ? (
                    <td className="px-3 py-2 text-xs text-[color:var(--color-fg-muted)]">
                      {lastEdits.has(t.id) ? (
                        <span title={lastEdits.get(t.id)!.toISOString()}>
                          {freshnessOf(lastEdits.get(t.id)!.toISOString()).label}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  ) : null}
                  <td className="px-3 py-2 text-right text-xs">
                    <Link
                      href={`/admin/zone-templates/${t.id}`}
                      className="text-[color:var(--color-accent)] hover:underline"
                    >
                      {canManage ? "Edit" : "View"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
