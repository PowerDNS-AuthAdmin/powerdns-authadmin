"use client";

/**
 * components/domain/record-table.tsx
 *
 * Read-only view of a zone's RRsets. Used on the zone detail page when the
 * actor lacks every record.* permission. Built on the shared DataTable so
 * sort / filter / pagination behave identically to the editable variant.
 *
 * Default order is DNS hierarchy (apex SOA → NS → other apex types →
 * subdomains by reversed-label order). Users can override via column sort.
 */

import { useMemo } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/ui/data-table";
import {
  AddressPtrChip,
  OwnerPtrChip,
  lookupAddressLink,
  lookupOwnerLink,
  usePtrLinks,
} from "@/components/domain/ptr-links";
import { isReverseZone } from "@/lib/dns/zone-kind";

// UI-local shape of an RRset for display. Mirrors the relevant fields of
// `PdnsZoneDetail.rrsets[number]` from `lib/pdns/types`, redeclared here
// so this UI component doesn't cross the `components/ → lib/pdns`
// import-boundary rule. Server components map the protocol shape onto
// this one at the boundary.
interface RRset {
  name: string;
  type: string;
  ttl: number;
  records: Array<{ content: string; disabled?: boolean }>;
  /** Rrset-level comments (PDNS attaches them to the rrset, not per record). */
  comments?: Array<{ content?: string }>;
}

interface RecordTableProps {
  /** Canonical zone name including the trailing dot. */
  zoneName: string;
  rrsets: RRset[];
  /** Backend the zone is shown from; scopes the reverse-DNS cross-link lookup. */
  serverSlug: string;
  /** Show PTR / forward cross-link chips (the opt-in Reverse DNS checks). */
  reverseDnsLinks: boolean;
}

const ADDRESS_TYPES = new Set(["A", "AAAA"]);

