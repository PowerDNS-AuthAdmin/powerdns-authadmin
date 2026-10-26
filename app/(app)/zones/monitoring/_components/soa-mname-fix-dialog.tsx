"use client";

/**
 * app/(app)/zones/monitoring/_components/soa-mname-fix-dialog.tsx
 *
 * The review step of one zone's suggested SOA MNAME fix: the BIND-style
 * before/after the same way the record editor's "Review changes" does, saved
 * through the zone's own write route (see ./soa-mname-fix.ts). The server is
 * the authority on permission: the monitoring page is readable with
 * `zone.read`, so a 403 here is expected for read-only operators and is said
 * plainly.
 */

import { useEffect, useState } from "react";
import { BareDiff, computeBindDiff } from "@/app/(app)/zones/[zoneId]/_components/bare-diff";
import type { ZoneFindingFix } from "@/components/domain/zone-monitor-format";
import { Dialog, useDialog } from "@/components/ui/dialog";
import { planSoaMnameFix, saveSoa, type SoaRRset } from "./soa-mname-fix";

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; before: SoaRRset; after: SoaRRset };

export function SoaMnameFixDialog({
  fix,
  serverSlug,
  onClose,
  onApplied,
}: {
  /** The fix under review. The caller mounts the dialog only while it is open. */
  fix: ZoneFindingFix;
  serverSlug: string;
  onClose: () => void;
  /** Called after a successful save, to re-check the zone. */
  onApplied: () => void;
}) {
  const { toast } = useDialog();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [saving, setSaving] = useState(false);
  const { zone, suggested } = fix;

  useEffect(() => {
    let cancelled = false;
    void planSoaMnameFix(zone, serverSlug, suggested).then((plan) => {
      if (cancelled) return;
      if (plan.state === "error") setLoaded({ state: "error", message: plan.message });
      else if (plan.state === "unchanged")
        setLoaded({
          state: "error",
          message: `The SOA already names ${suggested}; re-check the zone to clear the finding.`,
        });
      else setLoaded(plan);
    });
    return () => {
      cancelled = true;
    };
  }, [zone, suggested, serverSlug]);

  async function save(after: SoaRRset): Promise<void> {
    setSaving(true);
    try {
      const result = await saveSoa(zone, serverSlug, after);
      if (!result.ok) {
        toast({ kind: "error", title: "Could not save SOA", description: result.error });
        return;
      }
      const notifySuffix = result.notifyError
        ? ` NOTIFY failed: ${result.notifyError}`
        : result.notified
          ? " Secondaries notified."
          : "";
      toast({
        kind: result.notifyError ? "warn" : "success",
        description: `SOA MNAME of ${zone} set to ${suggested}.${notifySuffix}`,
      });
      onApplied();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const diff = loaded.state === "ready" ? computeBindDiff([loaded.before], [loaded.after]) : null;

  return (
    <Dialog
      open
      onClose={() => (saving ? undefined : onClose())}
      title="Review changes"
      description={`Set the SOA MNAME of ${zone} to ${suggested}.`}
      dismissOnBackdrop={false}
      maxWidthClass="max-w-[96rem]"
    >
      <div className="mt-4 space-y-4">
        {loaded.state === "loading" ? (
          <p className="text-sm text-[color:var(--color-fg-muted)]" role="status">
            Reading the current SOA…
          </p>
        ) : loaded.state === "error" ? (
          <p className="text-sm text-[color:var(--color-error-fg)]" role="alert">
            {loaded.message}
          </p>
        ) : diff ? (
          <>
            <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
              <BareDiff removed={diff.removed} added={diff.added} />
            </div>
            <p className="text-xs text-[color:var(--color-fg-muted)]">
              Only the primary nameserver changes. PowerDNS raises the serial on save, and
              secondaries are notified as for any SOA edit.
            </p>
          </>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-dialog-focus="true"
            onClick={() => {
              if (loaded.state === "ready") void save(loaded.after);
            }}
            disabled={saving || loaded.state !== "ready"}
            className="rounded-md border border-transparent bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
