"use client";

/**
 * app/(app)/admin/auth-providers/saml/_components/saml-provider-form.tsx
 *
 * Shared create / edit form for a SAML provider. Structurally parallel to
 * the OIDC form (`../../oidc-providers/_components/oidc-provider-form.tsx`).
 * SP private-key material is required on create and optional on edit (blank
 * keeps the existing encrypted value).
 */

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiFetch } from "@/lib/client/api-fetch";
import { SelectMenu } from "@/components/ui/select-menu";

interface FormInitial {
  id: string;
  slug: string;
  name: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpSloUrl: string;
  idpSigningCert: string;
  spSigningCert: string;
  hasEncryptionPair: boolean;
  spEncryptionCert: string;
  requireSignedResponse: boolean;
  requireEncryptedAssertion: boolean;
  signatureAlgorithm: "sha1" | "sha256" | "sha512";
  nameIdFormat: string;
  claimEmail: string;
  claimName: string;
  claimGroups: string;
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
  idpEntityId: "",
  idpSsoUrl: "",
  idpSloUrl: "",
  idpSigningCert: "",
  spSigningCert: "",
  hasEncryptionPair: false,
  spEncryptionCert: "",
  requireSignedResponse: true,
  requireEncryptedAssertion: false,
  signatureAlgorithm: "sha256",
  nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  claimEmail: "email",
  claimName: "name",
  claimGroups: "groups",
  enabled: true,
  allowedEmailDomains: null,
  groupMappings: [],
};

