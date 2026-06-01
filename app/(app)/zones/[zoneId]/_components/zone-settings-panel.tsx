"use client";

/**
 * Zone-object settings: Zone Type (kind), SOA-EDIT, SOA-EDIT-API,
 * API-RECTIFY, plus the masters list for Secondary zones. All routed
 * through `PUT /api/admin/pdns/zones/[id]/settings`, which forwards to
 * PDNS' `PUT /zones/{id}` - PDNS' metadata-endpoint allowlist doesn't
 * accept these kinds in 4.9, so the zone-object endpoint is the right
 * door.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";
import { Switch } from "@/components/ui/switch";

interface Props {
  zoneIdEncoded: string;
  serverSlug: string;
  initial: {
    kind: string;
    masters?: readonly string[];
    soa_edit?: string;
    soa_edit_api?: string;
    api_rectify?: boolean;
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

const SOA_EDIT_OPTIONS = [
  "DEFAULT",
  "INCREASE",
  "EPOCH",
  "INCEPTION-INCREMENT",
  "INCEPTION-EPOCH",
  "NONE",
] as const;

const SOA_EDIT_API_OPTIONS = [
  "DEFAULT",
  "INCREASE",
  "SOA-EDIT",
  "SOA-EDIT-INCREASE",
  "EPOCH",
  "NONE",
] as const;

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
  const [saving, setSaving] = useState(false);

  const dirty =
    kind !== initialKind ||
    mastersText !== (initial.masters ?? []).join("\n") ||
    soaEdit !== (initial.soa_edit ?? "") ||
    soaEditApi !== (initial.soa_edit_api ?? "") ||
    apiRectify !== (initial.api_rectify ?? false);

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
          <KindSelect value={kind} onChange={setKind} disabled={!canEdit} />
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
          <EnumSelect
            value={soaEdit}
            options={SOA_EDIT_OPTIONS}
            onChange={setSoaEdit}
            disabled={!canEdit}
            placeholder="(server default)"
          />
        </Field>

        <Field
          label="SOA-EDIT-API"
          help="Algorithm PDNS uses to bump the SOA serial after API edits."
        >
          <EnumSelect
            value={soaEditApi}
            options={SOA_EDIT_API_OPTIONS}
            onChange={setSoaEditApi}
            disabled={!canEdit}
            placeholder="(server default)"
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
    <div>
      <label className="mb-1 block text-xs font-medium">{label}</label>
      {children}
      {help ? (
        <p className="mt-1 text-[0.6875rem] text-[color:var(--color-fg-muted)]">{help}</p>
      ) : null}
    </div>
  );
}

interface KindSelectProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

function KindSelect({ value, onChange, disabled }: KindSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = ZONE_KINDS.find((k) => k.value === value) ?? ZONE_KINDS[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1.5 text-left text-xs hover:border-[color:var(--color-fg-muted)] disabled:opacity-60"
      >
        <span>{current.label}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="ml-2 opacity-60">
          <path
            d="M2 4l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <ul
          role="listbox"
          className="absolute right-0 left-0 z-10 mt-1 overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] py-1 text-xs shadow-lg"
        >
          {ZONE_KINDS.map((k) => (
            <li
              key={k.value}
              role="option"
              aria-selected={k.value === value}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(k.value);
                setOpen(false);
              }}
              className={`cursor-pointer px-2 py-1.5 ${
                k.value === value
                  ? "bg-[color:var(--color-bg-subtle)] font-medium"
                  : "hover:bg-[color:var(--color-bg-subtle)]"
              }`}
            >
              <div>{k.label}</div>
              <div className="text-[0.625rem] text-[color:var(--color-fg-muted)]">
                {k.description}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface EnumSelectProps {
  value: string;
  options: readonly string[];
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

function EnumSelect({ value, options, onChange, disabled, placeholder }: EnumSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1.5 text-left font-mono text-xs hover:border-[color:var(--color-fg-muted)] disabled:opacity-60"
      >
        <span className={value ? "" : "text-[color:var(--color-fg-muted)]"}>
          {value !== "" ? value : (placeholder ?? "Select…")}
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="ml-2 opacity-60">
          <path
            d="M2 4l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open ? (
        <ul
          role="listbox"
          className="absolute right-0 left-0 z-10 mt-1 max-h-60 overflow-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] py-1 text-xs shadow-lg"
        >
          <li
            role="option"
            aria-selected={value === ""}
            onMouseDown={(e) => {
              e.preventDefault();
              onChange("");
              setOpen(false);
            }}
            className={`cursor-pointer px-2 py-1.5 text-[color:var(--color-fg-muted)] italic ${
              value === ""
                ? "bg-[color:var(--color-bg-subtle)]"
                : "hover:bg-[color:var(--color-bg-subtle)]"
            }`}
          >
            (unset - server default)
          </li>
          {options.map((o) => (
            <li
              key={o}
              role="option"
              aria-selected={o === value}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(o);
                setOpen(false);
              }}
              className={`cursor-pointer px-2 py-1.5 font-mono ${
                o === value
                  ? "bg-[color:var(--color-bg-subtle)] font-medium"
                  : "hover:bg-[color:var(--color-bg-subtle)]"
              }`}
            >
              {o}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
