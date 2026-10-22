/**
 * app/(app)/zones/new-record/page.tsx
 *
 * Add record wizard landing. Permission: `record.create` globally or on at
 * least one zone through a zone_grant or a zone-scoped role
 * (`canUseRecordWizard`, the same check the Zones page uses for its button). The
 * wizard's zone search only offers zones the caller may write to (each hit
 * carries `canCreate`, decided per zone on the server), so admitting a
 * zone-level operator here leaks nothing.
 *
 * Everything else (horizon totals, zone search, existence checks, the write,
 * propagation) is fetched by the client wizard from the zones API, so this
 * page only reads the URL prefill the Reverse DNS page and the zones table
 * deep-link with.
 */

import { redirect } from "next/navigation";
import { requireUserForPage } from "@/lib/auth/require-user";
import { canUseRecordWizard } from "@/lib/rbac/zone-permissions";
import { parseWizardPrefill } from "@/components/domain/record-wizard-format";
import { AddRecordWizard } from "./_components/add-record-wizard";

export const metadata = { title: "Add record" };

export default async function NewRecordPage({
  searchParams,
}: {
  searchParams: Promise<{
    zone?: string;
    server?: string;
    name?: string;
    type?: string;
    content?: string;
  }>;
}) {
  // Not `anyInstance`: the CASL ability carries zone-scoped roles but not
  // zone_grants, so a grant-only operator would be refused.
  const auth = await requireUserForPage();
  if (!canUseRecordWizard(auth)) {
    redirect("/dashboard?flash=forbidden&need=record.create");
  }
  const prefill = parseWizardPrefill(await searchParams);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Add record</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Add one record to any zone you may edit: pick the zone, describe the record, review the
          change and watch it reach every backend.
        </p>
      </header>

      <AddRecordWizard prefill={prefill} />
    </div>
  );
}
