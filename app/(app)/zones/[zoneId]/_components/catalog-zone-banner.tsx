import Link from "next/link";
import { BookMarked } from "lucide-react";
import { displayZoneName } from "@/lib/dns/zone-name";

interface Props {
  role: "producer" | "consumer";
  /**
   * Canonical names of the zones on this backend that name this catalog; null
   * when the backend's zone list doesn't report membership (PowerDNS 4.7 / 4.8).
   */
  members: readonly string[] | null;
  /** Where the member links point: the backend the page is reading. */
  serverSlug: string;
  /** For a consumer: the catalog's primary, as the zone's masters list. */
  primaries: readonly string[];
}

/**
 * Explains a catalog zone (RFC 9432) at the top of its page and lists its
 * members. Catalog zones look like stray test zones (`catalog.invalid.`), and
 * deleting one quietly stops secondaries from tracking zone additions and
 * removals (#209), so the page says what it is before anything else.
 */
export function CatalogZoneBanner({ role, members, serverSlug, primaries }: Props) {
  const count =
    members === null ? null : `${members.length} member zone${members.length === 1 ? "" : "s"}`;
  return (
    <section
      aria-label="Catalog zone"
      className="space-y-3 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/5 p-4 text-sm"
    >
      <div className="flex items-start gap-2">
        <BookMarked
          aria-hidden
          className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-accent)]"
        />
        {role === "producer" ? (
          <p>
            <strong>Catalog zone (producer).</strong> PowerDNS generates this zone&apos;s contents
            from the zones that name it as their catalog{count ? <>: {count}</> : null}. Secondaries
            read it to learn which zones to serve. Don&apos;t edit or delete it unless you are
            retiring catalog-based provisioning on this server.
          </p>
        ) : (
          <p>
            <strong>Catalog zone (consumer).</strong> Zones listed in this catalog are created and
            deleted on this server automatically{count ? <>: {count} so far</> : null}.
            {primaries.length > 0 ? <> Its primary is {primaries.join(", ")}.</> : null} Deleting it
            stops this server from following zone additions and removals.
          </p>
        )}
      </div>
      {members === null ? (
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          This PowerDNS version doesn&apos;t list a catalog&apos;s members (4.9 and later do). A
          zone&apos;s own page shows the catalog it belongs to.
        </p>
      ) : members.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs font-medium text-[color:var(--color-fg-muted)]">
            Members ({members.length})
          </summary>
          <ul className="mt-2 grid gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-2 lg:grid-cols-3">
            {members.map((name) => (
              <li key={name} className="truncate">
                <Link
                  href={`/zones/${encodeURIComponent(name)}?server=${encodeURIComponent(serverSlug)}`}
                  prefetch={false}
                  className="text-[color:var(--color-accent)] hover:underline"
                >
                  {displayZoneName(name)}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
