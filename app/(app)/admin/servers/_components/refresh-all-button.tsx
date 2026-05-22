"use client";

/**
 * app/(app)/admin/servers/_components/refresh-all-button.tsx
 *
 * Fleet-level "Refresh all" for the PDNS servers list. Posts to
 * `/api/admin/pdns-servers/refresh-all`, then refreshes so the new
 * version_cache + capability flags render. Reports probed/failed counts.
 * Thin wrapper over the shared <RefreshAllButton>.
 */

import { RefreshAllButton as RefreshAllButtonBase } from "@/components/ui/refresh-all-button";

interface RefreshAllResponse {
  ok: boolean;
  probed?: number;
  failed?: number;
  requestId?: string;
}

export function RefreshAllButton() {
  return (
    <RefreshAllButtonBase<RefreshAllResponse>
      endpoint="/api/admin/pdns-servers/refresh-all"
      title="Re-probe every active PDNS backend's version + capabilities right now."
      successToast={(data) => {
        const probed = data.probed ?? 0;
        const failed = data.failed ?? 0;
        return {
          kind: failed > 0 ? "error" : "success",
          title: failed > 0 ? "Refreshed with errors" : "Backends refreshed",
          description:
            failed > 0
              ? `${probed - failed} of ${probed} succeeded; ${failed} failed. Inline status shows which.`
              : `Re-probed ${probed} active backend${probed === 1 ? "" : "s"}. Inline version + capability flags reflect the new state.`,
        };
      }}
    />
  );
}
