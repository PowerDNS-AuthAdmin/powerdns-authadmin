import { displayZoneName } from "@/lib/dns/zone-name";

/** Warns that zone-scoped mappings name zones no backend serves (they grant nothing yet). */
export function UnknownZoneTargetsNotice({ zones }: { zones: readonly string[] }) {
  if (zones.length === 0) return null;
  return (
    <p
      role="status"
      className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-3 text-xs text-[color:var(--color-warn-fg)]"
    >
      {zones.length === 1 ? "A group mapping targets a zone" : "Group mappings target zones"} that
      no backend serves: <span className="font-mono">{zones.map(displayZoneName).join(", ")}</span>.{" "}
      {zones.length === 1 ? "It grants" : "They grant"} nothing until the zone exists - check the
      spelling.
    </p>
  );
}
