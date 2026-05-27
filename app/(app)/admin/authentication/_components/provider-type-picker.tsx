"use client";

/**
 * app/(app)/admin/authentication/_components/provider-type-picker.tsx
 *
 * Three-card chooser for the "Add provider" flow. The operator picks a
 * protocol first; the parent (`<NewProviderClient/>`) then renders the
 * relevant form below. SAML and LDAP cards are visible-but-disabled with
 * a "Lands in PR N" chip so operators see the road map without false
 * affordance — clicking does nothing until those PRs ship.
 *
 * Selected state is URL-driven (`?type=oidc`). Clicking a card pushes the
 * query param via the parent's `onSelect`; back/forward + reload preserve
 * the chosen type. Card markup is a real `<button>` so keyboard users get
 * the same affordance as click.
 */

import { CircleDot, Network, Server } from "lucide-react";
import type { ReactNode } from "react";

export type ProviderType = "oidc" | "saml" | "ldap";

interface CardSpec {
  type: ProviderType;
  title: string;
  blurb: string;
  icon: ReactNode;
  /** When true the card is selectable; when false it's read-only "coming soon". */
  available: boolean;
  /** Short status string shown as a chip when `available` is false. */
  comingChip: string | null;
}

const CARDS: readonly CardSpec[] = [
  {
    type: "oidc",
    title: "OIDC",
    blurb: "OpenID Connect — Keycloak, Authentik, Microsoft Entra ID, Google, Okta.",
    icon: <CircleDot className="h-5 w-5" aria-hidden />,
    available: true,
    comingChip: null,
  },
  {
    type: "ldap",
    title: "LDAP",
    blurb:
      "Direct bind against Active Directory or OpenLDAP. Strict TLS default; group memberships via memberOf or search filter.",
    icon: <Server className="h-5 w-5" aria-hidden />,
    available: true,
    comingChip: null,
  },
  {
    type: "saml",
    title: "SAML 2.0",
    blurb:
      "Service-provider for AD FS, Authentik SAML, Keycloak SAML. Signed assertions required by default.",
    icon: <Network className="h-5 w-5" aria-hidden />,
    available: true,
    comingChip: null,
  },
];

interface Props {
  selected: ProviderType | null;
  onSelect: (next: ProviderType) => void;
}

export function ProviderTypePicker({ selected, onSelect }: Props) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Choose a provider type</legend>
      <p className="text-xs text-[color:var(--color-fg-muted)]">
        Pick the protocol your identity provider speaks. The configuration form changes to match.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        {CARDS.map((c) => {
          const isSelected = selected === c.type;
          const interactive = c.available;
          return (
            <button
              key={c.type}
              type="button"
              onClick={interactive ? () => onSelect(c.type) : undefined}
              disabled={!interactive}
              aria-pressed={interactive ? isSelected : undefined}
              className={[
                "group relative flex flex-col gap-2 rounded-md border p-4 text-left transition-colors",
                // Interactive cards (only OIDC today): hover hint, accent border when selected.
                interactive
                  ? isSelected
                    ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10"
                    : "border-[color:var(--color-border)] bg-[color:var(--color-bg)] hover:border-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-bg-subtle)]"
                  : "cursor-not-allowed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] opacity-70",
              ].join(" ")}
            >
              <div className="flex items-center gap-2">
                <span
                  className={
                    isSelected
                      ? "text-[color:var(--color-accent)]"
                      : "text-[color:var(--color-fg-muted)]"
                  }
                >
                  {c.icon}
                </span>
                <span className="font-medium">{c.title}</span>
                {c.comingChip ? (
                  <span className="ml-auto rounded-full border border-[color:var(--color-warn)]/40 bg-[color:var(--color-warn)]/10 px-2 py-0.5 text-[0.625rem] font-medium tracking-wide text-[color:var(--color-warn)] uppercase">
                    {c.comingChip}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-[color:var(--color-fg-muted)]">{c.blurb}</p>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
