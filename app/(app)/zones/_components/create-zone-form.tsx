"use client";

/**
 * app/(app)/zones/_components/create-zone-form.tsx
 *
 * Create-zone form, designed around the operator's mental model:
 *
 *   1. Pick a backend (auto-defaults to the marked-default PDNS server).
 *   2. Type the zone name (with live trailing-dot preview).
 *   3. Pick a kind. The fields below shift based on kind:
 *        Native / Master / Primary  → SOA mailbox + NS list (or template-supplied)
 *        Slave / Secondary          → primary master IP(s); NS comes from primary
 *   4. Optionally pick a template - populates NS + SOA timers + prelude records.
 *      The operator can still override anything below.
 *
 * Best practices the form enforces (with one-line explanations rendered
 * inline so the operator knows why each rule exists):
 *
 *   - At least 2 NS records recommended (RFC 2182 § 5) - warning only.
 *   - NS hostnames fully qualified - auto-add trailing dot on submit.
 *   - Responsible mailbox required + email-shaped.
 *   - Secondary zones must specify at least one master IP.
 *   - Apex name "@" / empty → the zone itself; we show the canonical form.
 */

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/client/api-fetch";
import { SelectMenu } from "@/components/ui/select-menu";

/**
 * Operator-facing backend option. A logical backend is either a
 * standalone PDNS server or a cluster - the cluster is exposed as a
 * single option (not its individual peers); the write_strategy picks
 * which peer the create actually hits server-side. Per the user-facing
 * model: "you create the zone on the cluster, not on peer-2."
 */
export interface BackendOption {
  kind: "server" | "cluster";
  /** server slug OR cluster slug, qualified by `kind`. */
  slug: string;
  /**
   * Writable primary ids (`pdns_servers.id`) this backend creates zones
   * through: a single id for a standalone primary, one per peer for a
   * cluster. The form matches these against a template's
   * `defaultForPrimaryIds` to preselect a default template - so a cluster
   * auto-selects a template registered as the default for any of its
   * member primaries, not just a standalone server.
   */
  primaryIds: string[];
  name: string;
  /** Only meaningful for kind=server. Clusters never carry isDefault. */
  isDefault: boolean;
  /**
   * Active secondaries that mirror this primary. Empty for standalone
   * primaries and for clusters (cluster peers have their own model).
   * Rendered as children under the primary in the BACKEND section so the
   * operator sees the full replication topology before creating a zone.
   */
  secondaries: Array<{ slug: string; name: string }>;
}

interface TemplateOption {
  id: string;
  slug: string;
  name: string;
  nameservers: string[];
  recordCount: number;
  soaRefresh: number;
  soaRetry: number;
  soaExpire: number;
  soaMinimum: number;
  /**
   * Zone-object defaults the create path applies server-side once the
   * zone exists on PDNS. The form mirrors `kind` into its picker on
   * template select; the rest is opaque to the form but surfaced as a
   * small "will also apply" hint so the operator knows what they get.
   */
  kind: string;
  soaEdit: string | null;
  soaEditApi: string | null;
  apiRectify: boolean | null;
  metadataKinds: string[];
  /**
   * PDNS primary IDs this template is the marked default for. When the
   * operator picks one of these primaries on the backend selector, the
   * form pre-applies this template (subject to first-match-wins across
   * templates).
   */
  defaultForPrimaryIds: string[];
}

interface Props {
  backends: BackendOption[];
  templates: TemplateOption[];
  initialSelection?: { kind: "server" | "cluster"; slug: string } | undefined;
  initialTemplateId?: string | undefined;
}

/** Compact discriminator the form holds in state - collapses
 *  (kind, slug) into the one string the <select> emits. */
type BackendKey = `server:${string}` | `cluster:${string}`;

function keyOf(b: { kind: "server" | "cluster"; slug: string }): BackendKey {
  return `${b.kind}:${b.slug}`;
}
function parseKey(k: BackendKey): { kind: "server" | "cluster"; slug: string } {
  const idx = k.indexOf(":");
  return { kind: k.slice(0, idx) as "server" | "cluster", slug: k.slice(idx + 1) };
}

interface ErrorBody {
  error?: string;
  details?: { fieldErrors?: Record<string, string[]> };
}

