import Link from "next/link";

export type ZoneTabKey =
  | "records"
  | "soa"
  | "settings"
  | "dnssec"
  | "metadata"
  | "sync"
  | "statistics"
  | "history";

interface ZoneTabsProps {
  active: ZoneTabKey;
  zoneIdEncoded: string;
  serverSlug: string;
  canReadDnssec: boolean;
  canReadMetadata: boolean;
  canReadAudit: boolean;
}

export function ZoneTabs({
  active,
  zoneIdEncoded,
  serverSlug,
  canReadDnssec,
  canReadMetadata,
  canReadAudit,
}: ZoneTabsProps) {
  const qs = `server=${encodeURIComponent(serverSlug)}`;
  const detailHref = `/zones/${zoneIdEncoded}?${qs}`;
  const soaHref = `/zones/${zoneIdEncoded}?${qs}&tab=soa`;
  const settingsHref = `/zones/${zoneIdEncoded}?${qs}&tab=settings`;
  const historyHref = `/zones/${zoneIdEncoded}?${qs}&tab=history`;
  // DNSSEC + Metadata are now ?tab= switches on the same route too, so
  // every tab is an instant query-string change with no Next.js route
  // navigation + no shimmer fallback fired.
  const dnssecHref = `/zones/${zoneIdEncoded}?${qs}&tab=dnssec`;
  const metadataHref = `/zones/${zoneIdEncoded}?${qs}&tab=metadata`;
  const statisticsHref = `/zones/${zoneIdEncoded}?${qs}&tab=statistics`;
  const syncHref = `/zones/${zoneIdEncoded}?${qs}&tab=sync`;

  return (
    <div className="border-b border-[color:var(--color-border)]">
      <nav className="-mb-px flex gap-6 text-sm">
        <TabLink href={detailHref} active={active === "records"}>
          Records
        </TabLink>
        <TabLink href={soaHref} active={active === "soa"}>
          SOA
        </TabLink>
        <TabLink href={settingsHref} active={active === "settings"}>
          Zone settings
        </TabLink>
        {canReadDnssec ? (
          <TabLink href={dnssecHref} active={active === "dnssec"}>
            DNSSEC
          </TabLink>
        ) : null}
        {canReadMetadata ? (
          <TabLink href={metadataHref} active={active === "metadata"}>
            Metadata
          </TabLink>
        ) : null}
        <TabLink href={syncHref} active={active === "sync"}>
          Sync
        </TabLink>
        <TabLink href={statisticsHref} active={active === "statistics"}>
          Statistics
        </TabLink>
        {canReadAudit ? (
          <TabLink href={historyHref} active={active === "history"}>
            Change history
          </TabLink>
        ) : null}
      </nav>
    </div>
  );
}

function TabLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "border-b-2 border-[color:var(--color-accent)] px-1 pb-3 font-medium text-[color:var(--color-fg)]"
          : "border-b-2 border-transparent px-1 pb-3 text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
      }
    >
      {children}
    </Link>
  );
}
