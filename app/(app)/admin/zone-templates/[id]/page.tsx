/**
 * app/(app)/admin/zone-templates/[id]/page.tsx
 *
 * Tabbed template detail page that mirrors the zone-detail UX:
 *   - Header: name + slug + description (no serial / DNSSEC chip — templates
 *     don't carry per-zone state).
 *   - Tabs: Records · Zone settings · Metadata.
 *   - Audit panel + danger-zone section stay below the tabs.
 *
 * No SOA tab (template's "SOA timers" are zone-config defaults living on
 * the Zone settings tab), no DNSSEC tab, no Change-history tab (the
 * AdminAuditPanel covers it at the bottom).
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUserForPage } from "@/lib/auth/require-user";
import { findZoneTemplateById } from "@/lib/db/repositories/zone-templates";
import { listAllPrimaries } from "@/lib/db/repositories/pdns-servers";
import { recentAdminEditsForZoneTemplate } from "@/lib/db/repositories/audit-log";
import { AdminAuditPanel } from "@/components/domain/admin-audit-panel";
import { ZoneTemplateActions } from "../_components/zone-template-actions";
import { ZoneTemplateTabs, type TemplateTabKey } from "../_components/zone-template-tabs";
import { TemplateRecordsForm } from "../_components/template-records-form";
import { TemplateSettingsForm } from "../_components/template-settings-form";
import { TemplateMetadataForm } from "../_components/template-metadata-form";

export const metadata: Metadata = { title: "Zone template" };
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}

export default async function ZoneTemplateEditPage({ params, searchParams }: PageProps) {
  const { ability } = await requireUserForPage({ can: "template.use" });
  const canManage = ability.can("manage", "Template");
  const canReadAudit = ability.can("read", "Audit");
  const { id } = await params;
  const { tab: requestedTab } = await searchParams;
  const t = await findZoneTemplateById(id);
  if (!t) notFound();
  const [recentEdits, allPrimaries] = await Promise.all([
    canReadAudit ? recentAdminEditsForZoneTemplate(id, 10) : Promise.resolve([]),
    listAllPrimaries(),
  ]);
  const primaryOptions = allPrimaries
    .filter((p) => p.disabledAt === null)
    .map((p) => ({ id: p.id, name: p.name }));

  const tab: TemplateTabKey =
    requestedTab === "settings" ? "settings" : requestedTab === "metadata" ? "metadata" : "records";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t.name}</h1>
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          Slug <code className="rounded bg-[color:var(--color-bg-subtle)] px-1">{t.slug}</code> —
          slug can&apos;t be renamed.
        </p>
        {t.description ? (
          <p className="text-sm text-[color:var(--color-fg-muted)]">{t.description}</p>
        ) : null}
      </header>

      <ZoneTemplateTabs active={tab} templateId={id} />

      {tab === "records" ? (
        <TemplateRecordsForm
          templateId={id}
          initial={{ nameservers: t.nameservers, records: t.records }}
          canEdit={canManage}
        />
      ) : tab === "settings" ? (
        <TemplateSettingsForm
          initial={{
            id: t.id,
            kind: t.kind,
            soaEdit: t.soaEdit,
            soaEditApi: t.soaEditApi,
            apiRectify: t.apiRectify,
            soaTtl: t.soaTtl,
            soaRefresh: t.soaRefresh,
            soaRetry: t.soaRetry,
            soaExpire: t.soaExpire,
            soaMinimum: t.soaMinimum,
            defaultForPrimaryIds: t.defaultForPrimaryIds ?? [],
          }}
          canEdit={canManage}
          primaries={primaryOptions}
        />
      ) : (
        <TemplateMetadataForm templateId={id} initial={t.metadata} canEdit={canManage} />
      )}

      {canReadAudit ? (
        <AdminAuditPanel
          entries={recentEdits}
          fullHistoryHref={`/admin/audit?resourceType=zone_template&resourceId=${encodeURIComponent(id)}`}
        />
      ) : null}

      {canManage ? (
        <section className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/5 p-4">
          <h2 className="text-base font-medium text-[color:var(--color-error)]">Danger zone</h2>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Deleting the template doesn&apos;t touch zones already created from it — those zones own
            their records independently after creation.
          </p>
          <ZoneTemplateActions id={t.id} name={t.name} />
        </section>
      ) : null}
    </div>
  );
}
