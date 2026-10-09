"use client";

/**
 * Zone-object settings: Zone Type (kind), SOA-EDIT, SOA-EDIT-API,
 * API-RECTIFY, plus the masters list for Secondary zones. All routed
 * through `PUT /api/admin/pdns/zones/[id]/settings`, which forwards to
 * PDNS' `PUT /zones/{id}` - PDNS' metadata-endpoint allowlist doesn't
 * accept these kinds in 4.9, so the zone-object endpoint is the right
 * door.
 *
 * The panel also carries the one setting that ISN'T a PDNS zone-object field:
 * the zone's horizon (#121). PowerDNS has no notion of it - it's app-side
 * classification that decides whether this zone lists separately from a
 * same-named public zone - but from the operator's seat it's a zone setting
 * like any other, so it shares the panel and the Save button. The route sorts
 * the two halves out.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDialog } from "@/components/ui/dialog";
import { useUnsavedChangesGuard } from "@/components/ui/use-unsaved-changes-guard";
import { mutate } from "@/lib/client/api-fetch";
import { Switch } from "@/components/ui/switch";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { Field as SharedField } from "@/components/ui/form";
import { type ZoneHorizon } from "@/lib/dns/zone-horizon";

interface Props {
  zoneIdEncoded: string;
  serverSlug: string;
  initial: {
    kind: string;
    masters?: readonly string[];
    soa_edit?: string;
    soa_edit_api?: string;
    api_rectify?: boolean;
    /** App-side, not from PDNS. `public` unless the operator classified it. */
    horizon: ZoneHorizon;
  };
  canEdit: boolean;
}

// PDNS Authoritative still requires `Master`/`Slave` as the wire value for
// zone-kind (config settings + pdnsutil moved to Primary/Secondary, but the
// `POST /zones { kind }` payload didn't). UI labels use the modern names;
// the legacy string goes on the wire.
const ZONE_KINDS = [
  {
    value: "Native",
    label: "Native",
    description: "No replication. Single-server or backend-replicated.",
  },
  {
    value: "Master",
    label: "Primary",
    description: "Sends AXFR/NOTIFY to configured Secondaries.",
  },
  {
    value: "Slave",
    label: "Secondary",
    description: "Pulls AXFR from configured Primaries.",
  },
] as const;

// The empty value means "unset" - PDNS then falls back to the server-wide
// default, which is why it is offered as a pickable option rather than only
// as a placeholder.
const UNSET_OPTION: SelectOption<string> = { value: "", label: "(server default)" };

const SOA_EDIT_OPTIONS: ReadonlyArray<SelectOption<string>> = [
  UNSET_OPTION,
  ...["DEFAULT", "INCREASE", "EPOCH", "INCEPTION-INCREMENT", "INCEPTION-EPOCH", "NONE"].map(
    (value) => ({ value, label: value }),
  ),
];

const SOA_EDIT_API_OPTIONS: ReadonlyArray<SelectOption<string>> = [
  UNSET_OPTION,
  ...["DEFAULT", "INCREASE", "SOA-EDIT", "SOA-EDIT-INCREASE", "EPOCH", "NONE"].map((value) => ({
    value,
    label: value,
  })),
];