export function RecordTable({ zoneName, rrsets, serverSlug, reverseDnsLinks }: RecordTableProps) {
  // SOA is intentionally hidden from the records table - operators see and
  // edit it through the SOA panel above instead.
  const nonSoa = useMemo(() => rrsets.filter((rr) => rr.type !== "SOA"), [rrsets]);
  const sorted = useMemo(() => sortRRsets(nonSoa, zoneName), [nonSoa, zoneName]);

  // Reverse-DNS cross-links: PTR state for A/AAAA rows on a forward zone, the
  // forward names for PTR rows on a reverse zone. Skipped when no row could
  // carry a chip so a zone of pure MX/TXT never triggers the fleet scan.
  const reverse = isReverseZone(zoneName);
  const hasLinkableRows = nonSoa.some((rr) =>
    reverse ? rr.type === "PTR" : ADDRESS_TYPES.has(rr.type),
  );
  const { data: ptrLinks } = usePtrLinks({
    zone: zoneName,
    serverSlug,
    enabled: reverseDnsLinks && hasLinkableRows,
  });

  const columns = useMemo<Array<ColumnDef<RRset, unknown>>>(
    () => [
      {
        id: "name",
        accessorFn: (row) => displayName(row.name, zoneName) || "@",
        header: "Name",
        cell: (ctx) => <span className="font-mono text-xs">{ctx.getValue<string>()}</span>,
        meta: { className: "w-[28%]" },
      },
      {
        accessorKey: "type",
        header: "Type",
        cell: (ctx) => <span className="text-xs font-medium">{ctx.getValue<string>()}</span>,
        meta: { className: "w-[8%]" },
      },
      {
        accessorKey: "ttl",
        header: "TTL",
        cell: (ctx) => <span className="font-mono text-xs">{ctx.getValue<number>()}</span>,
        meta: { className: "w-[10%]" },
      },
      {
        id: "content",
        accessorFn: (row) =>
          row.records.map((r) => `${r.disabled ? "!" : ""}${r.content}`).join(" "),
        header: "Content",
        enableSorting: false,
        cell: (ctx) => (
          <ul className="space-y-1 font-mono text-xs">
            {ctx.row.original.records.map((record, idx) => (
              <li
                key={idx}
                className={`break-all ${
                  record.disabled ? "text-[color:var(--color-fg-subtle)] line-through" : ""
                }`}
              >
                {record.content}
                {record.disabled ? (
                  <span className="ml-2 rounded bg-[color:var(--color-bg-muted)] px-1 py-0.5 text-[0.65rem] tracking-wide uppercase no-underline">
                    disabled
                  </span>
                ) : null}
                {!reverse && ADDRESS_TYPES.has(ctx.row.original.type) ? (
                  <AddressPtrChip
                    link={lookupAddressLink(ptrLinks, record.content)}
                    recordName={ctx.row.original.name}
                  />
                ) : null}
                {reverse && ctx.row.original.type === "PTR" && idx === 0 ? (
                  <OwnerPtrChip
                    link={lookupOwnerLink(ptrLinks, ctx.row.original.name)}
                    ownerName={ctx.row.original.name}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ),
        meta: { className: "w-[34%]" },
      },
      {
        id: "comment",
        accessorFn: (row) => joinComments(row.comments),
        header: "Comment",
        enableSorting: false,
        cell: (ctx) => {
          const text = joinComments(ctx.row.original.comments);
          return text ? (
            <span className="text-xs text-[color:var(--color-fg-muted)] italic">{text}</span>
          ) : (
            <span className="text-xs text-[color:var(--color-fg-subtle)]">-</span>
          );
        },
        meta: { className: "w-[20%]" },
      },
    ],
    [zoneName, reverse, ptrLinks],
  );

  return (
    <DataTable
      columns={columns}
      data={sorted}
      searchPlaceholder="Search records by name, type, content…"
      noDataMessage="No records on this zone."
      initialSort={[{ id: "name", desc: false }]}
      stateKey="records"
      filterParam="q"
      layout="fixed"
    />
  );
}

/** Join PDNS' rrset comments into a single display string. */
function joinComments(comments: ReadonlyArray<{ content?: string }> | undefined): string {
  if (!comments || comments.length === 0) return "";
  return comments
    .map((c) => c.content ?? "")
    .filter((s) => s.length > 0)
    .join(" · ");
}

/** Render the name as either "@" (apex) or the relative label. */
function displayName(name: string, zoneName: string): string {
  if (name === zoneName) return "";
  if (name.endsWith(`.${zoneName}`)) {
    return name.slice(0, name.length - zoneName.length - 1);
  }
  return name;
}

/** DNS-hierarchy sort: apex (SOA → NS → other) → subdomains by reversed labels. */
export function sortRRsets(rrsets: readonly RRset[], zoneName: string): RRset[] {
  return [...rrsets].sort((a, b) => {
    const nameCompare = compareDnsNames(a.name, b.name, zoneName);
    if (nameCompare !== 0) return nameCompare;
    return compareTypes(a.type, b.type);
  });
}

function compareDnsNames(left: string, right: string, zoneName: string): number {
  const leftIsApex = left === zoneName;
  const rightIsApex = right === zoneName;
  if (leftIsApex && !rightIsApex) return -1;
  if (rightIsApex && !leftIsApex) return 1;
  if (leftIsApex && rightIsApex) return 0;

  const leftLabels = reverseLabels(left);
  const rightLabels = reverseLabels(right);
  const len = Math.min(leftLabels.length, rightLabels.length);
  for (let i = 0; i < len; i++) {
    const cmp = leftLabels[i]!.localeCompare(rightLabels[i]!);
    if (cmp !== 0) return cmp;
  }
  return leftLabels.length - rightLabels.length;
}

function reverseLabels(name: string): string[] {
  const trimmed = name.endsWith(".") ? name.slice(0, -1) : name;
  return trimmed.split(".").reverse();
}

function compareTypes(left: string, right: string): number {
  const priority = (type: string): number => {
    if (type === "SOA") return 0;
    if (type === "NS") return 1;
    return 2;
  };
  const pa = priority(left);
  const pb = priority(right);
  if (pa !== pb) return pa - pb;
  return left.localeCompare(right);
}
