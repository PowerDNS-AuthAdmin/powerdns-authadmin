"use client";

/**
 * app/(app)/admin/authentication/_components/new-provider-client.tsx
 *
 * Stateful wrapper for /admin/authentication/new. Owns:
 *
 *   1. URL-driven type selection (`?type=oidc|saml|ldap` survives reload + back/forward).
 *   2. The conditional form switch: OIDC renders <OidcProviderForm mode="create">,
 *      SAML renders <SamlProviderForm mode="create"> (ADR-0021), LDAP renders
 *      <LdapProviderForm mode="create"> (ADR-0020).
 *
 * The pre-fetched pickers (`roles` / `teams` / `servers`) the group-mapping
 * editors need are loaded server-side and passed down. All three forms share
 * the same pickers shape.
 */

import { useRouter, useSearchParams } from "next/navigation";
import {
  OidcProviderForm,
  type PickerData,
} from "@/app/(app)/admin/authentication/oidc/_components/oidc-provider-form";
import { SamlProviderForm } from "@/app/(app)/admin/authentication/saml/_components/saml-provider-form";
import { LdapProviderForm } from "@/app/(app)/admin/authentication/ldap/_components/ldap-provider-form";
import { ProviderTypePicker, type ProviderType } from "./provider-type-picker";

function parseType(raw: string | null): ProviderType | null {
  if (raw === "oidc" || raw === "saml" || raw === "ldap") return raw;
  return null;
}

interface Props {
  pickers: PickerData;
}

export function NewProviderClient({ pickers }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const selected = parseType(params.get("type"));

  function handleSelect(next: ProviderType) {
    const url = next ? `/admin/authentication/new?type=${next}` : "/admin/authentication/new";
    router.replace(url);
  }

  return (
    <div className="space-y-6">
      <ProviderTypePicker selected={selected} onSelect={handleSelect} />

      {selected === "oidc" ? (
        <section className="space-y-4 border-t border-[color:var(--color-border)] pt-6">
          <header>
            <h2 className="text-lg font-semibold">OIDC provider</h2>
            <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
              Configure the identity provider below. Register the callback URL with the IdP before
              saving.
            </p>
          </header>
          <OidcProviderForm mode="create" pickers={pickers} />
        </section>
      ) : selected === "saml" ? (
        <section className="space-y-4 border-t border-[color:var(--color-border)] pt-6">
          <header>
            <h2 className="text-lg font-semibold">SAML 2.0 provider</h2>
            <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
              Configure the SAML identity provider below. After saving, copy the SP metadata URL
              from the provider detail page and register it in your IdP.
            </p>
          </header>
          <SamlProviderForm mode="create" pickers={pickers} />
        </section>
      ) : selected === "ldap" ? (
        <section className="space-y-4 border-t border-[color:var(--color-border)] pt-6">
          <header>
            <h2 className="text-lg font-semibold">LDAP provider</h2>
            <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
              Configure the directory below. Bind-then-search-then-rebind: we use the service
              account to look up the user, then re-bind as the user with the password they type.
              Strict TLS by default — see ADR-0020 for the security posture.
            </p>
          </header>
          <LdapProviderForm mode="create" pickers={pickers} />
        </section>
      ) : null}
    </div>
  );
}