export function ZoneSettingsPanel({ zoneIdEncoded, serverSlug, initial, canEdit }: Props) {
  const router = useRouter();
  const { toast } = useDialog();

  // Normalize PDNS kind aliases to the canonical three we expose.
  const initialKind = normalizeKind(initial.kind);
  const [kind, setKind] = useState<string>(initialKind);
  const [mastersText, setMastersText] = useState(() => (initial.masters ?? []).join("\n"));
  const [soaEdit, setSoaEdit] = useState(initial.soa_edit ?? "");
  const [soaEditApi, setSoaEditApi] = useState(initial.soa_edit_api ?? "");
  const [apiRectify, setApiRectify] = useState(initial.api_rectify ?? false);
  const [internal, setInternal] = useState(initial.horizon === "internal");
  const [saving, setSaving] = useState(false);

  const initialInternal = initial.horizon === "internal";
  const dirty =
    kind !== initialKind ||
    mastersText !== (initial.masters ?? []).join("\n") ||
    soaEdit !== (initial.soa_edit ?? "") ||
    soaEditApi !== (initial.soa_edit_api ?? "") ||
    apiRectify !== (initial.api_rectify ?? false) ||
    internal !== initialInternal;
  useUnsavedChangesGuard(dirty);

  async function handleSave() {
    setSaving(true);
    try {
      interface Patch {
        serverSlug: string;
        kind?: string;
        masters?: string[];
        soa_edit?: string;
        soa_edit_api?: string;
        api_rectify?: boolean;
        horizon?: ZoneHorizon;
      }
      const patch: Patch = { serverSlug };
      if (kind !== initialKind) patch.kind = kind;
      if (kind === "Slave" || initialKind === "Slave") {
        const masters = mastersText
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (masters.join("\n") !== (initial.masters ?? []).join("\n")) {
          patch.masters = masters;
        }
      }
      if (soaEdit !== (initial.soa_edit ?? "")) patch.soa_edit = soaEdit;
      if (soaEditApi !== (initial.soa_edit_api ?? "")) patch.soa_edit_api = soaEditApi;
      if (apiRectify !== (initial.api_rectify ?? false)) patch.api_rectify = apiRectify;
      if (internal !== initialInternal) patch.horizon = internal ? "internal" : "public";

      const result = await mutate(`/api/admin/pdns/zones/${zoneIdEncoded}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Save failed",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: "Zone settings saved." });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-5">
      <header className="mb-4">
        <h2 className="text-base font-semibold">Zone settings</h2>
        <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
          Zone-object fields PDNS exposes outside the metadata-API allowlist. Routed through{" "}
          <code className="font-mono">PUT /zones/{`{id}`}</code>.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Zone Type"
          help="Native: no replication. Primary: sends AXFR. Secondary: pulls AXFR."
        >
          <SelectMenu value={kind} options={ZONE_KINDS} onChange={setKind} disabled={!canEdit} />
        </Field>

        {kind === "Slave" ? (
          <Field label="Primaries (masters)" help="One IP[:port] per line.">
            <textarea
              value={mastersText}
              onChange={(e) => setMastersText(e.target.value)}
              rows={Math.max(2, mastersText.split(/\r?\n/).length + 1)}
              disabled={!canEdit}
              placeholder="192.0.2.1 or 2001:db8::1:5300"
              className="block w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-2 font-mono text-xs disabled:opacity-60"
            />
          </Field>
        ) : null}

        <Field label="SOA-EDIT" help="Algorithm PDNS uses for the SOA serial sent to secondaries.">
          <SelectMenu
            value={soaEdit}
            options={SOA_EDIT_OPTIONS}
            onChange={setSoaEdit}
            disabled={!canEdit}
          />
        </Field>

        <Field
          label="SOA-EDIT-API"
          help="Algorithm PDNS uses to bump the SOA serial after API edits."
        >
          <SelectMenu
            value={soaEditApi}
            options={SOA_EDIT_API_OPTIONS}
            onChange={setSoaEditApi}
            disabled={!canEdit}
          />
        </Field>

        <Field label="API-RECTIFY" help="Rectify the zone automatically after every API change.">
          <div className="flex items-center gap-2">
            <Switch
              checked={apiRectify}
              onChange={setApiRectify}
              disabled={!canEdit}
              ariaLabel="API-RECTIFY"
            />
            <span className="font-mono text-xs">{apiRectify ? "enabled" : "disabled"}</span>
          </div>
        </Field>

        <Field
          label="This is an internal zone"
          help="Split-horizon: an internal zone lists separately from a public zone of the same name, and carries an INTERNAL badge. AuthAdmin-side only - nothing is sent to PowerDNS."
        >
          <div className="flex items-center gap-2">
            <Switch
              checked={internal}
              onChange={setInternal}
              disabled={!canEdit}
              ariaLabel="This is an internal zone"
            />
            <span className="font-mono text-xs">{internal ? "internal" : "public"}</span>
          </div>
        </Field>
      </div>

      {canEdit ? (
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
          {!dirty ? (
            <span className="text-[0.6875rem] text-[color:var(--color-fg-muted)]">
              No unsaved changes
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function normalizeKind(raw: string): string {
  // PDNS aliases Primary↔Master and Secondary↔Slave. Normalize to the
  // backend form so equality checks against ZONE_KINDS hit.
  if (raw === "Primary") return "Master";
  if (raw === "Secondary") return "Slave";
  return raw;
}

/** The panel's compact field: `help` is the hint line under the control. */
function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <SharedField label={label} hint={help} size="compact">
      {children}
    </SharedField>
  );
}
