"use client";

/**
 * app/(app)/admin/oidc-providers/_components/oidc-provider-form.tsx
 *
 * Shared create / edit form for an OIDC provider. Client-secret is required
 * in create mode and optional in edit mode (blank keeps the existing
 * encrypted value).
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/client/api-fetch";
import { SelectMenu } from "@/components/ui/select-menu";

interface FormInitial {
  id: string;
  slug: string;
  name: string;
  issuerUrl: string;
  clientId: string;
  scopes: string;
  claimEmail: string;
  claimName: string;
  enabled: boolean;
  /** Per-provider opt-out of the email_verified claim check. Default
   *  true — secure-by-default. */
  requireEmailVerified: boolean;
  /**
   * Null = inherit env. Array (possibly empty) = override env.
   * See S-7 follow-up in lib/auth/email-domain-allowlist.ts for the
   * three-state semantics.
   */
  allowedEmailDomains: string[] | null;
  /** Optional login-button icon. URL or data: URI. */
  iconUrl: string | null;
  /** Per-provider group → role rules. Empty array or null = no mappings. */
  groupMappings: GroupMappingForm[];
}

export interface GroupMappingForm {
  group: string;
  roleSlug: string;
  scopeType: "global" | "team" | "zone" | "server";
  scopeId: string | null;
}

interface CreateProps {
  mode: "create";
  initial?: undefined;
  canEdit?: undefined;
  pickers: PickerData;
}

interface EditProps {
  mode: "edit";
  initial: FormInitial;
  canEdit: boolean;
  pickers: PickerData;
}

type Props = CreateProps | EditProps;

/**
 * Pre-fetched lists the group-mapping editor needs for its
 * dropdowns. Loaded once by the server component that renders the
 * form so operators get autocomplete-quality pickers without a
 * runtime fetch round-trip.
 */
export interface PickerData {
  roles: Array<{ slug: string; name: string }>;
  teams: Array<{ slug: string; name: string }>;
  servers: Array<{ slug: string; name: string }>;
}

interface ErrorBody {
  error?: string;
  details?: { fieldErrors?: Record<string, string[]> };
}

const DEFAULTS: FormInitial = {
  id: "",
  slug: "",
  name: "",
  issuerUrl: "",
  clientId: "",
  scopes: "openid profile email",
  claimEmail: "email",
  claimName: "name",
  enabled: true,
  // Trust the IdP by default — see the schema comment. Operators
  // can flip on per-provider via the form checkbox.
  requireEmailVerified: false,
  allowedEmailDomains: null,
  iconUrl: null,
  groupMappings: [],
};

