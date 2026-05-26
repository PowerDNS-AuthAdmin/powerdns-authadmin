"use client";

/**
 * app/(app)/zones/[zoneId]/_components/clone-zone-button.tsx
 *
 * Clone-zone affordance. Uses the DialogProvider's `prompt()`
 * primitive  so the operator interaction matches
 * every other in-app modal — no native window.prompt.
 *
 * Conditional on `zone.create` (parent passes `canCreate`).
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";
import { displayZoneName } from "@/lib/dns/zone-name";

interface Props {
  sourceName: string;
  serverSlug: string;
}

const HOST_LIKE =
  /^[A-Za-z0-9_*]([A-Za-z0-9_*-]{0,62}[A-Za-z0-9_*])?(?:\.[A-Za-z0-9_*]([A-Za-z0-9_*-]{0,62}[A-Za-z0-9_*])?)*\.?$/;

export function CloneZoneButton({ sourceName, serverSlug }: Props) {
  const router = useRouter();
  const { prompt, toast } = useDialog();
  const [cloning, setCloning] = useState(false);

  async function handleClick() {
    const target = await prompt({
      title: "Clone zone",
      description: `Creates a new zone seeded with every rrset from ${displayZoneName(sourceName)} except the SOA. PDNS regenerates the SOA on the new zone.`,
      label: "New zone name",
      defaultValue: suggestTargetName(sourceName),
      placeholder: "new-zone-name.example.",
      confirmLabel: "Clone",
      validate: (v) => {
        if (v.length === 0) return "Enter a zone name.";
        if (!HOST_LIKE.test(v)) return "Zone name has invalid label characters.";
        return null;
      },
    });
    if (!target) return;

    setCloning(true);
    try {
      const result = await mutate(`/api/admin/pdns/zones/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverSlug,
          sourceName,
          targetName: target,
        }),
      });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Clone failed",
          description: result.error,
        });
        return;
      }
      const data = result.data as { nextUrl: string };
      toast({ kind: "success", description: `Cloned to ${target}.` });
      router.push(data.nextUrl);
    } finally {
      setCloning(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={cloning}
      className="rounded border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-bg-muted)] disabled:opacity-50"
    >
      {cloning ? "Cloning…" : "Clone zone"}
    </button>
  );
}

function suggestTargetName(source: string): string {
  // Drop the trailing dot for the prompt — operators usually type
  // without it. The API canonicalizes either way.
  const stripped = source.replace(/\.$/, "");
  return `clone-${stripped}`;
}
