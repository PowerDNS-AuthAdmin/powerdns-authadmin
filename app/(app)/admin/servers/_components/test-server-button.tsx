"use client";

/**
 * app/(app)/admin/servers/_components/test-server-button.tsx
 *
 * "Test" button for each row on the servers list. POSTs to
 * /api/admin/pdns-servers/[id]/test (already exists from ),
 * shows the outcome inline as a small toast + refreshes the row so
 * the badge picks up the new probe timestamp.
 *
 * Why client-side: the test is a write action (refreshes
 * `version_cache`), needs CSRF, and the user wants feedback in <1s.
 * A server-action with a redirect would work but `apiFetch` + toast
 * matches the pattern used elsewhere in the admin UI.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/client/api-fetch";

interface TestResponse {
  ok: boolean;
  kind?: "auth" | "reachable" | "unreachable" | "unknown";
  hint?: string;
  cache?: { version?: string } | null;
  requestId?: string;
}

export function TestServerButton({ serverId }: { serverId: string }) {
  const router = useRouter();
  const { toast } = useDialog();
  const [busy, setBusy] = useState(false);

  async function handleTest() {
    setBusy(true);
    try {
      const res = await apiFetch(`/api/admin/pdns-servers/${serverId}/test`, {
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
          title: "Reachable",
          description: data.cache?.version ? `PDNS version ${data.cache.version}` : "Probe OK.",
        });
        router.refresh();
        return;
      }
      // Failure outcomes (auth / unreachable / etc.) ride back as
      // 200 with `ok: false` — the route owner deliberately surfaces
      // them in-band so the form can render them inline. Mirror that
      // here: classify into a toast with the actionable hint.
      toast({
        kind: "error",
        title: `Probe failed (${data.kind ?? "unknown"})`,
        description: data.hint ?? "See server logs for details.",
      });
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
      title="Probe this PDNS backend and refresh the cached version snapshot."
      className="rounded border border-[color:var(--color-border)] px-2 py-1 text-xs hover:bg-[color:var(--color-bg-muted)] disabled:opacity-50"
    >
      {busy ? "Testing…" : "Test"}
    </button>
  );
}