export function OidcProviderForm(props: Props) {
  const router = useRouter();
  const initial = props.mode === "edit" ? props.initial : DEFAULTS;
  const canEdit = props.mode === "create" ? true : props.canEdit;

  const [slug, setSlug] = useState(initial.slug);
  const [name, setName] = useState(initial.name);
  const [issuerUrl, setIssuerUrl] = useState(initial.issuerUrl);
  const [clientId, setClientId] = useState(initial.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState(initial.scopes);
  const [claimEmail, setClaimEmail] = useState(initial.claimEmail);
  const [claimName, setClaimName] = useState(initial.claimName);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [requireEmailVerified, setRequireEmailVerified] = useState(initial.requireEmailVerified);
  const [overrideDomains, setOverrideDomains] = useState(initial.allowedEmailDomains !== null);
  const [domainsText, setDomainsText] = useState(
    initial.allowedEmailDomains ? initial.allowedEmailDomains.join("\n") : "",
  );
  const [iconUrl, setIconUrl] = useState(initial.iconUrl ?? "");
  const [groupMappings, setGroupMappings] = useState<GroupMappingForm[]>(initial.groupMappings);

  function addGroupMapping() {
    setGroupMappings([
      ...groupMappings,
      {
        group: "",
        roleSlug: props.pickers.roles[0]?.slug ?? "",
        scopeType: "global",
        scopeId: null,
      },
    ]);
  }
  function updateGroupMapping(i: number, patch: Partial<GroupMappingForm>) {
    setGroupMappings((prev) =>
      prev.map((m, idx) => {
        if (idx !== i) return m;
        const next = { ...m, ...patch };
        // Switching to "global" clears scopeId; switching away
        // initializes scopeId so the second select has a valid value.
        if (patch.scopeType === "global") next.scopeId = null;
        else if (patch.scopeType && m.scopeType === "global") {
          next.scopeId =
            patch.scopeType === "team"
              ? (props.pickers.teams[0]?.slug ?? "")
              : patch.scopeType === "server"
                ? (props.pickers.servers[0]?.slug ?? "")
                : "";
        }
        return next;
      }),
    );
  }
  function removeGroupMapping(i: number) {
    setGroupMappings((prev) => prev.filter((_, idx) => idx !== i));
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

    interface Body {
      slug?: string;
      name: string;
      issuerUrl: string;
      clientId: string;
      clientSecret?: string;
      scopes: string;
      claimEmail: string;
      claimName: string;
      enabled: boolean;
      requireEmailVerified: boolean;
      // `null` = clear override (inherit env). Array (possibly empty) =
      // set override. Field omitted (undefined) = leave unchanged.
      // Always sent here because the override toggle is always shown.
      allowedEmailDomains: string[] | null;
      iconUrl?: string | null;
      groupMappings: GroupMappingForm[];
    }
    // Parse the textarea: one domain per line, trim, drop empties,
    // lower-case (the server re-validates with regex).
    const parsedDomains: string[] = domainsText
      .split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);

    const body: Body = {
      name,
      issuerUrl,
      clientId,
      scopes,
      claimEmail,
      claimName,
      enabled,
      requireEmailVerified,
      allowedEmailDomains: overrideDomains ? parsedDomains : null,
      // Empty string → null clears the icon back to text-only
      // button. Trimmed value otherwise. Server re-validates.
      iconUrl: iconUrl.trim() === "" ? null : iconUrl.trim(),
      // Strip rows where required fields are blank — the user added
      // a row then walked away. The server's Zod refine would reject
      // these anyway, but the better UX is to silently drop them
      // (they're empty placeholders, not malformed data).
      groupMappings: groupMappings
        .map((m) => ({
          ...m,
          group: m.group.trim(),
          roleSlug: m.roleSlug.trim(),
          scopeId: m.scopeId !== null && m.scopeId.trim() !== "" ? m.scopeId.trim() : null,
        }))
        .filter((m) => m.group.length > 0 && m.roleSlug.length > 0)
        .filter((m) => m.scopeType === "global" || (m.scopeId !== null && m.scopeId.length > 0)),
    };
    if (props.mode === "create") body.slug = slug;
    if (clientSecret !== "") body.clientSecret = clientSecret;

    const url =
      props.mode === "edit"
        ? `/api/admin/oidc-providers/${props.initial.id}`
        : "/api/admin/oidc-providers";
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
      router.push("/admin/oidc-providers");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <Field
        id="name"
        label="Display name"
        hint="Shown on the login button — e.g. 'Continue with Google'."
        errors={fieldErrors["name"]}
      >
        <input
          id="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canEdit}
          placeholder="Google"
          className={inputClass}
        />
      </Field>

      {props.mode === "create" ? (
        <Field
          id="slug"
          label="Slug"
          hint="URL-safe identifier used in the callback path. Lowercase letters, digits, and dashes. Cannot be changed later."
          errors={fieldErrors["slug"]}
        >
          <input
            id="slug"
            required
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="google"
            className={inputClass}
          />
        </Field>
      ) : null}

      <Field
        id="issuerUrl"
        label="Issuer URL"
        hint="OIDC discovery base — the app fetches /.well-known/openid-configuration below this."
        errors={fieldErrors["issuerUrl"]}
      >
        <input
          id="issuerUrl"
          type="url"
          required
          value={issuerUrl}
          onChange={(e) => setIssuerUrl(e.target.value)}
          disabled={!canEdit}
          placeholder="https://accounts.google.com"
          className={inputClass}
        />
      </Field>

      <Field id="clientId" label="Client ID" errors={fieldErrors["clientId"]}>
        <input
          id="clientId"
          required
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          disabled={!canEdit}
          className={inputClass}
        />
      </Field>

      <Field
        id="clientSecret"
        label={props.mode === "edit" ? "Rotate client secret" : "Client secret"}
        hint={
          props.mode === "edit"
            ? "Leave blank to keep the existing secret. Submitting a new value rotates it."
            : "Stored AES-256-GCM-encrypted at rest. Shown only at creation time."
        }
        errors={fieldErrors["clientSecret"]}
      >
        <input
          id="clientSecret"
          type="password"
          autoComplete="off"
          required={props.mode === "create"}
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          disabled={!canEdit}
          placeholder={props.mode === "edit" ? "•••••••• (unchanged)" : ""}
          className={inputClass}
        />
      </Field>

      <Field
        id="scopes"
        label="Scopes"
        hint='Space-separated. "openid" is required.'
        errors={fieldErrors["scopes"]}
      >
        <input
          id="scopes"
          required
          value={scopes}
          onChange={(e) => setScopes(e.target.value)}
          disabled={!canEdit}
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field
          id="claimEmail"
          label="Email claim"
          hint='Default: "email".'
          errors={fieldErrors["claimEmail"]}
        >
          <input
            id="claimEmail"
            required
            value={claimEmail}
            onChange={(e) => setClaimEmail(e.target.value)}
            disabled={!canEdit}
            className={inputClass}
          />
        </Field>
        <Field
          id="claimName"
          label="Display name claim"
          hint='Default: "name".'
          errors={fieldErrors["claimName"]}
        >
          <input
            id="claimName"
            required
            value={claimName}
            onChange={(e) => setClaimName(e.target.value)}
            disabled={!canEdit}
            className={inputClass}
          />
        </Field>
      </div>

      <Field
        id="iconUrl"
        label="Login-button icon (optional)"
        hint="Absolute URL (https://example.com/google.svg) or a small inline data: URI. Renders next to the 'Continue with…' label on the login page. Leave blank for text-only."
        errors={fieldErrors["iconUrl"]}
      >
        <input
          id="iconUrl"
          value={iconUrl}
          onChange={(e) => setIconUrl(e.target.value)}
          disabled={!canEdit}
          placeholder="https://cdn.example.com/google-logo.svg"
          className={inputClass}
        />
        {iconUrl.trim() !== "" ? (
          <div className="mt-2 flex items-center gap-2 rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-2 text-xs text-[color:var(--color-fg-muted)]">
            <span>Preview:</span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={iconUrl}
              alt="Provider icon preview"
              style={{
                width: 20,
                height: 20,
                objectFit: "contain",
                display: "block",
              }}
            />
          </div>
        ) : null}
      </Field>

      <div className="space-y-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-4">
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={overrideDomains}
            onChange={(e) => setOverrideDomains(e.target.checked)}
            disabled={!canEdit}
            className="mt-0.5"
          />
          <span>
            Override <code>OIDC_ALLOWED_EMAIL_DOMAINS</code> for this provider
            <span className="block text-xs text-[color:var(--color-fg-muted)]">
              Off: inherit the env allow-list. On: use the list below instead (REPLACES env — leave
              empty to allow any email).
            </span>
          </span>
        </label>
        {overrideDomains ? (
          <Field
            id="allowedEmailDomains"
            label="Allowed email domains"
            hint="One bare domain per line (e.g. example.com). Lowercase. Empty = no restriction at this provider."
            errors={fieldErrors["allowedEmailDomains"]}
          >
            <textarea
              id="allowedEmailDomains"
              rows={4}
              value={domainsText}
              onChange={(e) => setDomainsText(e.target.value)}
              disabled={!canEdit}
              placeholder="example.com&#10;acme.corp"
              className={`${inputClass} font-mono`}
            />
          </Field>
        ) : null}
      </div>

      <fieldset className="space-y-3 rounded-md border border-[color:var(--color-border)] p-3">
        <legend className="px-1 text-sm font-medium">Group → role mappings</legend>
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          On every successful sign-in, the user&apos;s{" "}
          <code>{initial.scopes && claimEmail ? "claim_groups" : "groups"}</code> claim is matched
          against the rules below. Each matching row materialises a role assignment tagged with this
          provider — the NEXT sign-in revokes it if the user is no longer in the group. Admin-issued
          assignments are never touched.
        </p>
        {groupMappings.length === 0 ? (
          <p className="text-xs text-[color:var(--color-fg-muted)] italic">
            No mappings yet. Add one to grant roles based on the IdP&apos;s group claim.
          </p>
        ) : (
          <ul className="space-y-2">
            {groupMappings.map((m, i) => (
              <li
                key={i}
                className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-2"
              >
                <label className="text-xs">
                  IdP group
                  <input
                    value={m.group}
                    onChange={(e) => updateGroupMapping(i, { group: e.target.value })}
                    disabled={!canEdit}
                    placeholder="authentik Admins"
                    className={`${inputClass} font-mono text-xs`}
                  />
                </label>
                <label className="text-xs">
                  Role
                  <SelectMenu
                    value={m.roleSlug}
                    onChange={(v) => updateGroupMapping(i, { roleSlug: v })}
                    disabled={!canEdit}
                    ariaLabel="Role"
                    options={props.pickers.roles.map((r) => ({
                      value: r.slug,
                      label: `${r.name} (${r.slug})`,
                    }))}
                    className="mt-1 w-full text-xs"
                  />
                </label>
                <label className="text-xs">
                  Scope
                  <SelectMenu
                    value={m.scopeType}
                    onChange={(v) =>
                      updateGroupMapping(i, {
                        scopeType: v,
                      })
                    }
                    disabled={!canEdit}
                    ariaLabel="Scope"
                    options={[
                      { value: "global", label: "global" },
                      { value: "team", label: "team" },
                      { value: "server", label: "server" },
                      { value: "zone", label: "zone" },
                    ]}
                    className="mt-1 w-full text-xs"
                  />
                </label>
                <label className="text-xs">
                  Target
                  {m.scopeType === "global" ? (
                    <input value="" disabled placeholder="—" className={`${inputClass} text-xs`} />
                  ) : m.scopeType === "team" ? (
                    <SelectMenu
                      value={m.scopeId ?? ""}
                      onChange={(v) => updateGroupMapping(i, { scopeId: v })}
                      disabled={!canEdit}
                      ariaLabel="Target team"
                      options={
                        props.pickers.teams.length === 0
                          ? [{ value: "", label: "(no teams defined)" }]
                          : props.pickers.teams.map((t) => ({
                              value: t.slug,
                              label: `${t.name} (${t.slug})`,
                            }))
                      }
                      className="mt-1 w-full text-xs"
                    />
                  ) : m.scopeType === "server" ? (
                    <SelectMenu
                      value={m.scopeId ?? ""}
                      onChange={(v) => updateGroupMapping(i, { scopeId: v })}
                      disabled={!canEdit}
                      ariaLabel="Target server"
                      options={
                        props.pickers.servers.length === 0
                          ? [{ value: "", label: "(no servers defined)" }]
                          : props.pickers.servers.map((s) => ({
                              value: s.slug,
                              label: `${s.name} (${s.slug})`,
                            }))
                      }
                      className="mt-1 w-full text-xs"
                    />
                  ) : (
                    <input
                      value={m.scopeId ?? ""}
                      onChange={(e) => updateGroupMapping(i, { scopeId: e.target.value })}
                      disabled={!canEdit}
                      placeholder="example.com."
                      className={`${inputClass} font-mono text-xs`}
                    />
                  )}
                </label>
                <button
                  type="button"
                  onClick={() => removeGroupMapping(i)}
                  disabled={!canEdit}
                  title="Remove this mapping"
                  className="self-end rounded border border-[color:var(--color-border)] px-2 py-1 text-xs text-[color:var(--color-error)] hover:bg-[color:var(--color-bg-muted)] disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <button
            type="button"
            onClick={addGroupMapping}
            className="rounded border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-bg-muted)]"
          >
            + Add mapping
          </button>
        ) : null}
        {fieldErrors["groupMappings"] ? (
          <p className="text-xs text-[color:var(--color-error)]" role="alert">
            {fieldErrors["groupMappings"].join(" ")}
          </p>
        ) : null}
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          disabled={!canEdit}
        />
        Enabled (shown on the login page)
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={requireEmailVerified}
          onChange={(e) => setRequireEmailVerified(e.target.checked)}
          disabled={!canEdit}
          className="mt-0.5"
        />
        <span>
          Require <code>email_verified</code> claim from the IdP
          <span className="block text-xs text-[color:var(--color-fg-muted)]">
            On by default. Blocks sign-in for an existing local account unless the IdP attests the
            email is verified — the account-takeover guard for IdPs that let users set arbitrary
            unverified emails. Turn off only for IdPs that don&apos;t emit the claim at all (some
            custom OIDC bridges, SAML→OIDC translators).
          </span>
        </span>
      </label>

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
            {saving ? "Saving…" : props.mode === "edit" ? "Save changes" : "Add provider"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/admin/oidc-providers")}
            className="rounded-md border border-[color:var(--color-border)] px-4 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)]"
          >
            Cancel
          </button>
        </div>
      ) : (
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          Read-only access. The oidc.manage permission is required to edit.
        </p>
      )}
    </form>
  );
}

const inputClass =
  "mt-1 block w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] disabled:opacity-60";

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