const KINDS = [
  { value: "Native", label: "Native", hint: "Stored locally; no AXFR/IXFR to Secondaries." },
  {
    value: "Primary",
    label: "Primary",
    hint: "We are the source of truth; Secondaries pull from us. (PDNS legacy: 'Master'.)",
  },
  {
    value: "Secondary",
    label: "Secondary",
    hint: "We replicate from a Primary; provide its IP below. (PDNS legacy: 'Slave'.)",
  },
] as const;

export function CreateZoneForm(props: Props) {
  const router = useRouter();

  const defaultBackendKey = useMemo<BackendKey | "">(() => {
    if (props.initialSelection) {
      const match = props.backends.find(
        (b) => b.kind === props.initialSelection!.kind && b.slug === props.initialSelection!.slug,
      );
      if (match) return keyOf(match);
    }
    // Prefer a marked-default server when one exists; otherwise fall
    // back to the first backend in operator-sort order (clusters first,
    // then standalone primaries by name).
    const def = props.backends.find((b) => b.kind === "server" && b.isDefault);
    if (def) return keyOf(def);
    const first = props.backends[0];
    return first ? keyOf(first) : "";
  }, [props.backends, props.initialSelection]);

  const [backendKey, setBackendKey] = useState<BackendKey | "">(defaultBackendKey);
  const backendSelection = backendKey ? parseKey(backendKey) : null;
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("Native");

  // Compute the template the form should pre-apply for a given backend
  // selection - the first template registered as the default for any
  // primary the backend writes through wins (a standalone primary exposes
  // one such id; a cluster exposes one per peer). First match wins across
  // templates, in their name sort order.
  function defaultTemplateIdFor(selection: { kind: "server" | "cluster"; slug: string } | null) {
    if (!selection) return "";
    const backend = props.backends.find(
      (b) => b.kind === selection.kind && b.slug === selection.slug,
    );
    const backendPrimaryIds = backend?.primaryIds ?? [];
    if (backendPrimaryIds.length === 0) return "";
    const match = props.templates.find((template) =>
      template.defaultForPrimaryIds.some((primaryId) => backendPrimaryIds.includes(primaryId)),
    );
    return match?.id ?? "";
  }

  // Resolve the initial template once (lazy initializer - off the hot render
  // path): an explicit `?template=` deep-link wins; otherwise fall back to the
  // default template registered for the initially-selected backend.
  const [templateId, setTemplateId] = useState<string>(
    () =>
      props.initialTemplateId ??
      (defaultBackendKey ? defaultTemplateIdFor(parseKey(defaultBackendKey)) : ""),
  );

  // Track whether the operator has manually touched the template picker
  // - once they have, we stop auto-applying the per-backend default when
  // they switch backend. (`?template=` from a deep-link also counts as a
  // manual pick - the linker explicitly chose it.)
  const templateTouched = useRef<boolean>(Boolean(props.initialTemplateId));
  const [responsibleEmail, setResponsibleEmail] = useState("");
  const [nameservers, setNameservers] = useState<string[]>([""]);
  const [masters, setMasters] = useState<string[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const isSecondary = kind === "Secondary";

  const selectedTemplate = props.templates.find((t) => t.id === templateId);

  // Apply a template's NS / kind into the form without touching the
  // "operator picked it manually" flag. Used both by the picker handler
  // (which sets the flag itself) and the per-backend auto-default effect.
  function applyTemplateFields(id: string) {
    if (!id) return;
    const t = props.templates.find((tt) => tt.id === id);
    if (!t) return;
    if (t.nameservers.length > 0) setNameservers(t.nameservers);
    // PDNS aliases Primary↔Master, Secondary↔Slave; the form picker uses
    // Primary/Secondary so map the template's stored value before set.
    const formKind = normalizeKindForForm(t.kind);
    if (formKind) setKind(formKind);
  }

  // When the operator picks a template themselves, mirror its defaults
  // into the form and remember that they overrode the auto-default -
  // switching backends after this point no longer auto-swaps the
  // template out from under them.
  function applyTemplate(id: string) {
    templateTouched.current = true;
    setTemplateId(id);
    applyTemplateFields(id);
  }

  // Re-apply the per-backend default template whenever the backend
  // selection changes - except after the operator has touched the
  // picker. The initial mount also runs here so a URL-supplied or
  // auto-defaulted template gets its NS / kind prefill.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      if (templateId) applyTemplateFields(templateId);
      return;
    }
    if (templateTouched.current) return;
    const id = defaultTemplateIdFor(backendSelection);
    setTemplateId(id);
    applyTemplateFields(id);
    // Intentionally keyed only on `backendKey`: this effect re-applies the
    // per-backend default template when the backend changes (with mount + the
    // operator-override guard above). Including the helper closures / other
    // state would re-fire it on unrelated renders and clobber user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backendKey]);

  function addNs() {
    setNameservers([...nameservers, ""]);
  }
  function setNs(i: number, v: string) {
    setNameservers(nameservers.map((n, idx) => (idx === i ? v : n)));
  }
  function removeNs(i: number) {
    setNameservers(nameservers.filter((_, idx) => idx !== i));
  }
  function addMaster() {
    setMasters([...masters, ""]);
  }
  function setMaster(i: number, v: string) {
    setMasters(masters.map((m, idx) => (idx === i ? v : m)));
  }
  function removeMaster(i: number) {
    setMasters(masters.filter((_, idx) => idx !== i));
  }

  const canonicalName = useMemo(() => {
    const lower = name.trim().toLowerCase();
    if (lower === "") return "";
    return lower.endsWith(".") ? lower : `${lower}.`;
  }, [name]);

  const cleanNs = nameservers.map((n) => n.trim()).filter((n) => n !== "");
  const cleanMasters = masters.map((m) => m.trim()).filter((m) => m !== "");

  const nsWarning =
    !isSecondary && cleanNs.length > 0 && cleanNs.length < 2
      ? "Best practice: configure at least two authoritative name servers (RFC 2182 § 5). One is acceptable but offers no redundancy."
      : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    if (canonicalName === "") {
      setError("Zone name is required.");
      setSaving(false);
      return;
    }
    if (isSecondary && cleanMasters.length === 0) {
      setError("Secondary zones need at least one master IP to pull from.");
      setSaving(false);
      return;
    }
    if (!isSecondary && cleanNs.length === 0 && !selectedTemplate) {
      setError(
        "At least one NS record is required. Add one here, or pick a template that defines defaults.",
      );
      setSaving(false);
      return;
    }

    if (!backendSelection) {
      setError("Choose a PowerDNS backend or cluster to create the zone on.");
      setSaving(false);
      return;
    }

    const body: Record<string, unknown> = {
      name: canonicalName,
      kind,
      nameservers: cleanNs.map((n) => (n.endsWith(".") ? n : `${n}.`)),
      masters: isSecondary ? cleanMasters : [],
      ...(backendSelection.kind === "cluster"
        ? { clusterSlug: backendSelection.slug }
        : { serverSlug: backendSelection.slug }),
    };
    if (templateId) body["templateId"] = templateId;
    if (responsibleEmail) body["responsibleEmail"] = responsibleEmail;

    try {
      const res = await apiFetch("/api/admin/pdns/zones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as ErrorBody | null;
        setError(data?.error ?? "Could not create the zone.");
        if (data?.details?.fieldErrors) setFieldErrors(data.details.fieldErrors);
        return;
      }
      router.push("/zones");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (props.backends.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-8 text-center text-sm">
        No PowerDNS backends configured. Ask an administrator to add one before creating zones.
      </div>
    );
  }

  const selectedBackend = backendSelection
    ? (props.backends.find(
        (b) => b.kind === backendSelection.kind && b.slug === backendSelection.slug,
      ) ?? null)
    : null;

  return (
    <form onSubmit={handleSubmit} className="space-y-6" autoComplete="off">
      <Section title="Name + template">
        <Field
          label="Zone name"
          hint="Lowercase. Trailing dot added automatically - e.g. type 'example.com'."
          errors={fieldErrors["name"]}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="example.com"
            required
            className={`${inputClass} font-mono`}
          />
          {canonicalName ? (
            <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
              Stored as <code className="font-mono">{canonicalName}</code>
            </p>
          ) : null}
        </Field>
        {props.templates.length > 0 ? (
          <Field
            label="Template (optional)"
            hint="Templates prefill name servers + SOA timers below - you can still override before submitting."
          >
            <SelectMenu
              value={templateId}
              onChange={(v) => applyTemplate(v)}
              ariaLabel="Template (optional)"
              options={[
                { value: "", label: "- none -" },
                ...props.templates.map((t) => ({ value: t.id, label: t.name })),
              ]}
              className="mt-1 w-full"
            />
            {selectedTemplate ? (
              <div className="mt-1 space-y-1 text-xs text-[color:var(--color-fg-muted)]">
                <p>
                  Seeds {selectedTemplate.nameservers.length} NS record
                  {selectedTemplate.nameservers.length === 1 ? "" : "s"} and{" "}
                  {selectedTemplate.recordCount} prelude record
                  {selectedTemplate.recordCount === 1 ? "" : "s"}.
                </p>
                {templateExtras(selectedTemplate).length > 0 ? (
                  <p>
                    Will also apply server-side:{" "}
                    {templateExtras(selectedTemplate).map((e, i) => (
                      <span key={i}>
                        {i > 0 ? ", " : ""}
                        <code className="font-mono">{e}</code>
                      </span>
                    ))}
                    . Editable later on the zone&apos;s Zone settings / Metadata tabs.
                  </p>
                ) : null}
              </div>
            ) : null}
          </Field>
        ) : (
          <p className="text-xs text-[color:var(--color-fg-muted)]">
            No templates defined yet. Templates prefill NS records, SOA timers, and prelude records
            - set them up under Admin → Zone templates to make this picker appear.
          </p>
        )}
        <Field label="Kind">
          <SelectMenu
            value={kind}
            onChange={(v) => setKind(v)}
            ariaLabel="Kind"
            options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
            className="mt-1 w-full"
          />
          <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
            {KINDS.find((k) => k.value === kind)?.hint}
          </p>
        </Field>
      </Section>

      <Section
        title="Backend"
        subtitle={
          props.backends.length > 1
            ? "Where this zone will live. Clusters appear as a single entry - the cluster's peer-selection strategy picks which peer the create hits."
            : "Where this zone will live. You only have one configured backend, so the destination is fixed."
        }
      >
        {props.backends.length > 1 ? (
          <Field label="PowerDNS server / cluster">
            <SelectMenu
              value={backendKey}
              onChange={(v) => setBackendKey(v)}
              ariaLabel="PowerDNS server / cluster"
              options={props.backends.map((b) => ({
                value: keyOf(b),
                label: `${b.name}${b.isDefault && b.kind === "server" ? " (default)" : ""}${
                  b.kind === "cluster" ? " (cluster)" : ""
                }`,
              }))}
              className="mt-1 w-full"
            />
            {selectedBackend ? <SecondariesList secondaries={selectedBackend.secondaries} /> : null}
          </Field>
        ) : selectedBackend ? (
          <div className="space-y-1">
            <div className="flex items-baseline gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-sm">
              <span className="font-medium">{selectedBackend.name}</span>
              <span className="rounded bg-[color:var(--color-accent)]/15 px-1.5 py-0.5 font-mono text-[0.625rem] tracking-wide text-[color:var(--color-accent)] uppercase">
                {selectedBackend.kind}
              </span>
              <code className="ml-auto font-mono text-xs text-[color:var(--color-fg-muted)]">
                {selectedBackend.slug}
              </code>
            </div>
            <SecondariesList secondaries={selectedBackend.secondaries} />
          </div>
        ) : null}
      </Section>

      {isSecondary ? (
        <Section
          title="Primary masters"
          subtitle="IPv4 or IPv6 addresses of the authoritative primaries to AXFR/IXFR from. At least one required."
        >
          <div className="space-y-2">
            {masters.length === 0 ? (
              <p className="text-xs text-[color:var(--color-fg-muted)]">No primaries yet.</p>
            ) : null}
            {masters.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={m}
                  onChange={(e) => setMaster(i, e.target.value)}
                  placeholder="192.0.2.53"
                  className={`${inputClass} font-mono`}
                />
                <button
                  type="button"
                  onClick={() => removeMaster(i)}
                  className="text-xs text-[color:var(--color-error)] hover:underline"
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addMaster}
              className="rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-xs hover:bg-[color:var(--color-bg-subtle)]"
            >
              Add master IP
            </button>
          </div>
        </Section>
      ) : (
        <>
          <Section
            title="Name servers"
            subtitle={
              selectedTemplate
                ? `Template "${selectedTemplate.name}" seeded these - edit if needed. Trailing dot added on submit.`
                : "Authoritative name servers for the zone. At least one required; two recommended (RFC 2182 § 5)."
            }
          >
            <div className="space-y-2">
              {nameservers.map((ns, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={ns}
                    onChange={(e) => setNs(i, e.target.value)}
                    placeholder="ns1.example.com."
                    className={`${inputClass} font-mono`}
                  />
                  <button
                    type="button"
                    onClick={() => removeNs(i)}
                    className="text-xs text-[color:var(--color-error)] hover:underline"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addNs}
                className="rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-xs hover:bg-[color:var(--color-bg-subtle)]"
              >
                Add name server
              </button>
              {nsWarning ? (
                <p className="text-xs text-[color:var(--color-warn)]">{nsWarning}</p>
              ) : null}
            </div>
          </Section>

          <Section
            title="Responsible mailbox"
            subtitle="Email shown in the SOA record as the zone admin contact. Defaults to hostmaster@<zone>."
          >
            <Field
              label="Email"
              hint="Stored as a dot-encoded hostname per RFC 1035 § 3.3.13 (we handle the encoding)."
              errors={fieldErrors["responsibleEmail"]}
            >
              <input
                type="email"
                value={responsibleEmail}
                onChange={(e) => setResponsibleEmail(e.target.value)}
                placeholder={
                  canonicalName
                    ? `hostmaster@${canonicalName.replace(/\.$/, "")}`
                    : "hostmaster@example.com"
                }
                className={inputClass}
              />
            </Field>
          </Section>
        </>
      )}

      {error ? (
        <p className="text-sm text-[color:var(--color-error)]" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          {saving ? "Adding…" : "Add zone"}
        </button>
        <button
          type="button"
          onClick={() => router.push("/zones")}
          className="rounded-md border border-[color:var(--color-border)] px-4 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)]"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

const inputClass =
  "mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]";

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

/**
 * Render the selected primary's secondaries as a small indented tree
 * under the primary in the BACKEND section. Cosmetic only - secondaries
 * aren't write targets; the zone is created on the primary and the
 * secondaries pick it up on the next AXFR.
 */
function SecondariesList({ secondaries }: { secondaries: Array<{ slug: string; name: string }> }) {
  if (secondaries.length === 0) return null;
  return (
    <ul className="mt-1 ml-4 space-y-0.5 border-l border-[color:var(--color-border)] pl-3">
      {secondaries.map((s) => (
        <li
          key={s.slug}
          className="flex items-baseline gap-2 text-xs text-[color:var(--color-fg-muted)]"
        >
          <span aria-hidden className="text-[color:var(--color-fg-muted)]">
            ↳
          </span>
          <span>{s.name}</span>
          <span className="rounded bg-[color:var(--color-bg-subtle)] px-1.5 py-0.5 font-mono text-[0.625rem] tracking-wide uppercase">
            secondary
          </span>
          <code className="ml-auto font-mono">{s.slug}</code>
        </li>
      ))}
    </ul>
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
    <div>
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

/**
 * Map a template's stored kind (Native / Master / Slave / Primary /
 * Secondary / Producer / Consumer) to one of the three options the
 * create-zone form's Kind picker supports. Returns null for kinds that
 * don't have a matching form option (e.g. Producer / Consumer - the
 * operator can still pick something else and the template's other
 * fields still apply on the server side).
 */
/**
 * Build the "will also apply" hint for the template picker - lists the
 * zone-object fields the apply path will set after the zone is created.
 * Shown under the template selector so the operator knows what they get
 * without having to inspect the template themselves.
 */
function templateExtras(t: TemplateOption): string[] {
  const out: string[] = [];
  if (t.soaEdit) out.push(`SOA-EDIT=${t.soaEdit}`);
  if (t.soaEditApi) out.push(`SOA-EDIT-API=${t.soaEditApi}`);
  if (t.apiRectify !== null) out.push(`API-RECTIFY=${t.apiRectify ? "enabled" : "disabled"}`);
  if (t.metadataKinds.length > 0) {
    out.push(`${t.metadataKinds.length} metadata kind${t.metadataKinds.length === 1 ? "" : "s"}`);
  }
  return out;
}

function normalizeKindForForm(raw: string): "Native" | "Primary" | "Secondary" | null {
  if (raw === "Native") return "Native";
  if (raw === "Master" || raw === "Primary") return "Primary";
  if (raw === "Slave" || raw === "Secondary") return "Secondary";
  return null;
}
