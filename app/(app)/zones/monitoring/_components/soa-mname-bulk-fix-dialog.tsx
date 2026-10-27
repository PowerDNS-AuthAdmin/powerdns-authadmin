"use client";

/**
 * app/(app)/zones/monitoring/_components/soa-mname-bulk-fix-dialog.tsx
 *
 * "Fix all" for the SOA MNAME finding (#183): one review of every affected
 * zone's SOA before/after, then one Apply. Each zone is saved through the
 * same write route as the one-zone Fix (./soa-mname-fix.ts), so every save
 * gets the per-zone `soa.update` check, validation, audit row and NOTIFY of a
 * manual SOA edit. There is no bulk write path to keep in step.
 *
 * Zones the viewer may not change are listed up front and skipped; the route
 * still refuses them if the flag was stale. SOAs are read live when the
 * dialog opens, a few at a time, so the diff is what will really be
 * replaced. A zone whose SOA already names the suggested primary is left out.
 *
 * A `ScrollDialog`, like Reverse DNS's review: a fleet can bring hundreds of
 * zones, and Apply must stay reachable while the diff scrolls.
 */

import { useEffect, useMemo, useState } from "react";
import { BareDiff, computeBindDiff } from "@/app/(app)/zones/[zoneId]/_components/bare-diff";
import {
  partitionFixTargets,
  plural,
  resultKey,
  type FixTarget,
} from "@/components/domain/zone-monitor-format";
import { Checkbox } from "@/components/ui/checkbox";
import { useDialog } from "@/components/ui/dialog";
import { ScrollDialog } from "@/components/ui/scroll-dialog";
import { mapPool } from "@/lib/client/map-pool";
import { planSoaMnameFix, saveSoa, type SoaPlan } from "./soa-mname-fix";

/** SOA reads in flight while the review loads. */
const READ_CONCURRENCY = 4;
/** Saves in flight on Apply: each is a PowerDNS PATCH plus a NOTIFY. */
const SAVE_CONCURRENCY = 3;

type Outcome =
  | { state: "saved"; notifyError: string | null }
  | { state: "failed"; error: string; forbidden: boolean };

interface Item {
  target: FixTarget;
  key: string;
  plan: SoaPlan | null;
  outcome: Outcome | null;
}

type Phase = "reading" | "review" | "saving" | "done";

const BUTTON_CLASS =
  "rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50";
const PRIMARY_CLASS =
  "rounded-md border border-transparent bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95 disabled:opacity-50";

/** A state updater that changes one item, so callers need only the stable `setItems`. */
function patchItem(key: string, patch: Partial<Item>) {
  return (cur: Item[]): Item[] => cur.map((it) => (it.key === key ? { ...it, ...patch } : it));
}

function zoneLabel(t: FixTarget, multiBackend: boolean): string {
  return multiBackend ? `${t.result.zone} on ${t.result.server}` : t.result.zone;
}

