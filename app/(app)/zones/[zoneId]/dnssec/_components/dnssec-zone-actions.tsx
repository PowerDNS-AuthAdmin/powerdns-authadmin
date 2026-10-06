"use client";

/**
 * app/(app)/zones/[zoneId]/dnssec/_components/dnssec-zone-actions.tsx
 *
 * Zone-level DNSSEC buttons: Enable (unsigned zone), Rectify and Disable
 * (signed zone). Thin client over `POST|DELETE .../dnssec` and
 * `PUT .../rectify`; the routes own the decisions.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDialog } from "@/components/ui/dialog";
import { mutate } from "@/lib/client/api-fetch";

interface Props {
  zoneIdEncoded: string;
  zoneName: string;
  serverSlug: string;
  signed: boolean;
  /** Zone reaches secondaries (managed mirrors, or a Master/Primary kind). */
  replicated: boolean;
  /** Current SOA-EDIT ("" when unset). */
  soaEdit: string;
}

interface EnableResponse {
  warnings?: string[];
  ds?: string[];
  notified?: boolean;
}

export function DnssecZoneActions(props: Props) {
  const router = useRouter();
  const { confirm, prompt, toast } = useDialog();
  const [busy, setBusy] = useState<"enable" | "rectify" | "disable" | null>(null);
  const base = `/api/admin/pdns/zones/${props.zoneIdEncoded}`;

  async function handleEnable() {
    const setsSoaEdit = props.replicated && props.soaEdit === "";
    const ok = await confirm({
      title: `Sign ${props.zoneName}?`,
      description: (
        <>
          PowerDNS generates its default key (a single ECDSA P-256 CSK on 4.9), rectifies the zone
          and signs it on the fly.
          {setsSoaEdit
            ? " SOA-EDIT is set to INCREMENT-WEEKS so presigned secondaries re-transfer fresh signatures every week."
            : ""}
          {props.replicated ? " The secondaries are then NOTIFYed." : ""}
          <br />
          <br />
          Nothing changes for validating resolvers until you publish the DS at the registrar - check
          the zone validates on every nameserver first.
        </>
      ),
      confirmLabel: "Enable DNSSEC",
    });
    if (!ok) return;
    setBusy("enable");
    try {
      const result = await mutate<EnableResponse>(`${base}/dnssec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverSlug: props.serverSlug }),
      });
      if (!result.ok) {
        toast({ kind: "error", title: "Enable failed", description: result.error });
        return;
      }
      const warnings = result.data.warnings ?? [];
      toast({
        kind: warnings.length > 0 ? "warn" : "success",
        title: "DNSSEC enabled",
        description:
          warnings.length > 0
            ? warnings.join(" ")
            : "Zone signed. Publish the DS below at the registrar once it validates on every nameserver.",
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function handleRectify() {
    const ok = await confirm({
      title: `Rectify ${props.zoneName}?`,
      description: props.replicated
        ? "Recomputes the NSEC/NSEC3 ordering and auth flags, then bumps the serial and NOTIFYs so presigned secondaries pick up the corrected chain. Safe to repeat."
        : "Recomputes the NSEC/NSEC3 ordering and auth flags. Safe to repeat.",
      confirmLabel: "Rectify",
    });
    if (!ok) return;
    setBusy("rectify");
    try {
      const result = await mutate(`${base}/rectify`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverSlug: props.serverSlug }),
      });
      if (!result.ok) {
        toast({ kind: "error", title: "Rectify failed", description: result.error });
        return;
      }
      toast({ kind: "success", description: "Zone rectified." });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function handleDisable() {
    const typed = await prompt({
      title: `Disable DNSSEC for ${props.zoneName}?`,
      description:
        "Removes every key and serves the zone unsigned. If a DS record for this zone is still published at the registrar, validating resolvers will fail the WHOLE zone (SERVFAIL). Remove the DS at the registrar first and wait at least its TTL (often 1-2 days) before disabling. Type the zone name to confirm.",
      label: "Zone name",
      placeholder: props.zoneName,
      confirmLabel: "Disable DNSSEC",
      dismissOnBackdrop: false,
      validate: (v) =>
        norm(v) === norm(props.zoneName) ? null : `Type ${props.zoneName} to confirm.`,
    });
    if (!typed) return;
    setBusy("disable");
    try {
      const url = new URL(`${base}/dnssec`, window.location.origin);
      url.searchParams.set("serverSlug", props.serverSlug);
      url.searchParams.set("confirm", props.zoneName);
      const result = await mutate(url.pathname + url.search, { method: "DELETE" });
      if (!result.ok) {
        toast({ kind: "error", title: "Disable failed", description: result.error });
        return;
      }
      toast({ kind: "success", description: "DNSSEC disabled; the zone is now unsigned." });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const buttonBase =
    "rounded px-3 py-1.5 text-xs font-medium disabled:opacity-50 border border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-muted)]";

  return (
    <div className="flex flex-wrap gap-2">
      {props.signed ? (
        <>
          <button
            type="button"
            onClick={handleRectify}
            disabled={busy !== null}
            className={buttonBase}
          >
            {busy === "rectify" ? "Rectifying…" : "Rectify zone"}
          </button>
          <button
            type="button"
            onClick={handleDisable}
            disabled={busy !== null}
            className="rounded border border-[color:var(--color-error)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-error)] hover:bg-[color:var(--color-error)]/10 disabled:opacity-50"
          >
            {busy === "disable" ? "Disabling…" : "Disable DNSSEC"}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={handleEnable}
          disabled={busy !== null}
          className="rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          {busy === "enable" ? "Enabling…" : "Enable DNSSEC"}
        </button>
      )}
    </div>
  );
}

function norm(name: string): string {
  return name.trim().replace(/\.$/, "").toLowerCase();
}
