/**
 * app/(app)/admin/settings/backup/page.tsx
 *
 * Super-admin-gated backup + restore wizard. Server component verifies
 * the permission and delegates the multi-step UI to a client component.
 * Lives under Settings because backup-and-restore is a tier-0
 * administrative concern alongside the runtime settings already there.
 */

import type { Metadata } from "next";
import { requireUserForPage } from "@/lib/auth/require-user";
import { ForbiddenError } from "@/lib/errors";
import { BackupRestoreWizard } from "./_components/backup-restore-wizard";

export const metadata: Metadata = { title: "Backup & Restore" };

export default async function BackupPage() {
  const { globalPermissions } = await requireUserForPage();
  if (!globalPermissions.has("system.backup")) {
    throw new ForbiddenError("Missing system.backup.");
  }
  return <BackupRestoreWizard />;
}
