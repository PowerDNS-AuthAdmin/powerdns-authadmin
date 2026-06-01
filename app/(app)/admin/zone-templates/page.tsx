/**
 * app/(app)/admin/zone-templates/page.tsx
 *
 * Zone-template list. Templates are reusable scaffolds applied at zone-
 * creation time - they seed NS records, SOA timers, and any prelude
 * records (MX, CAA, SPF…) the operator wants on every zone.
 */

import { requireUserForPage } from "@/lib/auth/require-user";
import { CreateButton } from "@/components/ui/create-button";
import { listAllZoneTemplates } from "@/lib/db/repositories/zone-templates";
import { latestAdminEditTimestampsForZoneTemplates } from "@/lib/db/repositories/audit-log";
import { listAllPrimaries } from "@/lib/db/repositories/pdns-servers";
import { ZoneTemplatesTable, type ZoneTemplateRow } from "./_components/zone-templates-table";

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

  const rows: ZoneTemplateRow[] = templates.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    description: t.description ?? null,
    defaultForNames: (t.defaultForPrimaryIds ?? [])
      .map((id) => primaryNameById.get(id))
      .filter((n): n is string => Boolean(n)),
    nameserverCount: t.nameservers.length,
    recordCount: t.records.length,
    lastAdminEditIso: lastEdits.get(t.id)?.toISOString() ?? null,
  }));

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Zone templates</h1>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Reusable scaffolds applied when creating a new zone - NS records, SOA timers, and any
            prelude records you want on every zone of this kind.
          </p>
        </div>
        {canManage ? <CreateButton href="/admin/zone-templates/new" label="Add template" /> : null}
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
        <ZoneTemplatesTable rows={rows} showLastAdminEdit={canReadAudit} canManage={canManage} />
      )}
    </div>
  );
}
