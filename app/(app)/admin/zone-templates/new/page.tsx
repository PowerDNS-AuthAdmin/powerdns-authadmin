import { requireUserForPage } from "@/lib/auth/require-user";
import { listAllPrimaries } from "@/lib/db/repositories/pdns-servers";
import { ZoneTemplateForm } from "../_components/zone-template-form";

export const metadata = { title: "New zone template" };

export default async function NewZoneTemplatePage() {
  await requireUserForPage({ can: "template.manage" });
  const primaries = (await listAllPrimaries())
    .filter((p) => p.disabledAt === null)
    .map((p) => ({ id: p.id, name: p.name }));
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">New zone template</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Define defaults for new zones. Operators pick this template on the create-zone form and
          the NS records + SOA timers + prelude records are applied automatically.
        </p>
      </header>
      <ZoneTemplateForm mode="create" primaries={primaries} />
    </div>
  );
}