export function SamlProviderForm(props: Props) {
  const router = useRouter();
  const initial = props.mode === "edit" ? props.initial : DEFAULTS;
  const canEdit = props.mode === "create" ? true : props.canEdit;

  const [slug, setSlug] = useState(initial.slug);
  const [name, setName] = useState(initial.name);
  const [idpEntityId, setIdpEntityId] = useState(initial.idpEntityId);
  const [idpSsoUrl, setIdpSsoUrl] = useState(initial.idpSsoUrl);
  const [idpSloUrl, setIdpSloUrl] = useState(initial.idpSloUrl);
  const [idpSigningCert, setIdpSigningCert] = useState(initial.idpSigningCert);
  // SP key + cert: required at create, optional on edit. The textarea value
  // is the plaintext PEM; the server encrypts before storing.
  const [spSigningKey, setSpSigningKey] = useState("");
  const [spSigningCert, setSpSigningCert] = useState(initial.spSigningCert);
  const [useEncryption, setUseEncryption] = useState(initial.hasEncryptionPair);
  const [spEncryptionKey, setSpEncryptionKey] = useState("");
  const [spEncryptionCert, setSpEncryptionCert] = useState(initial.spEncryptionCert);
  const [requireSignedResponse, setRequireSignedResponse] = useState(initial.requireSignedResponse);
  const [requireEncryptedAssertion, setRequireEncryptedAssertion] = useState(
    initial.requireEncryptedAssertion,
  );
  const [signatureAlgorithm, setSignatureAlgorithm] = useState(initial.signatureAlgorithm);
  const [nameIdFormat, setNameIdFormat] = useState(initial.nameIdFormat);
  const [claimEmail, setClaimEmail] = useState(initial.claimEmail);
  const [claimName, setClaimName] = useState(initial.claimName);
  const [claimGroups, setClaimGroups] = useState(initial.claimGroups);
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
      idpEntityId: string;
      idpSsoUrl: string;
      idpSloUrl: string | null;
      idpSigningCert: string;
      spSigningKey?: string;
      spSigningCert?: string;
      spEncryptionKey?: string | null;
      spEncryptionCert?: string | null;
      requireSignedResponse: boolean;
      requireEncryptedAssertion: boolean;
      signatureAlgorithm: string;
      nameIdFormat: string;
      claimEmail: string;
      claimName: string;
      claimGroups: string;
      enabled: boolean;
      allowedEmailDomains: string[] | null;
      groupMappings: GroupMappingForm[];
    }

    const body: Body = {
      name,
      idpEntityId,
      idpSsoUrl,
      idpSloUrl: idpSloUrl.trim() === "" ? null : idpSloUrl.trim(),
      idpSigningCert,
      requireSignedResponse,
      requireEncryptedAssertion,
      signatureAlgorithm,
      nameIdFormat,
      claimEmail,
      claimName,
      claimGroups,
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
    // Signing keypair: create always sends, edit only when both halves were
    // supplied (rotation).
    if (props.mode === "create") {
      body.spSigningKey = spSigningKey;
      body.spSigningCert = spSigningCert;
    } else if (spSigningKey.trim() !== "" && spSigningCert.trim() !== "") {
      body.spSigningKey = spSigningKey;
      body.spSigningCert = spSigningCert;
    }
    if (useEncryption) {
      if (spEncryptionKey.trim() !== "") body.spEncryptionKey = spEncryptionKey;
      if (spEncryptionCert.trim() !== "") body.spEncryptionCert = spEncryptionCert;
    } else if (props.mode === "edit" && initial.hasEncryptionPair) {
      // Edit mode and the operator turned encryption off — clear both halves.
      body.spEncryptionKey = null;
      body.spEncryptionCert = null;
    }

    const url =
      props.mode === "edit"
        ? `/api/admin/saml-providers/${props.initial.id}`
        : "/api/admin/saml-providers";
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
      <Field
        id="name"
        label="Display name"
        hint="Shown on the login button — e.g. 'Continue with Company SSO'."
        errors={fieldErrors["name"]}
      >
        <input
          id="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canEdit}
          placeholder="Company SSO"
          className={inputClass}
        />
      </Field>

      {props.mode === "create" ? (
        <Field
          id="slug"
          label="Slug"
          hint="URL-safe identifier used in the ACS / metadata path. Lowercase letters, digits, and dashes. Cannot be changed later."
          errors={fieldErrors["slug"]}
        >
          <input
            id="slug"
            required
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="company-sso"
            className={inputClass}
          />
        </Field>
      ) : null}

      <fieldset className="space-y-3 rounded-md border border-[color:var(--color-border)] p-3">
        <legend className="px-1 text-sm font-medium">Identity provider</legend>
        <Field
          id="idpEntityId"
          label="IdP entityID"
          hint="The IdP's Issuer URI (Authentik: 'authentik'; Keycloak: realm issuer URL; AD FS: 'http://adfs.example.com/adfs/services/trust')."
          errors={fieldErrors["idpEntityId"]}
        >
          <input
            id="idpEntityId"
            required
            value={idpEntityId}
            onChange={(e) => setIdpEntityId(e.target.value)}
            disabled={!canEdit}
            className={inputClass}
          />
        </Field>

        <Field
          id="idpSsoUrl"
          label="IdP SSO URL"
          hint="The IdP's SAML 2.0 sign-in endpoint (HTTP-Redirect binding)."
          errors={fieldErrors["idpSsoUrl"]}
        >
          <input
            id="idpSsoUrl"
            type="url"
            required
            value={idpSsoUrl}
            onChange={(e) => setIdpSsoUrl(e.target.value)}
            disabled={!canEdit}
            className={inputClass}
          />
        </Field>

        <Field
          id="idpSloUrl"
          label="IdP SLO URL (optional)"
          hint="Single Logout endpoint. Leave blank to disable IdP-side logout — local sessions still end."
          errors={fieldErrors["idpSloUrl"]}
        >
          <input
            id="idpSloUrl"
            type="url"
            value={idpSloUrl}
            onChange={(e) => setIdpSloUrl(e.target.value)}
            disabled={!canEdit}
            className={inputClass}
          />
        </Field>

        <Field
          id="idpSigningCert"
          label="IdP signing certificate (PEM)"
          hint="Public X.509 cert the IdP uses to sign Responses."
          errors={fieldErrors["idpSigningCert"]}
        >
          <textarea
            id="idpSigningCert"
            required
            rows={6}
            value={idpSigningCert}
            onChange={(e) => setIdpSigningCert(e.target.value)}
            disabled={!canEdit}
            placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
            className={`${inputClass} font-mono text-xs`}
          />
        </Field>
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-[color:var(--color-border)] p-3">
        <legend className="px-1 text-sm font-medium">Service provider (this app)</legend>
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          Generate with{" "}
          <code className="font-mono">
            openssl req -x509 -newkey rsa:2048 -keyout sp.key -out sp.crt -nodes -days 1825 -subj
            &quot;/CN={slug || "sso"}&quot;
          </code>
          .
        </p>

        <Field
          id="spSigningKey"
          label={props.mode === "edit" ? "Rotate SP private key (PEM)" : "SP private key (PEM)"}
          hint={
            props.mode === "edit"
              ? "Leave blank to keep the existing key. Supply both key + cert to rotate."
              : "Encrypted at rest; never shown again after save."
          }
          errors={fieldErrors["spSigningKey"]}
        >
          <textarea
            id="spSigningKey"
            required={props.mode === "create"}
            rows={6}
            value={spSigningKey}
            onChange={(e) => setSpSigningKey(e.target.value)}
            disabled={!canEdit}
            placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
            className={`${inputClass} font-mono text-xs`}
          />
        </Field>

        <Field
          id="spSigningCert"
          label="SP signing certificate (PEM)"
          errors={fieldErrors["spSigningCert"]}
        >
          <textarea
            id="spSigningCert"
            required={props.mode === "create"}
            rows={6}
            value={spSigningCert}
            onChange={(e) => setSpSigningCert(e.target.value)}
            disabled={!canEdit}
            placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
            className={`${inputClass} font-mono text-xs`}
          />
        </Field>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={useEncryption}
            onChange={(e) => setUseEncryption(e.target.checked)}
            disabled={!canEdit}
            className="mt-0.5"
          />
          <span>
            Configure assertion encryption keypair
            <span className="block text-xs text-[color:var(--color-fg-muted)]">
              Optional — operators that want the IdP to encrypt assertions to this SP supply an
              encryption keypair below.
            </span>
          </span>
        </label>

        {useEncryption ? (
          <div className="space-y-3 pl-6">
            <Field
              id="spEncryptionKey"
              label={
                props.mode === "edit"
                  ? "Rotate SP encryption private key (PEM)"
                  : "SP encryption private key (PEM)"
              }
              errors={fieldErrors["spEncryptionKey"]}
            >
              <textarea
                id="spEncryptionKey"
                rows={6}
                value={spEncryptionKey}
                onChange={(e) => setSpEncryptionKey(e.target.value)}
                disabled={!canEdit}
                className={`${inputClass} font-mono text-xs`}
              />
            </Field>
            <Field
              id="spEncryptionCert"
              label="SP encryption certificate (PEM)"
              errors={fieldErrors["spEncryptionCert"]}
            >
              <textarea
                id="spEncryptionCert"
                rows={6}
                value={spEncryptionCert}
                onChange={(e) => setSpEncryptionCert(e.target.value)}
                disabled={!canEdit}
                className={`${inputClass} font-mono text-xs`}
              />
            </Field>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-[color:var(--color-border)] p-3">
        <legend className="px-1 text-sm font-medium">Protocol options</legend>
        <Field id="signatureAlgorithm" label="Signature algorithm">
          <SelectMenu
            value={signatureAlgorithm}
            onChange={(v) => setSignatureAlgorithm(v)}
            disabled={!canEdit}
            ariaLabel="Signature algorithm"
            options={[
              { value: "sha1", label: "SHA-1 (legacy)" },
              { value: "sha256", label: "SHA-256 (recommended)" },
              { value: "sha512", label: "SHA-512" },
            ]}
            className="mt-1 w-full text-sm"
          />
        </Field>

        <Field
          id="nameIdFormat"
          label="NameID format"
          hint="The format the SP requests in the AuthnRequest. Most IdPs accept the default emailAddress form."
          errors={fieldErrors["nameIdFormat"]}
        >
          <input
            id="nameIdFormat"
            value={nameIdFormat}
            onChange={(e) => setNameIdFormat(e.target.value)}
            disabled={!canEdit}
            className={`${inputClass} font-mono text-xs`}
          />
        </Field>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={requireSignedResponse}
            onChange={(e) => setRequireSignedResponse(e.target.checked)}
            disabled={!canEdit}
            className="mt-0.5"
          />
          <span>
            Require signed Response (in addition to signed Assertion)
            <span className="block text-xs text-[color:var(--color-fg-muted)]">
              On by default. Disable only for IdPs that sign just the inner Assertion.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={requireEncryptedAssertion}
            onChange={(e) => setRequireEncryptedAssertion(e.target.checked)}
            disabled={!canEdit || !useEncryption}
            className="mt-0.5"
          />
          <span>
            Require encrypted Assertion
            <span className="block text-xs text-[color:var(--color-fg-muted)]">
              Off by default. Requires the SP encryption keypair above to be configured.
            </span>
          </span>
        </label>
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-[color:var(--color-border)] p-3">
        <legend className="px-1 text-sm font-medium">Attribute mapping</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field id="claimEmail" label="Email attribute" errors={fieldErrors["claimEmail"]}>
            <input
              id="claimEmail"
              value={claimEmail}
              onChange={(e) => setClaimEmail(e.target.value)}
              disabled={!canEdit}
              className={inputClass}
            />
          </Field>
          <Field id="claimName" label="Name attribute" errors={fieldErrors["claimName"]}>
            <input
              id="claimName"
              value={claimName}
              onChange={(e) => setClaimName(e.target.value)}
              disabled={!canEdit}
              className={inputClass}
            />
          </Field>
          <Field id="claimGroups" label="Groups attribute" errors={fieldErrors["claimGroups"]}>
            <input
              id="claimGroups"
              value={claimGroups}
              onChange={(e) => setClaimGroups(e.target.value)}
              disabled={!canEdit}
              className={inputClass}
            />
          </Field>
        </div>
      </fieldset>

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
              Off: inherit the env allow-list. On: use the list below (REPLACES env — empty allows
              any email).
            </span>
          </span>
        </label>
        {overrideDomains ? (
          <Field
            id="allowedEmailDomains"
            label="Allowed email domains"
            hint="One bare domain per line. Lowercase."
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
          On each successful SAML sign-in, the user&apos;s <code>{claimGroups}</code> attribute is
          matched against these rules. Each match materialises a role assignment tagged with this
          provider; the next sign-in revokes it if the user is no longer in the group.
        </p>
        {groupMappings.length === 0 ? (
          <p className="text-xs text-[color:var(--color-fg-muted)] italic">No mappings yet.</p>
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
                    placeholder="DomainAdmins"
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
