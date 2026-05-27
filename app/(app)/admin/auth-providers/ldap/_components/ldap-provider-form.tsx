"use client";

/**
 * app/(app)/admin/auth-providers/ldap/_components/ldap-provider-form.tsx
 *
 * Shared create / edit form for an LDAP provider. The structure mirrors
 * `oidc-provider-form.tsx` — same field component, same group-mapping
 * editor (LDAP groups go through the same `applyGroupSync` differ).
 *
 * Bind password is required in create mode, optional in edit mode
 * (blank keeps the existing encrypted envelope; non-blank rotates it).
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/client/api-fetch";
import { SelectMenu } from "@/components/ui/select-menu";

export interface LdapFormInitial {
  id: string;
  slug: string;
  name: string;
  serverUrl: string;
  startTls: boolean;
  bindDn: string;
  userSearchBase: string;
  userSearchFilter: string;
  groupSearchBase: string | null;
  groupSearchFilter: string | null;
  groupAttr: string;
  claimEmail: string;
  claimName: string;
  /** Bytes are not round-tripped — only the "is one set?" state. */
  tlsCaCertSet: boolean;
  enabled: boolean;
  allowedEmailDomains: string[] | null;
  groupMappings: GroupMappingForm[];
}

export interface GroupMappingForm {
  group: string;
  roleSlug: string;
  scopeType: "global" | "team" | "zone" | "server";
  scopeId: string | null;
}

export interface PickerData {
  roles: Array<{ slug: string; name: string }>;
  teams: Array<{ slug: string; name: string }>;
  servers: Array<{ slug: string; name: string }>;
}

interface CreateProps {
  mode: "create";
  initial?: undefined;
  canEdit?: undefined;
  pickers: PickerData;
}

interface EditProps {
  mode: "edit";
  initial: LdapFormInitial;
  canEdit: boolean;
  pickers: PickerData;
}

type Props = CreateProps | EditProps;

interface ErrorBody {
  error?: string;
  details?: { fieldErrors?: Record<string, string[]> };
}

const DEFAULTS: LdapFormInitial = {
  id: "",
  slug: "",
  name: "",
  serverUrl: "",
  startTls: false,
  bindDn: "",
  userSearchBase: "",
  userSearchFilter: "(|(uid={{username}})(sAMAccountName={{username}})(mail={{username}}))",
  groupSearchBase: null,
  groupSearchFilter: null,
  groupAttr: "memberOf",
  claimEmail: "mail",
  claimName: "displayName",
  tlsCaCertSet: false,
  enabled: true,
  allowedEmailDomains: null,
  groupMappings: [],
};

