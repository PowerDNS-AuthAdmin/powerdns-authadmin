"use client";

/**
 * app/(app)/admin/oidc-providers/_components/refresh-all-button.tsx
 *
 * Fleet-level "Refresh all" for the OIDC providers list. Forces a discovery
 * re-probe of every enabled provider, bypassing the sampler's 15-minute
 * staleness gate. Thin wrapper over the shared <RefreshAllButton>.
 */

import { RefreshAllButton as RefreshAllButtonBase } from "@/components/ui/refresh-all-button";

interface RefreshAllResponse {
  ok: boolean;
  probed?: number;
  requestId?: string;
}

export function RefreshAllButton() {
  return (
    <RefreshAllButtonBase<RefreshAllResponse>
      endpoint="/api/admin/oidc-providers/refresh-all"
      title="Re-probe every enabled provider's discovery endpoint right now (ignores the 15-minute auto-refresh cooldown)."
      successToast={(data) => ({
        kind: "success",
        title: "Discovery refreshed",
        description: `Re-probed ${data.probed ?? 0} enabled provider${data.probed === 1 ? "" : "s"}. Inline badges show the new result.`,
      })}
    />
  );
}
