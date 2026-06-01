import Link from "next/link";

export type ZoneTabKey =
  | "records"
  | "soa"
  | "settings"
  | "dnssec"
  | "metadata"
  | "sync"
  | "statistics"
  | "access"
  | "history";

interface ZoneTabsProps {
  active: ZoneTabKey;
  zoneIdEncoded: string;
  serverSlug: string;
  canReadDnssec: boolean;
  canReadMetadata: boolean;
  canReadAudit: boolean;
  /**
   * Gates the Access tab. The tab lists roles + teams + users that
   * can act on this zone - useful "who can touch this?" forensic
   * surface. Gated on `user.read` because the tab reveals user emails
   * and team membership.
   */
  canReadAccess: boolean;
  /**
   * Whether to render the Sync + Statistics tabs. Both depend on the
   * background poller (zone-state cache for Sync, metric_samples for
   * Statistics), so they hide when `PDNS_BACKGROUND_POLLING=false`.
   */
  showPollingFeatures: boolean;
}

export function ZoneTabs({
  active,
  zoneIdEncoded,
  serverSlug,
  canReadDnssec,
  canReadMetadata,
  canReadAudit,
  canReadAccess,
  showPollingFeatures,
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
  const accessHref = `/zones/${zoneIdEncoded}?${qs}&tab=access`;

  return (
    // Mobile (< sm): tabs wrap to multiple rows so the last one ("Change
    // history" - the widest label) never lives off-screen. From sm+ they
    // collapse back to a single horizontally-scrollable row, matching the
    // dense desktop layout.
    <div className="border-b border-[color:var(--color-border)] sm:overflow-x-auto">
      <nav className="-mb-px flex flex-wrap gap-x-6 gap-y-2 text-sm sm:w-max sm:flex-nowrap sm:gap-y-0 sm:whitespace-nowrap">
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
            Metadata &amp; TSIG
          </TabLink>
        ) : null}
        {showPollingFeatures ? (
          <>
            <TabLink href={syncHref} active={active === "sync"}>
              Sync
            </TabLink>
            <TabLink href={statisticsHref} active={active === "statistics"}>
              Statistics
            </TabLink>
          </>
        ) : null}
        {canReadAccess ? (
          <TabLink href={accessHref} active={active === "access"}>
            Access
          </TabLink>
        ) : null}
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