export function LdapProviderForm(props: Props) {
  const router = useRouter();
  const initial = props.mode === "edit" ? props.initial : DEFAULTS;
  const canEdit = props.mode === "create" ? true : props.canEdit;

  const [slug, setSlug] = useState(initial.slug);
  const [name, setName] = useState(initial.name);
  const [serverUrl, setServerUrl] = useState(initial.serverUrl);
  const [startTls, setStartTls] = useState(initial.startTls);
  const [bindDn, setBindDn] = useState(initial.bindDn);
  const [bindPassword, setBindPassword] = useState("");
  const [userSearchBase, setUserSearchBase] = useState(initial.userSearchBase);
  const [userSearchFilter, setUserSearchFilter] = useState(initial.userSearchFilter);
  const [groupSearchBase, setGroupSearchBase] = useState(initial.groupSearchBase ?? "");
  const [groupSearchFilter, setGroupSearchFilter] = useState(initial.groupSearchFilter ?? "");
  const [groupAttr, setGroupAttr] = useState(initial.groupAttr);
  const [claimEmail, setClaimEmail] = useState(initial.claimEmail);
  const [claimName, setClaimName] = useState(initial.claimName);
  const [tlsCaCert, setTlsCaCert] = useState("");
  const [clearCaCert, setClearCaCert] = useState(false);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [overrideDomains, setOverrideDomains] = useState(initial.allowedEmailDomains !== null);
  const [domainsText, setDomainsText] = useState(
    initial.allowedEmailDomains ? initial.allowedEmailDomains.join("\n") : "",
  );
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

    const parsedDomains: string[] = domainsText
      .split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);

    interface Body {
      slug?: string;
      name: string;
      serverUrl: string;
      startTls: boolean;
      bindDn: string;
      bindPassword?: string;
      userSearchBase: string;
      userSearchFilter: string;
      groupSearchBase?: string | null;
      groupSearchFilter?: string | null;
      groupAttr: string;
      claimEmail: string;
      claimName: string;
      tlsCaCert?: string | null;
      enabled: boolean;
      allowedEmailDomains: string[] | null;
      groupMappings: GroupMappingForm[];
    }

    const body: Body = {
      name,
      serverUrl,
      startTls,
      bindDn,
      userSearchBase,
      userSearchFilter,
      groupAttr,
      claimEmail,
      claimName,
      enabled,
      allowedEmailDomains: overrideDomains ? parsedDomains : null,
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
    if (bindPassword !== "") body.bindPassword = bindPassword;

    // Group search pair: either both set, both cleared, or both omitted.
    // The form coalesces blank into "leave unchanged" on edit / "unset"
    // on create. Operators clear the pair by emptying both fields.
    if (props.mode === "create") {
      if (groupSearchBase.trim() !== "") body.groupSearchBase = groupSearchBase.trim();
      if (groupSearchFilter.trim() !== "") body.groupSearchFilter = groupSearchFilter.trim();
    } else {
      const baseChanged = groupSearchBase !== (initial.groupSearchBase ?? "");
      const filterChanged = groupSearchFilter !== (initial.groupSearchFilter ?? "");
      if (baseChanged) {
        body.groupSearchBase = groupSearchBase.trim() === "" ? null : groupSearchBase.trim();
      }
      if (filterChanged) {
        body.groupSearchFilter = groupSearchFilter.trim() === "" ? null : groupSearchFilter.trim();
      }
    }

    // CA pin. Three states in edit mode (unchanged / clear / set);
    // create mode is just "set or omit".
    if (props.mode === "create") {
      if (tlsCaCert.trim() !== "") body.tlsCaCert = tlsCaCert.trim();
    } else if (clearCaCert) {
      body.tlsCaCert = null;
    } else if (tlsCaCert.trim() !== "") {
      body.tlsCaCert = tlsCaCert.trim();
    }

    const url =
      props.mode === "edit"
        ? `/api/admin/ldap-providers/${props.initial.id}`
        : "/api/admin/ldap-providers";
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
      router.push("/admin/authentication");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <Field id="name" label="Display name" errors={fieldErrors["name"]}>
        <input
          id="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canEdit}
          placeholder="Corp AD"
          className={inputClass}
        />
      </Field>

      {props.mode === "create" ? (
        <Field
          id="slug"
          label="Slug"
          hint="URL-safe identifier used in the login route path. Lowercase letters, digits, and dashes. Cannot be changed later."
          errors={fieldErrors["slug"]}
        >
          <input
            id="slug"
            required
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="corp-ad"
            className={inputClass}
          />
        </Field>
      ) : null}

      <Field
        id="serverUrl"
        label="Server URL"
        hint="ldaps://host:636 (preferred) or ldap://host:389. Plain ldap:// is refused unless StartTLS is enabled below or LDAP_ALLOW_INSECURE_PORT_389=true is set in the env."
        errors={fieldErrors["serverUrl"]}
      >
        <input
          id="serverUrl"
          type="url"
          required
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          disabled={!canEdit}
          placeholder="ldaps://ad.example.com:636"
          className={inputClass}
        />
      </Field>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={startTls}
          onChange={(e) => setStartTls(e.target.checked)}
          disabled={!canEdit}
          className="mt-0.5"
        />
        <span>
          Upgrade the connection with StartTLS (RFC 4511 §4.14) after connecting
          <span className="block text-xs text-[color:var(--color-fg-muted)]">
            Only valid on plain <code>ldap://</code> URLs. Most servers reject StartTLS on the
            implicit-TLS port — pick this OR <code>ldaps://</code>, not both.
          </span>
        </span>
      </label>

      <Field
        id="bindDn"
        label="Service-account DN"
        hint="The DN we bind with first to look up the user. Common shape: CN=svc-authadmin,OU=ServiceAccounts,DC=example,DC=com"
        errors={fieldErrors["bindDn"]}
      >
        <input
          id="bindDn"
          required
          value={bindDn}
          onChange={(e) => setBindDn(e.target.value)}
          disabled={!canEdit}
          placeholder="CN=svc-authadmin,OU=ServiceAccounts,DC=example,DC=com"
          className={`${inputClass} font-mono text-xs`}
        />
      </Field>

      <Field
        id="bindPassword"
        label={
          props.mode === "edit" ? "Rotate service-account password" : "Service-account password"
        }
        hint={
          props.mode === "edit"
            ? "Leave blank to keep the existing password. Submitting a new value rotates it."
            : "Stored AES-256-GCM-encrypted at rest. Shown only at creation time."
        }
        errors={fieldErrors["bindPassword"]}
      >
        <input
          id="bindPassword"
          type="password"
          autoComplete="off"
          required={props.mode === "create"}
          value={bindPassword}
          onChange={(e) => setBindPassword(e.target.value)}
          disabled={!canEdit}
          placeholder={props.mode === "edit" ? "•••••••• (unchanged)" : ""}
          className={inputClass}
        />
      </Field>

      <Field
        id="userSearchBase"
        label="User search base"
        hint="The DN under which the user record lives. The search is `sub` — nested OUs are fine."
        errors={fieldErrors["userSearchBase"]}
      >
        <input
          id="userSearchBase"
          required
          value={userSearchBase}
          onChange={(e) => setUserSearchBase(e.target.value)}
          disabled={!canEdit}
          placeholder="OU=Users,DC=example,DC=com"
          className={`${inputClass} font-mono text-xs`}
        />
      </Field>

      <Field
        id="userSearchFilter"
        label="User search filter"
        hint="RFC 4515 filter. The {{username}} placeholder is replaced with the LDAP-escaped username at sign-in time. Default matches both AD's sAMAccountName and OpenLDAP's uid."
        errors={fieldErrors["userSearchFilter"]}
      >
        <input
          id="userSearchFilter"
          required
          value={userSearchFilter}
          onChange={(e) => setUserSearchFilter(e.target.value)}
          disabled={!canEdit}
          className={`${inputClass} font-mono text-xs`}
        />
      </Field>

      <fieldset className="space-y-3 rounded-md border border-[color:var(--color-border)] p-3">
        <legend className="px-1 text-sm font-medium">Group resolution</legend>
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          The group list is read first from the <code>{groupAttr || "memberOf"}</code> attribute on
          the user record (AD's default). When that's empty AND a group search base + filter is
          configured below, a second search resolves group memberships (OpenLDAP without the
          memberof overlay).
        </p>
        <Field id="groupAttr" label="Group attribute" errors={fieldErrors["groupAttr"]}>
          <input
            id="groupAttr"
            value={groupAttr}
            onChange={(e) => setGroupAttr(e.target.value)}
            disabled={!canEdit}
            placeholder="memberOf"
            className={`${inputClass} font-mono text-xs`}
          />
        </Field>
        <Field
          id="groupSearchBase"
          label="Optional group search base"
          errors={fieldErrors["groupSearchBase"]}
        >
          <input
            id="groupSearchBase"
            value={groupSearchBase}
            onChange={(e) => setGroupSearchBase(e.target.value)}
            disabled={!canEdit}
            placeholder="OU=Groups,DC=example,DC=com"
            className={`${inputClass} font-mono text-xs`}
          />
        </Field>
        <Field
          id="groupSearchFilter"
          label="Optional group search filter"
          hint="Use {{userDn}} for the user's DN. Common: (&(objectClass=group)(member={{userDn}}))"
          errors={fieldErrors["groupSearchFilter"]}
        >
          <input
            id="groupSearchFilter"
            value={groupSearchFilter}
            onChange={(e) => setGroupSearchFilter(e.target.value)}
            disabled={!canEdit}
            placeholder="(&(objectClass=group)(member={{userDn}}))"
            className={`${inputClass} font-mono text-xs`}
          />
        </Field>
      </fieldset>

      <div className="grid grid-cols-2 gap-4">
        <Field id="claimEmail" label="Email attribute" errors={fieldErrors["claimEmail"]}>
          <input
            id="claimEmail"
            required
            value={claimEmail}
            onChange={(e) => setClaimEmail(e.target.value)}
            disabled={!canEdit}
            className={`${inputClass} font-mono text-xs`}
          />
        </Field>
        <Field id="claimName" label="Display name attribute" errors={fieldErrors["claimName"]}>
          <input
            id="claimName"
            required
            value={claimName}
            onChange={(e) => setClaimName(e.target.value)}
            disabled={!canEdit}
            className={`${inputClass} font-mono text-xs`}
          />
        </Field>
      </div>

      <Field
        id="tlsCaCert"
        label="TLS CA pin (PEM, optional)"
        hint="Paste one or more PEM-encoded CA certificates to trust an internal CA without disabling verification. Combine with rejectUnauthorized=true."
        errors={fieldErrors["tlsCaCert"]}
      >
        <textarea
          id="tlsCaCert"
          rows={5}
          value={tlsCaCert}
          onChange={(e) => setTlsCaCert(e.target.value)}
          disabled={!canEdit}
          placeholder={
            initial.tlsCaCertSet
              ? "(CA pin set — paste a new PEM to replace, or check Clear)"
              : "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
          }
          className={`${inputClass} font-mono text-xs`}
        />
        {props.mode === "edit" && initial.tlsCaCertSet ? (
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={clearCaCert}
              onChange={(e) => setClearCaCert(e.target.checked)}
              disabled={!canEdit}
            />
            <span>Clear the stored CA pin on save</span>
          </label>
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
            Restrict auto-provisioning to specific email domains
            <span className="block text-xs text-[color:var(--color-fg-muted)]">
              Off: any directory user with a valid email gets a local account on first sign-in. On:
              only addresses in the list below are accepted.
            </span>
          </span>
        </label>
        {overrideDomains ? (
          <Field
            id="allowedEmailDomains"
            label="Allowed email domains"
            hint="One bare domain per line (e.g. example.com). Lowercase."
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
          On every successful sign-in, the group set (from <code>{groupAttr || "memberOf"}</code> or
          the second search) is matched against the rules below. Each matching row materialises a
          role assignment tagged with this provider — the NEXT sign-in revokes it if the user is no
          longer in the group. Admin-issued assignments are never touched.
        </p>
        {groupMappings.length === 0 ? (
          <p className="text-xs text-[color:var(--color-fg-muted)] italic">
            No mappings yet. Add one to grant roles based on directory group membership.
          </p>
        ) : (
          <ul className="space-y-2">
            {groupMappings.map((m, i) => (
              <li
                key={i}
                className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-2"
              >
                <label className="text-xs">
                  LDAP group
                  <input
                    value={m.group}
                    onChange={(e) => updateGroupMapping(i, { group: e.target.value })}
                    disabled={!canEdit}
                    placeholder="CN=Admins,OU=Groups,DC=example,DC=com"
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
            onClick={() => router.push("/admin/authentication")}
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
