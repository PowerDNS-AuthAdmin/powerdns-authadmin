"use client";

/**
 * app/(app)/zones/new-record/_components/propagation-step.tsx
 *
 * After the save: where each copy of the zone stands, from
 * `GET /api/admin/pdns/zones/<zone>/sync`. A standalone primary has nothing
 * to wait for, so the wizard goes straight to the done screen; a primary with
 * secondaries or a cluster shows every member and polls until the backend
 * says `settled`. Realtime `zone.updated` / `zone.sync.changed` events for
 * this zone trigger an immediate re-check so the operator does not wait a
 * full poll interval for a NOTIFY that already landed.
 *
 * Finish unlocks only once settled. Skip is the way out before that, behind a
 * confirmation that says plainly the record has not reached every member.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { SyncIndicator } from "@/components/ui/sync-indicator";
import { useDialog } from "@/components/ui/dialog";
import { useRealtimeAvailable, useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { syncMemberAppearance } from "@/components/domain/record-wizard-format";
import { displayZoneName } from "@/lib/dns/zone-name";

const POLL_INTERVAL_MS = 3000;

export interface ZoneSyncSnapshot {
  zone: string;
  server: string;
  topology: "standalone" | "primary-secondaries" | "cluster";
  members: Array<{
    slug: string;
    name: string;
    role: "primary" | "peer" | "secondary";
    state: string;
    serial: number | null;
    expectedSerial: number | null;
  }>;
  settled: boolean;
  checkedAt: string;
}

const ROLE_LABEL: Record<ZoneSyncSnapshot["members"][number]["role"], string> = {
  primary: "primary",
  peer: "cluster peer",
  secondary: "secondary",
};

export function PropagationStep({
  zoneName,
  serverSlug,
  onFinish,
}: {
  zoneName: string;
  serverSlug: string;
  /** Called when the operator finishes or skips; the wizard shows the done screen. */
  onFinish: () => void;
}) {
  const { confirm } = useDialog();
  const [snapshot, setSnapshot] = useState<ZoneSyncSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settled = snapshot?.settled === true;
  // One in-flight check at a time: a realtime burst must not fan out into a
  // request per event.
  const inFlight = useRef(false);

  const check = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const params = new URLSearchParams({ serverSlug });
      const response = await fetch(
        `/api/admin/pdns/zones/${encodeURIComponent(zoneName)}/sync?${params.toString()}`,
      );
      const body = (await response.json().catch(() => null)) as
        | ZoneSyncSnapshot
        | { error?: string }
        | null;
      if (!response.ok || !body || !("members" in body)) {
        setError(
          body && "error" in body && typeof body.error === "string"
            ? body.error
            : "Could not read the zone's replication state.",
        );
        return;
      }
      setSnapshot(body);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      inFlight.current = false;
    }
  }, [zoneName, serverSlug]);

  // Standalone: nothing replicates, so there is nothing to show. Hand off as
  // soon as the first answer says so.
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  useEffect(() => {
    if (snapshot?.topology === "standalone") onFinishRef.current();
  }, [snapshot?.topology]);

  useEffect(() => {
    void check();
    if (settled) return;
    const timer = setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [check, settled]);

  const realtime = useRealtimeAvailable();
  useRealtimeEvent(
    (event) =>
      realtime &&
      (event.type === "realtime.reconnected" ||
        ((event.type === "zone.updated" || event.type === "zone.sync.changed") &&
          event["zone"] === zoneName)),
    () => void check(),
  );

  async function skip() {
    const leave = await confirm({
      title: "Leave before propagation completes?",
      description: "Your record has not yet propagated to all cluster members.",
      confirmLabel: "Skip",
      cancelLabel: "Keep waiting",
    });
    if (leave) onFinish();
  }

  const members = snapshot?.members ?? [];
  const behind = members.filter((m) => !syncMemberAppearance(m.state).settled).length;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">Propagation</h2>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]" aria-live="polite">
          {snapshot === null
            ? `Checking where ${displayZoneName(zoneName)} stands on each backend…`
            : settled
              ? `Every copy of ${displayZoneName(zoneName)} serves the new serial.`
              : `${behind} of ${members.length} ${members.length === 1 ? "copy" : "copies"} still catching up. This page re-checks every ${POLL_INTERVAL_MS / 1000} seconds.`}
        </p>
      </div>

      {error ? (
        <p className="text-sm text-[color:var(--color-error-fg)]" role="alert">
          {error}
        </p>
      ) : null}

      {members.length > 0 ? (
        <ul className="divide-y divide-[color:var(--color-border)] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)]">
          {members.map((member) => {
            const look = syncMemberAppearance(member.state);
            const textClass =
              look.tone === "success"
                ? "text-[color:var(--color-success-fg)]"
                : look.tone === "warn"
                  ? "text-[color:var(--color-warn-fg)]"
                  : "text-[color:var(--color-error-fg)]";
            return (
              <li
                key={member.slug}
                className="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="flex items-center gap-2">
                  <SyncIndicator state={look.indicator} tone={look.tone} size={16} />
                  <span className="font-medium">{member.name}</span>
                  <span className="text-xs text-[color:var(--color-fg-muted)]">
                    {ROLE_LABEL[member.role]}
                  </span>
                </span>
                <span className={`text-xs tabular-nums ${textClass}`}>
                  {look.label}
                  {member.serial !== null ? ` · serial ${member.serial}` : ""}
                  {!look.settled && member.expectedSerial !== null
                    ? ` (expects ${member.expectedSerial})`
                    : ""}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={onFinish}
          disabled={!settled}
          className="rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50"
        >
          Finish
        </button>
        <button
          type="button"
          onClick={() => void skip()}
          disabled={settled}
          className="rounded-md border border-[color:var(--color-border)] px-4 py-2 text-sm hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
