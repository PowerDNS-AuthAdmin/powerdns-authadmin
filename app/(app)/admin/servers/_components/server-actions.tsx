"use client";

/**
 * app/(app)/admin/servers/_components/server-actions.tsx
 *
 * Test-connection + delete buttons for the edit page. Calls the admin routes
 * directly and renders the response inline.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { apiFetch, mutate } from "@/lib/client/api-fetch";

interface ServerActionsProps {
  id: string;
}

interface TestResponse {
  ok: boolean;
  /**
   * Coarse classification on failure: `auth | reachable | unreachable |
   * unknown`. The server intentionally does NOT return the raw upstream
   * error (S-12) - operators correlate via `requestId` against the
   * server-side log.
   */
  kind?: "auth" | "reachable" | "unreachable" | "unknown";
  /** Static human-readable hint per kind. Safe to render verbatim. */
  hint?: string;
  /** Echoed from the middleware so operators can join the log line. */
  requestId?: string | null;
  persisted?: boolean;
  cache?: {
    version: string;
    serverId: string;
    capabilities: {
      supportsExtendPrune: boolean;
      supportsCatalogZones: boolean;
      supportsViews: boolean;
    };
  };
}

export function ServerActions({ id }: ServerActionsProps) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState<TestResponse | null>(null);

  async function handleTest() {
    setTesting(true);
    setResult(null);
    try {
      const res = await apiFetch(`/api/admin/pdns-servers/${id}/test`, {
        method: "POST",
      });
      const data = (await res.json()) as TestResponse;
      setResult(data);
      if (data.ok) router.refresh();
    } catch {
      setResult({
        ok: false,
        kind: "unknown",
        hint: "Network error during connection test.",
      });
    } finally {
      setTesting(false);
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: "Delete this PowerDNS server?",
      description:
        "Audit history is preserved. Zones on this backend will no longer be reachable through the UI.",
      confirmLabel: "Delete server",
      variant: "danger",
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const result = await mutate(`/api/admin/pdns-servers/${id}`, {
        method: "DELETE",
      });
      if (!result.ok) {
        toast({
          kind: "error",
          title: "Delete failed",
          description: result.error,
        });
        return;
      }
      toast({ kind: "success", description: "Server deleted." });
      router.push("/admin/servers");
      router.refresh();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className="space-y-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-5">
      <header>
        <h2 className="text-sm font-medium">Diagnostics</h2>
        <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
          Test the connection to verify credentials and capability flags.
        </p>
      </header>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleTest}
          disabled={testing}
          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-4 py-2 text-sm hover:bg-[color:var(--color-bg-muted)] disabled:opacity-50"
        >
          {testing ? "Testing…" : "Test connection"}
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="ml-auto rounded-md border border-[color:var(--color-error)] px-4 py-2 text-sm text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
        >
          {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>

      {result ? (
        <div
          className={[
            "rounded-md border p-3 text-sm",
            result.ok
              ? "border-[color:var(--color-success)] bg-[color:var(--color-success)]/10"
              : "border-[color:var(--color-error)] bg-[color:var(--color-error)]/10",
          ].join(" ")}
        >
          {result.ok ? (
            <>
              <div className="font-medium">Connection OK</div>
              {result.cache ? (
                <ul className="mt-2 list-disc pl-5 text-xs">
                  <li>PDNS version: {result.cache.version}</li>
                  <li>Server id: {result.cache.serverId}</li>
                  <li>
                    EXTEND/PRUNE: {result.cache.capabilities.supportsExtendPrune ? "yes" : "no"}
                  </li>
                  <li>
                    Catalog zones: {result.cache.capabilities.supportsCatalogZones ? "yes" : "no"}
                  </li>
                  <li>
                    Views (split-horizon): {result.cache.capabilities.supportsViews ? "yes" : "no"}
                  </li>
                </ul>
              ) : null}
              {result.persisted ? (
                <p className="mt-2 text-xs">Snapshot persisted to the row.</p>
              ) : null}
            </>
          ) : (
            <>
              <div className="font-medium">
                Connection failed{result.kind ? ` (${result.kind})` : ""}
              </div>
              <p className="mt-1 text-xs">{result.hint ?? "Unknown error."}</p>
              {result.requestId ? (
                <p className="mt-2 font-mono text-[0.625rem] text-[color:var(--color-fg-muted)]">
                  request-id: {result.requestId}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
