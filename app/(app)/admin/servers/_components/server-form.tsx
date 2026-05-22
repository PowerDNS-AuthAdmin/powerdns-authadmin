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

interface ServerFormInitial {
  id: string;
  slug: string;
  name: string;
  description: string;
  baseUrl: string;
  serverId: string;
  isDefault: boolean;
  disabled: boolean;
  role: "primary" | "secondary";
  primaryId: string | null;
}

interface PrimaryOption {
  id: string;
  name: string;
  slug: string;
}

interface CreateProps {
  mode: "create";
  initial?: undefined;
  /** Existing primaries — populates the "Mirrors which primary?" picker
   *  when the operator chooses role=secondary. */
  primaries: PrimaryOption[];
  /** If set, the form pre-selects role=secondary + primaryId. Used by
   *  the "Add secondary" affordance on the primary's edit page. */
  forSecondaryOf?: string;
}

interface EditProps {
  mode: "edit";
  initial: ServerFormInitial;
  primaries: PrimaryOption[];
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
  role: "primary",
  primaryId: null,
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
  const [role, setRole] = useState<"primary" | "secondary">(
    props.mode === "edit" ? initial.role : props.forSecondaryOf ? "secondary" : initial.role,
  );
  const [primaryId, setPrimaryId] = useState<string | null>(
    props.mode === "edit" ? initial.primaryId : (props.forSecondaryOf ?? null),
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setFieldErrors({});

    const body: {
      slug: string;
      name: string;
      description?: string | null;
      baseUrl: string;
      serverId: string;
      isDefault: boolean;
      apiKey?: string;
      disabled?: boolean;
      role: "primary" | "secondary";
      primaryId: string | null;
    } = {
      slug,
      name,
      baseUrl,
      serverId,
      isDefault: role === "primary" ? isDefault : false,
      role,
      primaryId: role === "secondary" ? primaryId : null,
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
        hint="Free-text note for operators — 'dev box in eu-west', 'prod cluster, do not edit'. Shown on the servers list. Up to 500 characters."
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
        hint="Just the host + port — '/api/v1' is appended automatically. Provide a custom path only if your reverse proxy mounts PDNS under a prefix."
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

      <Field id="role" label="Role" errors={fieldErrors["role"]}>
        <select
          id="role"
          value={role}
          onChange={(e) => {
            const next = e.target.value as "primary" | "secondary";
            setRole(next);
            if (next === "primary") {
              setPrimaryId(null);
            }
          }}
          className={inputClass}
          // Prevent editing role on the only primary in the system to
          // avoid orphaning secondaries — the server route will also
          // reject; this is a UX nudge.
          disabled={
            props.mode === "edit" &&
            initial.role === "primary" &&
            props.primaries.filter((p) => p.id !== initial.id).length === 0
          }
        >
          <option value="primary">Primary (writable, source of truth)</option>
          <option value="secondary">Secondary (read-only mirror)</option>
        </select>
      </Field>

      {role === "secondary" ? (
        <Field id="primaryId" label="Mirrors which primary?" errors={fieldErrors["primaryId"]}>
          <select
            id="primaryId"
            value={primaryId ?? ""}
            onChange={(e) => setPrimaryId(e.target.value || null)}
            required
            className={inputClass}
          >
            <option value="" disabled>
              Select a primary…
            </option>
            {props.primaries
              .filter((p) => (props.mode === "edit" ? p.id !== initial.id : true))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.slug})
                </option>
              ))}
          </select>
        </Field>
      ) : (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          Use as the default backend
        </label>
      )}

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
