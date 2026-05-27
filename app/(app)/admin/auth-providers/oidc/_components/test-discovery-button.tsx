"use client";

/**
 * app/(app)/admin/auth-providers/oidc/_components/test-discovery-button.tsx
 *
 * Operator-triggered "Test" for an OIDC provider's discovery
 * endpoint. Same UX shape as the PDNS server Test button:
 * click → toast outcome → refresh the row.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/client/api-fetch";

interface TestResponse {
  ok: boolean;
  reason?: string;
  hint?: string;
  fetchedAt?: string;
  requestId?: string;
}

export function TestDiscoveryButton({ providerId }: { providerId: string }) {
  const router = useRouter();
  const { toast } = useDialog();
  const [busy, setBusy] = useState(false);

  async function handleTest() {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/admin/oidc-providers/${providerId}/test`, {
        method: "POST",
      });
      if (!res.ok) {
        toast({
          kind: "error",
          title: "Test failed to dispatch",
          description: "Check your permissions or reload the page.",
        });
        return;
      }
      const data = (await res.json()) as TestResponse;
      if (data.ok) {
        toast({
          kind: "success",
          title: "Issuer reachable",
          description: "Discovery document fetched and issuer claim matches.",
        });
      } else {
        toast({
          kind: "error",
          title: `Probe failed (${data.reason ?? "unknown"})`,
          description: data.hint ?? "See server logs for details.",
        });
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleTest}
      disabled={busy}
      title="Probe this provider's .well-known/openid-configuration endpoint."
      className="rounded border border-[color:var(--color-border)] px-2 py-1 text-xs hover:bg-[color:var(--color-bg-muted)] disabled:opacity-50"
    >
      {busy ? "Testing…" : "Test"}
    </button>
  );
}
