"use client";

/**
 * Confirm-then-DELETE button for a PDNS cluster. Thin wrapper over the shared
 * <ConfirmDeleteButton>; the description explains the member-detach side effect.
 */

import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";

export function DeleteClusterButton({
  clusterId,
  clusterName,
  memberCount,
}: {
  clusterId: string;
  clusterName: string;
  memberCount: number;
}) {
  return (
    <ConfirmDeleteButton
      endpoint={`/api/admin/pdns/clusters/${clusterId}`}
      confirmTitle={`Delete group "${clusterName}"?`}
      confirmDescription={
        memberCount > 0
          ? `${memberCount} server${memberCount === 1 ? "" : "s"} will be detached from this group and revert to standalone semantics. The server rows themselves stay.`
          : "The group has no members. Deleting it is a clean no-op for the servers list."
      }
      confirmLabel="Delete group"
      successMessage="Group deleted."
      label="Delete group"
      redirectTo="/admin/clusters"
    />
  );
}
