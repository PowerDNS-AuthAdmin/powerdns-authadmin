"use client";

/**
 * app/(app)/admin/authentication/_components/new-provider-client.tsx
 *
 * Stateful wrapper for /admin/authentication/new. Owns:
 *
 *   1. URL-driven type selection (`?type=oidc` survives reload + back/forward).
 *   2. The conditional form switch: OIDC renders the existing
 *      `<OidcProviderForm mode="create">`; SAML and LDAP render a brief
 *      "lands in PR N" panel because those protocols aren't implemented
 *      yet (the cards in the picker are also disabled for those types).
 *
 * The pre-fetched pickers (`roles` / `teams` / `servers`) the OIDC group-
 * mapping editor needs are loaded server-side and passed down — same shape
 * the legacy `/admin/oidc-providers/new` used.
 */

import { useRouter, useSearchParams } from "next/navigation";
import {
  OidcProviderForm,
  type PickerData,
} from "@/app/(app)/admin/oidc-providers/_components/oidc-provider-form";
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
    // `replace` (not push) so the picker doesn't pile up history entries
    // every time the operator clicks between cards.
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
      ) : selected === "saml" || selected === "ldap" ? (
        <ComingSoonPanel type={selected} />
      ) : null}
    </div>
  );
}

function ComingSoonPanel({ type }: { type: "saml" | "ldap" }) {
  const label = type === "saml" ? "SAML 2.0" : "LDAP";
  const pr = type === "saml" ? "PR 3" : "PR 2";
  const adr = type === "saml" ? "ADR-0021" : "ADR-0020";
  return (
    <section className="space-y-2 rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-6 text-sm">
      <h2 className="text-base font-semibold">{label} — coming soon</h2>
      <p className="text-[color:var(--color-fg-muted)]">
        The {label} provider lands in {pr} of the
        <code className="mx-1 rounded bg-[color:var(--color-bg)] px-1 font-mono text-xs">
          feat/auth-providers-ldap-saml-webauthn
        </code>
        feature branch. The design is locked in {adr}; the configuration form will appear here once
        the schema, validators, and admin routes are wired.
      </p>
      <p className="text-xs text-[color:var(--color-fg-muted)]">
        Pick another protocol from the cards above, or set
        <code className="mx-1 rounded bg-[color:var(--color-bg)] px-1 font-mono text-xs">
          PDNS_AUTHADMIN_VERSION
        </code>
        to a release that includes {pr} once it ships.
      </p>
    </section>
  );
}
