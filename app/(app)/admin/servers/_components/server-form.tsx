"use client";

/**
 * app/(app)/admin/servers/_components/server-form.tsx
 *
 * Shared create / edit form for a PowerDNS backend. POSTs to the admin API
 * routes and surfaces per-field validation errors returned by the server.
 *
 * The API key field is required in create mode and optional in edit mode
 * (leaving it blank preserves the existing key).
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/client/api-fetch";
import { hostFromUrl } from "@/lib/net/host";
import { SelectMenu } from "@/components/ui/select-menu";

interface ServerFormInitial {
  id: string;
  slug: string;
  name: string;
  description: string;
  baseUrl: string;
  serverId: string;
  isDefault: boolean;
  disabled: boolean;
  clusterId: string | null;
  advertisedAddresses: string[] | null;
}

interface GroupOption {
  id: string;
  name: string;
  slug: string;
}

interface CreateProps {
  mode: "create";
  initial?: undefined;
  /** Existing groups (multi-primary clusters / primary+secondary groups) -
   *  populates the optional "Group" picker. */
  groups: GroupOption[];
  /** If set, pre-selects this group. Used by the "Add secondary"
   *  affordance on a primary's edit page. */
  forGroup?: string;
}

interface EditProps {
  mode: "edit";
  initial: ServerFormInitial;
  groups: GroupOption[];
}

type ServerFormProps = CreateProps | EditProps;

interface ServerErrorBody {
  error?: string;
  details?: { fieldErrors?: Record<string, string[]> };
}

const DEFAULTS: ServerFormInitial = {
  id: "",
  slug: "",
  name: "",
  description: "",
  baseUrl: "",
  serverId: "localhost",
  isDefault: false,
  disabled: false,
  clusterId: null,
  advertisedAddresses: null,
};

