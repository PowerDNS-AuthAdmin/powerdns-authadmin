"use client";

/**
 * app/(app)/admin/zone-templates/_components/zone-template-form.tsx
 *
 * Create/edit form for a zone template. The form maps 1:1 to the template
 * row's columns:
 *
 *   - Identity:    slug (create-only), name, description
 *   - SOA timers:  ttl, refresh, retry, expire, minimum
 *   - NS list:     one host per row
 *   - Records:     prelude records, one row per (name, type, ttl, content)
 *
 * Per-record type-aware validation reuses the same `RRTypeValidator`
 * registry the zone-detail editor uses. Records use *relative* names
 * here ("@" for apex, "www" for www) — the create-zone path expands
 * them against the concrete zone at apply time.
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/client/api-fetch";
import { SUPPORTED_TYPES, getRRTypeValidator } from "@/lib/validators/rr-types";
import { SelectMenu } from "@/components/ui/select-menu";

interface TemplateRecord {
  name: string;
  type: string;
  ttl: number;
  content: string;
  disabled?: boolean;
}

interface InitialState {
  id: string;
  slug: string;
  name: string;
  description: string;
  soaTtl: number;
  soaRefresh: number;
  soaRetry: number;
  soaExpire: number;
  soaMinimum: number;
  nameservers: string[];
  records: TemplateRecord[];
  kind: string;
  soaEdit: string | null;
  soaEditApi: string | null;
  apiRectify: boolean | null;
  defaultForPrimaryIds: string[];
}

interface PrimaryOption {
  id: string;
  name: string;
}

interface CreateProps {
  mode: "create";
  initial?: undefined;
  canEdit?: undefined;
  primaries: PrimaryOption[];
}

interface EditProps {
  mode: "edit";
  initial: InitialState;
  canEdit: boolean;
  primaries: PrimaryOption[];
}

type Props = CreateProps | EditProps;

interface ErrorBody {
  error?: string;
  details?: { fieldErrors?: Record<string, string[]> };
}

const DEFAULTS: InitialState = {
  id: "",
  slug: "",
  name: "",
  description: "",
  soaTtl: 3600,
  soaRefresh: 3600,
  soaRetry: 900,
  soaExpire: 604800,
  soaMinimum: 3600,
  nameservers: [],
  records: [],
  kind: "Native",
  soaEdit: null,
  soaEditApi: null,
  apiRectify: null,
  defaultForPrimaryIds: [],
};

const ZONE_KIND_OPTIONS = [
  { value: "Native", label: "Native — no replication" },
  { value: "Master", label: "Primary (Master) — sends AXFR" },
  { value: "Slave", label: "Secondary (Slave) — pulls AXFR" },
];

const SOA_EDIT_OPTIONS = [
  "",
  "DEFAULT",
  "INCREASE",
  "EPOCH",
  "INCEPTION-INCREMENT",
  "INCEPTION-EPOCH",
  "NONE",
];

const SOA_EDIT_API_OPTIONS = [
  "",
  "DEFAULT",
  "INCREASE",
  "SOA-EDIT",
  "SOA-EDIT-INCREASE",
  "EPOCH",
  "NONE",
];

export function ZoneTemplateForm(props: Props) {
  const router = useRouter();
  const initial = props.mode === "edit" ? props.initial : DEFAULTS;
  const canEdit = props.mode === "create" ? true : props.canEdit;

  const [slug, setSlug] = useState(initial.slug);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [soaTtl, setSoaTtl] = useState(initial.soaTtl);
  const [soaRefresh, setSoaRefresh] = useState(initial.soaRefresh);
  const [soaRetry, setSoaRetry] = useState(initial.soaRetry);
  const [soaExpire, setSoaExpire] = useState(initial.soaExpire);
  const [soaMinimum, setSoaMinimum] = useState(initial.soaMinimum);
  const [nameservers, setNameservers] = useState<string[]>(initial.nameservers);
  const [records, setRecords] = useState<TemplateRecord[]>(initial.records);
  const [kind, setKind] = useState(normalizeKind(initial.kind));
  const [soaEdit, setSoaEdit] = useState(initial.soaEdit ?? "");
  const [soaEditApi, setSoaEditApi] = useState(initial.soaEditApi ?? "");
  const [apiRectify, setApiRectify] = useState<boolean>(initial.apiRectify ?? false);
  const [defaultForOn, setDefaultForOn] = useState(initial.defaultForPrimaryIds.length > 0);
  const [defaultForIds, setDefaultForIds] = useState<string[]>(initial.defaultForPrimaryIds);
  const primaries = props.primaries;
  function togglePrimaryId(id: string) {
    setDefaultForIds((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  }

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    setFieldErrors({});

    // Drop blank rows on submit so the operator can leave an empty trailing
    // input without it failing validation.
    const cleanNs = nameservers.map((n) => n.trim()).filter((n) => n !== "");
    const cleanRecords = records
      .map((r) => ({
        name: r.name.trim() || "@",
        type: r.type.toUpperCase(),
        ttl: r.ttl,
        content: r.content.trim(),
        ...(r.disabled ? { disabled: true } : {}),
      }))
      .filter((r) => r.content !== "");

    const defaultForOut = defaultForOn ? defaultForIds : [];
    const body =
      props.mode === "create"
        ? {
            slug,
            name,
            description: description || undefined,
            soaTtl,
            soaRefresh,
            soaRetry,
            soaExpire,
            soaMinimum,
            nameservers: cleanNs,
            records: cleanRecords,
            kind,
            soaEdit: soaEdit || null,
            soaEditApi: soaEditApi || null,
            apiRectify,
            defaultForPrimaryIds: defaultForOut,
          }
        : {
            name,
            description: description || null,
            soaTtl,
            soaRefresh,
            soaRetry,
            soaExpire,
            soaMinimum,
            nameservers: cleanNs,
            records: cleanRecords,
            kind,
            soaEdit: soaEdit || null,
            soaEditApi: soaEditApi || null,
            apiRectify,
            defaultForPrimaryIds: defaultForOut,
          };

    const url =
      props.mode === "edit"
        ? `/api/admin/zone-templates/${props.initial.id}`
        : "/api/admin/zone-templates";
    const method = props.mode === "edit" ? "PATCH" : "POST";

    try {
      const res = await apiFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as ErrorBody | null;
        setError(data?.error ?? "Save failed.");
        if (data?.details?.fieldErrors) setFieldErrors(data.details.fieldErrors);
        return;
      }
      router.push("/admin/zone-templates");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function addNs() {
    setNameservers([...nameservers, ""]);
  }
  function setNs(i: number, value: string) {
    setNameservers(nameservers.map((n, idx) => (idx === i ? value : n)));
  }
  function removeNs(i: number) {
    setNameservers(nameservers.filter((_, idx) => idx !== i));
  }

  function addRecord() {
    setRecords([...records, { name: "@", type: "A", ttl: 3600, content: "" }]);
  }
  function setRecord(i: number, patch: Partial<TemplateRecord>) {
    setRecords(records.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRecord(i: number) {
    setRecords(records.filter((_, idx) => idx !== i));
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6" autoComplete="off">
      <Section title="Identity">
        <Field label="Display name" errors={fieldErrors["name"]}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canEdit}
            required
            placeholder="Default public"
            className={inputClass}
          />
        </Field>
        {props.mode === "create" ? (
          <Field
            label="Slug"
            hint="URL-safe identifier. Cannot be renamed later."
            errors={fieldErrors["slug"]}
          >
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              required
              placeholder="default-public"
              className={inputClass}
            />
          </Field>
        ) : null}
        <Field label="Description (optional)" errors={fieldErrors["description"]}>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={!canEdit}
            rows={2}
            className={`${inputClass} resize-y`}
            placeholder="When operators should pick this template…"
          />
        </Field>
      </Section>

      <Section
        title="Default name servers"
        subtitle="Best practice: at least two (RFC 2182 § 5). These seed the apex NS records on every new zone."
      >
        <div className="space-y-2">
          {nameservers.length === 0 ? (
            <p className="text-xs text-[color:var(--color-fg-muted)]">
              No name servers yet. Operators must supply them at zone-create time if you leave this
              empty.
            </p>
          ) : null}
          {nameservers.map((ns, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={ns}
                onChange={(e) => setNs(i, e.target.value)}
                disabled={!canEdit}
                placeholder="ns1.example.com."
                className={`${inputClass} font-mono`}
              />
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => removeNs(i)}
                  className="text-xs text-[color:var(--color-error)] hover:underline"
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          {canEdit ? (
            <button
              type="button"
              onClick={addNs}
              className="rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-xs hover:bg-[color:var(--color-bg-subtle)]"
            >
              Add name server
            </button>
          ) : null}
        </div>
      </Section>

      <Section
        title="Zone settings"
        subtitle="Defaults applied to the zone object — kind, SOA-EDIT, SOA-EDIT-API, API-RECTIFY. Mirror the per-zone Zone settings tab."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Zone Type">
            <SelectMenu
              value={kind}
              onChange={(v) => setKind(v)}
              disabled={!canEdit}
              ariaLabel="Zone Type"
              options={ZONE_KIND_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              className="w-full"
            />
          </Field>
          <Field label="API-RECTIFY">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={apiRectify}
                onChange={(e) => setApiRectify(e.target.checked)}
                disabled={!canEdit}
              />
              <span className="font-mono text-xs">{apiRectify ? "enabled" : "disabled"}</span>
            </label>
          </Field>
          <Field label="SOA-EDIT" hint="Algorithm for serials sent to secondaries.">
            <SelectMenu
              value={soaEdit}
              onChange={(v) => setSoaEdit(v)}
              disabled={!canEdit}
              ariaLabel="SOA-EDIT"
              options={SOA_EDIT_OPTIONS.map((o) => ({
                value: o,
                label: o || "(server default)",
              }))}
              className="w-full"
            />
          </Field>
          <Field label="SOA-EDIT-API" hint="Algorithm for serial bumps after API edits.">
            <SelectMenu
              value={soaEditApi}
              onChange={(v) => setSoaEditApi(v)}
              disabled={!canEdit}
              ariaLabel="SOA-EDIT-API"
              options={SOA_EDIT_API_OPTIONS.map((o) => ({
                value: o,
                label: o || "(server default)",
              }))}
              className="w-full"
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Auto-select for backends"
        subtitle="When ticked, this template becomes the create-zone default the moment the operator selects one of the chosen PDNS primaries."
      >
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={defaultForOn}
            onChange={(e) => setDefaultForOn(e.target.checked)}
            className="mt-0.5"
          />
          <span>Use this template by default for these PDNS servers</span>
        </label>
        {defaultForOn ? (
          primaries.length === 0 ? (
            <p className="mt-2 rounded border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-2 text-[0.6875rem] text-[color:var(--color-fg-muted)]">
              No active PDNS primaries configured.
            </p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {primaries.map((p) => {
                const checked = defaultForIds.includes(p.id);
                return (
                  <label
                    key={p.id}
                    className={`inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-xs ${
                      checked
                        ? "border-[color:var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_12%,transparent)]"
                        : "border-[color:var(--color-border)] bg-[color:var(--color-bg)]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => togglePrimaryId(p.id)}
                    />
                    {p.name}
                  </label>
                );
              })}
            </div>
          )
        ) : null}
      </Section>

      <Section
        title="SOA timers"
        subtitle="Applied to every zone created from this template. PowerDNS auto-manages the serial; everything else here flows through."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <TimerField label="SOA TTL" value={soaTtl} set={setSoaTtl} disabled={!canEdit} />
          <TimerField label="Refresh" value={soaRefresh} set={setSoaRefresh} disabled={!canEdit} />
          <TimerField label="Retry" value={soaRetry} set={setSoaRetry} disabled={!canEdit} />
          <TimerField label="Expire" value={soaExpire} set={setSoaExpire} disabled={!canEdit} />
          <TimerField label="Minimum" value={soaMinimum} set={setSoaMinimum} disabled={!canEdit} />
        </div>
      </Section>

      <Section
        title="Prelude records"
        subtitle='Records added to every new zone after the SOA + NS. Use relative names: "@" for the zone apex, "www" for www.<zone>, etc.'
      >
        <div className="space-y-3">
          {records.length === 0 ? (
            <p className="text-xs text-[color:var(--color-fg-muted)]">
              No prelude records — the zone will start with just SOA + NS.
            </p>
          ) : null}
          {records.map((r, i) => {
            const validator = getRRTypeValidator(r.type);
            const issues = r.content.trim() === "" ? [] : validator.validate(r.content).issues;
            return (
              <div
                key={i}
                className="space-y-2 rounded-md border border-[color:var(--color-border)] p-3"
              >
                <div className="grid gap-2 sm:grid-cols-[1fr_120px_120px_auto]">
                  <input
                    value={r.name}
                    onChange={(e) => setRecord(i, { name: e.target.value })}
                    disabled={!canEdit}
                    placeholder="@"
                    className={`${inputClass} font-mono`}
                  />
                  <SelectMenu
                    value={r.type}
                    onChange={(v) => setRecord(i, { type: v, content: "" })}
                    disabled={!canEdit}
                    ariaLabel="Record type"
                    options={SUPPORTED_TYPES.map((t) => ({ value: t, label: t }))}
                    className="w-full"
                  />
                  <input
                    type="number"
                    min={0}
                    value={r.ttl}
                    onChange={(e) => setRecord(i, { ttl: Number(e.target.value) || 0 })}
                    disabled={!canEdit}
                    className={`${inputClass} font-mono`}
                  />
                  {canEdit ? (
                    <button
                      type="button"
                      onClick={() => removeRecord(i)}
                      className="text-xs text-[color:var(--color-error)] hover:underline"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                <input
                  value={r.content}
                  onChange={(e) => setRecord(i, { content: e.target.value })}
                  disabled={!canEdit}
                  placeholder={validator.placeholder}
                  className={`${inputClass} font-mono`}
                />
                {issues.length > 0 ? (
                  <ul className="space-y-0.5 text-xs">
                    {issues.map((issue, idx) => (
                      <li
                        key={idx}
                        className={
                          issue.level === "error"
                            ? "text-[color:var(--color-error)]"
                            : "text-[color:var(--color-warn)]"
                        }
                      >
                        <span className="font-medium uppercase">{issue.level}</span> {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
          {canEdit ? (
            <button
              type="button"
              onClick={addRecord}
              className="rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-xs hover:bg-[color:var(--color-bg-subtle)]"
            >
              Add record
            </button>
          ) : null}
        </div>
      </Section>

      {error ? (
        <p className="text-sm text-[color:var(--color-error)]" role="alert">
          {error}
        </p>
      ) : null}

      {canEdit ? (
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
          >
            {saving ? "Saving…" : props.mode === "edit" ? "Save changes" : "Create template"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/admin/zone-templates")}
            className="rounded-md border border-[color:var(--color-border)] px-4 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)]"
          >
            Cancel
          </button>
        </div>
      ) : (
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          Read-only — the template.manage permission is required to edit.
        </p>
      )}
    </form>
  );
}

const inputClass =
  "block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] disabled:opacity-60";

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-5">
      <header>
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">{subtitle}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  errors,
  children,
}: {
  label: string;
  hint?: string;
  errors?: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 first:mt-0">
      <label className="block text-sm font-medium">{label}</label>
      {children}
      {hint ? <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">{hint}</p> : null}
      {errors && errors.length > 0 ? (
        <p className="mt-1 text-xs text-[color:var(--color-error)]" role="alert">
          {errors.join(" ")}
        </p>
      ) : null}
    </div>
  );
}

function TimerField({
  label,
  value,
  set,
  disabled,
}: {
  label: string;
  value: number;
  set: (n: number) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium">{label}</label>
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= 0) set(n);
        }}
        disabled={disabled}
        className={`${inputClass} mt-1 font-mono`}
      />
    </div>
  );
}

/** Map PDNS Primary/Secondary aliases back to the canonical Master/Slave
 *  so the kind dropdown round-trips cleanly with the DB column. */
function normalizeKind(raw: string): string {
  if (raw === "Primary") return "Master";
  if (raw === "Secondary") return "Slave";
  return raw;
}