export function SoaMnameBulkFixDialog({
  targets,
  onClose,
  onApplied,
}: {
  /** Every zone with the finding. The caller mounts the dialog only while it is open. */
  targets: readonly FixTarget[];
  onClose: () => void;
  /** Called once after Apply with the zones that were saved, to re-check them. */
  onApplied: (saved: FixTarget[]) => void;
}) {
  const { toast } = useDialog();
  // The targets are fixed for the dialog's lifetime: a realtime refresh of the
  // page behind it must not reshuffle a review the operator is reading.
  const [{ allowed, forbidden }] = useState(() => partitionFixTargets(targets));
  const multiBackend = useMemo(
    () => new Set(targets.map((t) => t.result.server)).size > 1,
    [targets],
  );
  const [items, setItems] = useState<Item[]>(() =>
    allowed.map((target) => ({ target, key: resultKey(target.result), plan: null, outcome: null })),
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhase] = useState<Phase>("reading");

  useEffect(() => {
    let cancelled = false;
    void mapPool(allowed, READ_CONCURRENCY, async (target) => {
      const plan = await planSoaMnameFix(
        target.result.zone,
        target.result.server,
        target.fix.suggested,
      );
      if (cancelled) return plan;
      const key = resultKey(target.result);
      setItems(patchItem(key, { plan }));
      if (plan.state === "ready") setSelected((cur) => new Set(cur).add(key));
      return plan;
    }).then(() => {
      if (!cancelled) setPhase("review");
    });
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  const read = items.filter((it) => it.plan !== null).length;
  const ready = items.filter((it) => it.plan?.state === "ready");
  const unchanged = items.filter((it) => it.plan?.state === "unchanged");
  const unreadable = items.filter((it) => it.plan?.state === "error");
  const chosen = ready.filter((it) => selected.has(it.key));
  const saved = items.filter((it) => it.outcome?.state === "saved");
  const failed = items.filter((it) => it.outcome?.state === "failed");
  const busy = phase === "saving";

  async function apply(): Promise<void> {
    setPhase("saving");
    const outcomes = await mapPool(chosen, SAVE_CONCURRENCY, async (it) => {
      if (it.plan?.state !== "ready") return null;
      const result = await saveSoa(it.target.result.zone, it.target.result.server, it.plan.after);
      const outcome: Outcome = result.ok
        ? { state: "saved", notifyError: result.notifyError }
        : { state: "failed", error: result.error, forbidden: result.forbidden };
      setItems(patchItem(it.key, { outcome }));
      return outcome;
    });
    setPhase("done");
    const savedTargets = chosen
      .filter((_, i) => outcomes[i]?.state === "saved")
      .map((it) => it.target);
    const failedCount = outcomes.filter((o) => o?.state === "failed").length;
    const notifyFailed = outcomes.filter((o) => o?.state === "saved" && o.notifyError).length;
    toast({
      kind: failedCount || notifyFailed ? "warn" : "success",
      title: `SOA MNAME fixed on ${plural(savedTargets.length, "zone")}`,
      description:
        [
          failedCount ? `${plural(failedCount, "zone")} failed; see the review for why.` : "",
          notifyFailed ? `NOTIFY failed for ${plural(notifyFailed, "zone")}.` : "",
        ]
          .filter(Boolean)
          .join(" ") || "The zones are being re-checked.",
    });
    if (savedTargets.length) onApplied(savedTargets);
  }

  const allChosen = ready.length > 0 && chosen.length === ready.length;
  const description =
    phase === "reading"
      ? `Reading the current SOA of ${plural(allowed.length, "zone")}… ${read} of ${allowed.length}.`
      : phase === "done"
        ? `${plural(saved.length, "zone")} saved${failed.length ? `, ${failed.length} failed` : ""}.`
        : `Set each zone's SOA MNAME to one of its own nameservers. ${plural(chosen.length, "zone")} selected.`;

  return (
    <ScrollDialog
      open
      onClose={() => (busy ? undefined : onClose())}
      title="Review changes"
      description={description}
      toolbar={
        phase === "review" && ready.length > 1 ? (
          <Checkbox
            checked={allChosen}
            onChange={(on) => setSelected(on ? new Set(ready.map((it) => it.key)) : new Set())}
            label={`Select all ${ready.length}`}
            className="text-sm"
          />
        ) : null
      }
      footer={
        <div className="flex flex-wrap items-center justify-end gap-3">
          {phase === "done" ? (
            <button
              type="button"
              data-dialog-focus="true"
              onClick={onClose}
              className={PRIMARY_CLASS}
            >
              Close
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose} disabled={busy} className={BUTTON_CLASS}>
                Cancel
              </button>
              <button
                type="button"
                data-dialog-focus="true"
                onClick={() => void apply()}
                disabled={phase !== "review" || chosen.length === 0}
                className={PRIMARY_CLASS}
              >
                {busy
                  ? `Saving… ${saved.length + failed.length} of ${chosen.length}`
                  : `Apply to ${plural(chosen.length, "zone")}`}
              </button>
            </>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {forbidden.length ? (
          <SkippedList
            title={`${plural(forbidden.length, "zone")} skipped: you can't change their SOA`}
            names={forbidden.map((t) => zoneLabel(t, multiBackend))}
          />
        ) : null}
        {unchanged.length ? (
          <SkippedList
            title={`${plural(unchanged.length, "zone")} already fixed since the last check`}
            names={unchanged.map((it) => zoneLabel(it.target, multiBackend))}
          />
        ) : null}
        {unreadable.length ? (
          <SkippedList
            title={`${plural(unreadable.length, "zone")} could not be read`}
            names={unreadable.map(
              (it) =>
                `${zoneLabel(it.target, multiBackend)}: ${it.plan?.state === "error" ? it.plan.message : ""}`,
            )}
          />
        ) : null}
        {allowed.length === 0 ? (
          <p className="text-sm text-[color:var(--color-fg-muted)]">
            There is nothing here you can change.
          </p>
        ) : null}
        {ready.map((it) => (
          <ZoneDiff
            key={it.key}
            item={it}
            label={zoneLabel(it.target, multiBackend)}
            checked={selected.has(it.key)}
            locked={phase !== "review"}
            onToggle={(on) =>
              setSelected((cur) => {
                const next = new Set(cur);
                if (on) next.add(it.key);
                else next.delete(it.key);
                return next;
              })
            }
          />
        ))}
      </div>
    </ScrollDialog>
  );
}

function ZoneDiff({
  item,
  label,
  checked,
  locked,
  onToggle,
}: {
  item: Item;
  label: string;
  checked: boolean;
  locked: boolean;
  onToggle: (on: boolean) => void;
}) {
  const diff = useMemo(
    () =>
      item.plan?.state === "ready" ? computeBindDiff([item.plan.before], [item.plan.after]) : null,
    [item.plan],
  );
  if (!diff) return null;
  const { outcome } = item;
  return (
    <section aria-label={`Changes in ${label}`}>
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <Checkbox
          checked={checked}
          onChange={onToggle}
          disabled={locked}
          ariaLabel={`Include ${label}`}
          label={<span className="font-mono font-semibold">{label}</span>}
        />
        {outcome?.state === "saved" ? (
          <span className="text-[color:var(--color-success-fg)]">
            Saved{outcome.notifyError ? `; NOTIFY failed: ${outcome.notifyError}` : ""}
          </span>
        ) : outcome?.state === "failed" ? (
          <span className="text-[color:var(--color-error-fg)]" role="alert">
            Not saved: {outcome.error}
          </span>
        ) : null}
      </div>
      <div className="overflow-hidden rounded-md border border-[color:var(--color-border)]">
        <BareDiff removed={diff.removed} added={diff.added} />
      </div>
    </section>
  );
}

function SkippedList({ title, names }: { title: string; names: string[] }) {
  return (
    <details className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium">{title}</summary>
      <ul className="mt-2 space-y-0.5 font-mono break-all text-[color:var(--color-fg-muted)]">
        {names.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </details>
  );
}