export function ServerForm(props: ServerFormProps) {
  const router = useRouter();
  const initial = props.mode === "edit" ? props.initial : DEFAULTS;

  const [slug, setSlug] = useState(initial.slug);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [serverId, setServerId] = useState(initial.serverId);
  const [apiKey, setApiKey] = useState("");
  const [isDefault, setIsDefault] = useState(initial.isDefault);
  const [disabled, setDisabled] = useState(props.mode === "edit" ? initial.disabled : false);
  const [clusterId, setClusterId] = useState<string | null>(
    props.mode === "edit" ? initial.clusterId : (props.forGroup ?? null),
  );
  // Explicit AXFR/DNS address overrides. Empty = derive from the API host (sent
  // as null); a non-empty list overrides. No auto-sync magic - when the list is
  // empty we just SHOW the derived default below the field.
  const [addresses, setAddresses] = useState<string[]>(initial.advertisedAddresses ?? []);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    // Drop blank rows, then block on any malformed host/IP[:port] before submit.
    const cleaned = addresses.map((a) => a.trim()).filter(Boolean);
    const invalid = cleaned.filter((a) => !isValidAddress(a));
    if (invalid.length > 0) {
      setFieldErrors({
        advertisedAddresses: [`Not a valid host or IP: ${invalid.join(", ")}`],
      });
      return;
    }

    setLoading(true);

    const body: {
      slug: string;
      name: string;
      description?: string | null;
      baseUrl: string;
      serverId: string;
      isDefault: boolean;
      apiKey?: string;
      disabled?: boolean;
      clusterId: string | null;
      advertisedAddresses: string[] | null;
    } = {
      slug,
      name,
      baseUrl,
      serverId,
      isDefault,
      clusterId,
      // Empty → null (the server derives from the API host). Non-empty → the
      // explicit override list.
      advertisedAddresses: cleaned.length > 0 ? cleaned : null,
    };
    if (apiKey !== "") body.apiKey = apiKey;
    if (props.mode === "edit") body.disabled = disabled;
    // Always send description on edit so the server knows whether
    // to clear (empty → null) or preserve (omit). On create, only
    // include when non-empty so it gets the schema default
    // (null/undefined → no description).
    if (props.mode === "edit") {
      body.description = description.trim() === "" ? null : description;
    } else if (description.trim() !== "") {
      body.description = description;
    }

    const url =
      props.mode === "edit"
        ? `/api/admin/pdns-servers/${props.initial.id}`
        : "/api/admin/pdns-servers";
    const method = props.mode === "edit" ? "PATCH" : "POST";

    try {
      const res = await apiFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as ServerErrorBody | null;
        setError(data?.error ?? "Save failed.");
        if (data?.details?.fieldErrors) {
          setFieldErrors(data.details.fieldErrors);
        }
        return;
      }

      router.push("/admin/servers");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <Field label="Display name" id="name" errors={fieldErrors["name"]}>
        <input
          id="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Primary PowerDNS"
          className={inputClass}
        />
      </Field>

      <Field
        label="Slug"
        id="slug"
        errors={fieldErrors["slug"]}
        hint="Used in URLs and log lines. Lowercase letters, digits, and dashes."
      >
        <input
          id="slug"
          required
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          placeholder="primary"
          className={inputClass}
        />
      </Field>

      <Field
        label="Description (optional)"
        id="description"
        errors={fieldErrors["description"]}
        hint="Free-text note for operators - 'dev box in eu-west', 'prod cluster, do not edit'. Shown on the servers list. Up to 500 characters."
      >
        <textarea
          id="description"
          rows={2}
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="dev box in eu-west"
          className={`${inputClass} resize-y`}
        />
      </Field>

      <Field
        label="Base URL"
        id="baseUrl"
        errors={fieldErrors["baseUrl"]}
        hint="Just the host + port - '/api/v1' is appended automatically. Provide a custom path only if your reverse proxy mounts PDNS under a prefix."
      >
        <input
          id="baseUrl"
          required
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://pdns-api:8081"
          className={inputClass}
        />
      </Field>

      <Field
        label="Server id"
        id="serverId"
        errors={fieldErrors["serverId"]}
        hint='PDNS server-id (the path after /servers/). Usually "localhost".'
      >
        <input
          id="serverId"
          required
          value={serverId}
          onChange={(e) => setServerId(e.target.value)}
          className={inputClass}
        />
      </Field>

      <Field
        label={props.mode === "edit" ? "Rotate API key" : "API key"}
        id="apiKey"
        errors={fieldErrors["apiKey"]}
        hint={
          props.mode === "edit"
            ? "Leave blank to keep the existing key. Submitting a new value rotates it and clears the version cache."
            : "X-API-Key configured on the PowerDNS server. Encrypted at rest."
        }
      >
        <input
          id="apiKey"
          type="password"
          autoComplete="off"
          required={props.mode === "create"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={props.mode === "edit" ? "•••••••• (unchanged)" : ""}
          className={inputClass}
        />
      </Field>

      <Field
        id="clusterId"
        label="Group (optional)"
        errors={fieldErrors["clusterId"]}
        hint="Group related backends - the writable peers of a multi-primary cluster, or a primary together with its secondaries. Grouped backends are polled together and their sync state is compared. Leave as “None” for a standalone backend. Create groups under Admin → Groups."
      >
        <SelectMenu
          value={clusterId ?? ""}
          onChange={(v) => setClusterId(v || null)}
          ariaLabel="Group (optional)"
          className="mt-1 w-full"
          options={[
            { value: "", label: "None - standalone backend" },
            ...props.groups.map((g) => ({
              value: g.id,
              label: `${g.name} (${g.slug})`,
            })),
          ]}
        />
      </Field>

      <Field
        id="advertisedAddresses"
        label="AXFR / DNS address(es) (optional)"
        errors={fieldErrors["advertisedAddresses"]}
        hint="How peers reach this server for AXFR - what a secondary lists in its zone's masters[]. On a primary, used to match a secondary's masters[] back to this server (sync, drift, metrics). Defaults to the API host; override only when the DNS address differs."
      >
        <AddressList
          value={addresses}
          onChange={setAddresses}
          derivedDefault={hostFromUrl(baseUrl) ?? ""}
        />
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
        Use as the default backend (only a write-capable backend can be the default)
      </label>

      {props.mode === "edit" ? (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={disabled}
            onChange={(e) => setDisabled(e.target.checked)}
          />
          Disable this backend (kept for audit history; excluded from list views)
        </label>
      ) : null}

      {error ? (
        <p className="text-sm text-[color:var(--color-error)]" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          {loading ? "Saving…" : props.mode === "edit" ? "Save changes" : "Add server"}
        </button>
        <button
          type="button"
          onClick={() => router.push("/admin/servers")}
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

function Field({
  id,
  label,
  hint,
  errors,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  errors?: string[];
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
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
 * Add/remove editor for the AXFR/DNS address overrides. An empty list means
 * "derive from the API host" - surfaced as the muted default note rather than a
 * blank textarea. Each row is validated as a host or IP (optional `:port`).
 */
function AddressList({
  value,
  onChange,
  derivedDefault,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  derivedDefault: string;
}) {
  const update = (i: number, next: string) =>
    onChange(value.map((v, idx) => (idx === i ? next : v)));
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  // Seed the first row with the derived API host so overriding starts from the
  // current value instead of a blank box; later rows start empty.
  const add = () => onChange([...value, value.length === 0 ? derivedDefault : ""]);

  return (
    <div className="mt-1 space-y-2">
      {value.map((addr, i) => {
        const trimmed = addr.trim();
        const invalid = trimmed !== "" && !isValidAddress(trimmed);
        return (
          <div key={i}>
            <div className="flex items-center gap-2">
              <input
                value={addr}
                onChange={(e) => update(i, e.target.value)}
                placeholder="192.0.2.10  ·  ns1.example.com  ·  [2001:db8::1]:53"
                aria-invalid={invalid}
                className={`block w-full rounded-md border bg-[color:var(--color-bg)] px-3 py-2 font-mono text-sm focus:ring-2 focus:ring-[color:var(--color-accent)] focus:outline-none ${
                  invalid
                    ? "border-[color:var(--color-error)]"
                    : "border-[color:var(--color-border)]"
                }`}
              />
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={`Remove ${addr || "address"}`}
                className="shrink-0 rounded-md border border-[color:var(--color-border)] px-2.5 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)]"
              >
                ✕
              </button>
            </div>
            {invalid ? (
              <p className="mt-1 text-xs text-[color:var(--color-error)]">
                Not a valid host or IP.
              </p>
            ) : null}
          </div>
        );
      })}

      <button
        type="button"
        onClick={add}
        className="rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-bg-subtle)]"
      >
        + Add address
      </button>

      {value.length === 0 ? (
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          Defaults to the API host
          {derivedDefault ? (
            <>
              {" "}
              (<code className="font-mono">{derivedDefault}</code>)
            </>
          ) : null}
          .
        </p>
      ) : null}
    </div>
  );
}

/** A host or IP with an optional `:port` - the shape a `masters[]` entry takes. */
function isValidAddress(raw: string): boolean {
  const s = raw.trim();
  if (s.length === 0 || s.length > 255) return false;

  // Bracketed IPv6, optional :port - e.g. [2001:db8::1]:53
  const bracket = /^\[([0-9a-fA-F:]+)\](?::\d{1,5})?$/.exec(s);
  if (bracket) return isIpv6(bracket[1]!);

  // Bare IPv6: 2+ colons, no brackets, no port.
  if ((s.match(/:/g) ?? []).length >= 2) return isIpv6(s);

  // host or IPv4, with an optional :port.
  const colon = s.indexOf(":");
  const host = colon >= 0 ? s.slice(0, colon) : s;
  if (colon >= 0 && !/^\d{1,5}$/.test(s.slice(colon + 1))) return false;
  return isIpv4(host) || isHostname(host);
}

function isIpv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  return m?.slice(1).every((o) => Number(o) <= 255) ?? false;
}

function isIpv6(s: string): boolean {
  // Lenient - enough to catch typos without re-implementing RFC 4291.
  return /^[0-9a-fA-F:]+$/.test(s) && (s.includes("::") || s.split(":").length === 8);
}

function isHostname(s: string): boolean {
  const host = s.endsWith(".") ? s.slice(0, -1) : s; // tolerate a trailing dot
  if (host.length === 0 || host.length > 253) return false;
  return host
    .split(".")
    .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}
