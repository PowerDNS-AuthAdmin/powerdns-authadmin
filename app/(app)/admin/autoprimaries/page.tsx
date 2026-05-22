/**
 * app/(app)/admin/autoprimaries/page.tsx
 *
 * Per-backend list of trusted upstream primaries from which this PDNS
 * server will auto-create slave zones via incoming NOTIFY.
 *
 * Permission: `autoprimary.manage` (read AND mutate gated under the
 * same permission — autoprimaries are connection config, not
 * something operators with read-only access need to inspect).
 *
 * Backend selection: `?server=<slug>` to inspect a non-default
 * backend (matches /admin/tsig-keys and /admin/servers).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import {
  findDefaultPdnsServer,
  findPdnsServerBySlug,
  listAllPdnsServers,
} from "@/lib/db/repositories/pdns-servers";
import { getPdnsClientForRow } from "@/lib/pdns/registry";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";
import { AutoprimaryActions } from "./_components/autoprimary-actions";

export const metadata: Metadata = { title: "Autoprimaries" };

interface PageProps {
  searchParams: Promise<{ server?: string }>;
}

export default async function AutoprimariesPage({ searchParams }: PageProps) {
  await requireUserForPage({ can: "autoprimary.manage" });
  const { server: requestedSlug } = await searchParams;

  const selected = requestedSlug
    ? await findPdnsServerBySlug(requestedSlug)
    : await findDefaultPdnsServer();
  const servers = await listAllPdnsServers();

  if (selected?.disabledAt !== null) {
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Autoprimaries</h1>
        </header>
        <div className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-6 text-sm">
          <strong>No backend selected.</strong> Add a server under{" "}
          <Link href="/admin/servers" className="underline">
            /admin/servers
          </Link>{" "}
          first.
        </div>
      </div>
    );
  }

  let rows: Awaited<ReturnType<typeof loadRows>> | null = null;
  let fetchError: string | null = null;
  try {
    rows = await loadRows(selected);
  } catch (err) {
    fetchError = err instanceof Error ? redact(err.message) : "Unknown error";
    logger.warn({ server: selected.slug, err: fetchError }, "admin.autoprimaries.list.failed");
  }

  const sorted = rows
    ? [...rows].sort((a, b) => `${a.ip}|${a.nameserver}`.localeCompare(`${b.ip}|${b.nameserver}`))
    : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Autoprimaries</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Primaries this PDNS server trusts to trigger automatic slave-zone creation via NOTIFY.
          Keyed on the (IP, nameserver) pair.
        </p>
      </header>

      {servers.length > 1 ? (
        <nav className="flex flex-wrap gap-2 text-xs">
          {servers
            .filter((s) => s.disabledAt === null)
            .map((s) => (
              <Link
                key={s.id}
                href={`/admin/autoprimaries?server=${encodeURIComponent(s.slug)}`}
                className={
                  s.slug === selected.slug
                    ? "rounded border border-[color:var(--color-accent)] bg-[color:var(--color-accent)] px-2 py-1 text-[color:var(--color-accent-fg)]"
                    : "rounded border border-[color:var(--color-border)] px-2 py-1 hover:bg-[color:var(--color-bg-muted)]"
                }
              >
                {s.name}
              </Link>
            ))}
        </nav>
      ) : null}

      {fetchError ? (
        <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-4 text-sm">
          <strong>Could not list autoprimaries.</strong>
          <p className="mt-1 text-xs">{fetchError}</p>
        </div>
      ) : null}

      {sorted?.length === 0 ? (
        <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-5 text-sm">
          No autoprimaries configured. Incoming NOTIFYs that don't match an existing zone are
          ignored.
        </div>
      ) : null}

      <AutoprimaryActions serverSlug={selected.slug} rows={sorted ?? []} />
    </div>
  );
}

async function loadRows(selected: Awaited<ReturnType<typeof findDefaultPdnsServer>> & object) {
  const client = getPdnsClientForRow(selected);
  return client.listAutoprimaries();
}
